import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay } from "./_bulk-utils.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * COPAO — Colegio Oficial de Psicología de Andalucía Oriental.
 *
 * Public member directory at copao.com/index.php/ventanilla/directorio-profesional.
 * ~601 licensed psychologists (Ejercientes only) as of 2026-06-24, covering
 * the provinces of Almería, Granada, Jaén and Málaga.
 *
 * Mapped to Prolio `psicologia` category, country ES.
 *
 * robots.txt (2026-06-24): Only /administrator/, /api/, /bin/, /cache/,
 * /cli/, /components/, /includes/, /installation/, /language/, /layouts/,
 * /libraries/, /logs/, /modules/, /plugins/, /tmp/ are disallowed. The
 * public directory path /index.php/ventanilla/directorio-profesional is
 * explicitly allowed.
 *
 * Pagination: ?start=N&limit=100 (100 entries per page, 7 pages total).
 * No CAPTCHA, no auth, no JS-only rendering — server-rendered Joomla HTML.
 *
 * Data fields per entry: member code (e.g. AO12610), full name, province,
 * phone. Some entries include titulación experta, modality, and location.
 *
 * Pre-flight checks (2026-06-24):
 *   - robots.txt: https://www.copao.com/robots.txt → no ?-param block
 *   - Test page:  https://www.copao.com/index.php/ventanilla/directorio-profesional → HTTP 200
 *   - Total: ~601 records (6 full pages × 100 + 1 on page 7)
 *   - No Cloudflare wall, no CAPTCHA
 *
 * Off by default. Toggle with PROLIO_RUN_COPAO_PSICOLOGIA_ES=true.
 * Cap with PROLIO_COPAO_PSICOLOGIA_ES_LIMIT (default 2000).
 */

const BASE_URL =
  process.env.PROLIO_COPAO_BASE_URL ??
  "https://www.copao.com/index.php/ventanilla/directorio-profesional";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 1_500;
const DEFAULT_LIMIT = 2_000;
const PAGE_SIZE = 100;
const SOURCE_NAME = "copao-psicologia-es" as ScrapeSource;

// Province → citySlug map for the COPAO coverage area.
const PROVINCE_CITY_MAP: Record<string, string> = {
  almería: "almeria",
  almeria: "almeria",
  granada: "granada",
  jaén: "jaen",
  jaen: "jaen",
  málaga: "malaga",
  malaga: "malaga",
};

function resolveCity(province: string | undefined): string {
  if (!province) return "granada"; // COPAO HQ is in Granada
  const key = province.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return PROVINCE_CITY_MAP[key] ?? PROVINCE_CITY_MAP[province.toLowerCase()] ?? "granada";
}

interface CopaoRow {
  code: string;
  name: string;
  province: string;
  phone?: string;
  location?: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}

/**
 * Parse the HTML of a directory page into CopaoRow objects.
 *
 * The page renders a flat list of professionals. Each entry contains:
 *   - An <a href="/index.php/ventanilla/directorio-profesional/AOXXXX"> with the full name
 *   - "Código de colegiado: AOXXXX" plain text
 *   - "Provincia: <province>" plain text
 *   - "DP Teléfono: +34 XXXXXXXXX" plain text (optional)
 *   - Location string like "Almería, Almería, Spain" (optional)
 *
 * Strategy: split the stripped text around the repeating "Código de colegiado:"
 * anchors to extract each entry block, then parse fields within each block.
 */
function parseRows(html: string): CopaoRow[] {
  const out: CopaoRow[] = [];
  const seen = new Set<string>();

  // Extract the main content (strip header/nav/footer noise)
  // Focus on the container that lists professionals
  const mainMatch = html.match(/directorio-profesional[\s\S]{0,200}?(<ul[\s\S]*?<\/ul>)/i)
    ?? html.match(/(<ul[\s\S]*?<\/ul>)/i);
  const listHtml = mainMatch ? mainMatch[1] : html;

  // Split by member code pattern — each entry starts with the code's <a href>
  // Pattern: href="/index.php/ventanilla/directorio-profesional/aoXXXXX"
  const hrefRe = /href="[^"]*?\/directorio-profesional\/([a-z]{2}\d{3,6})"[^>]*>([^<]+)<\/a>/gi;
  const codeTextRe = /Código de colegiado:\s*([A-Z]{2}\d{3,6})/gi;
  const provinceRe = /Provincia:\s*([^\n<]+)/gi;
  const phoneRe = /DP Teléfono:\s*([+\d\s]{9,20})/gi;

  // Collect all href-based entries (primary method)
  const nameMap = new Map<string, string>(); // code -> name
  let m: RegExpExecArray | null;

  hrefRe.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((m = hrefRe.exec(html)) !== null) {
    const code = m[1].toUpperCase();
    const rawName = m[2].trim();
    if (rawName && rawName.length > 2) {
      nameMap.set(code, rawName);
    }
  }

  // Now find code blocks and enrich with province/phone
  // Split around "Código de colegiado:" occurrences
  const blocks = html.split(/(?=Código de colegiado:)/i);

  for (const block of blocks) {
    codeTextRe.lastIndex = 0;
    const codeMatch = codeTextRe.exec(block);
    if (!codeMatch) continue;

    const code = codeMatch[1].trim().toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);

    const name = nameMap.get(code) ?? extractNameFromBlock(block, code);
    if (!name || name.length < 4) continue;

    provinceRe.lastIndex = 0;
    const provinciaMatch = provinceRe.exec(block);
    const province = provinciaMatch ? provinciaMatch[1].trim() : "";

    phoneRe.lastIndex = 0;
    const phoneMatch = phoneRe.exec(block);
    const phone = phoneMatch ? phoneMatch[1].trim() : undefined;

    // Try to extract location (city, province, country string)
    const locMatch = block.match(/([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+(?:\s+[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+)*),\s*([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+)/);
    const location = locMatch ? `${locMatch[1]}, ${locMatch[2]}` : undefined;

    out.push({ code, name, province, phone, location });
  }

  return out;
}

/**
 * Fallback name extraction from a block of text around the code.
 * Looks for ALL-CAPS sequences near the code.
 */
function extractNameFromBlock(block: string, code: string): string {
  const clean = stripHtml(block);
  // Look for the href pattern: .../AOXXXX">NAME</a> in a nearby region
  const linkRe = new RegExp(
    `/${code.toLowerCase()}"[^>]*>\\s*([A-ZÁÉÍÓÚÜÑ][A-Za-záéíóúüñ\\s,\\.'-]{3,})`,
    "i",
  );
  const lm = linkRe.exec(block);
  if (lm) return lm[1].replace(/\s+/g, " ").trim();

  // Try ALL_CAPS name pattern
  const capsRe = /([A-ZÁÉÍÓÚÜÑ]{2}[A-ZÁÉÍÓÚÜÑa-záéíóúüñ\s,'-]{3,})/g;
  let capsMatch: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((capsMatch = capsRe.exec(clean)) !== null) {
    const candidate = capsMatch[1].replace(/\s+/g, " ").trim();
    if (candidate.length > 5 && candidate !== code && !candidate.includes("Código")) {
      return candidate;
    }
  }
  return "";
}

async function fetchPage(start: number): Promise<{ html: string; ok: boolean }> {
  const url = new URL(BASE_URL);
  url.searchParams.set("start", String(start));
  url.searchParams.set("limit", String(PAGE_SIZE));

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "es-ES,es;q=0.9",
        Referer: BASE_URL,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.error(
      `[copao-psicologia-es] start=${start} network error: ${(e as Error).message}`,
    );
    return { html: "", ok: false };
  }

  if (!response.ok) {
    console.error(`[copao-psicologia-es] start=${start} → HTTP ${response.status}`);
    return { html: "", ok: false };
  }

  return { html: await response.text(), ok: true };
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seenCodes = new Set<string>();

  let consecutiveEmpty = 0;

  for (let start = 0; out.length < limit; start += PAGE_SIZE) {
    const { html, ok } = await fetchPage(start);
    if (!ok) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= 3) break;
      await delay(REQUEST_DELAY_MS * 2);
      continue;
    }

    const rows = parseRows(html);

    if (rows.length === 0) {
      consecutiveEmpty += 1;
      console.log(
        `[copao-psicologia-es] start=${start} → 0 rows (empty=${consecutiveEmpty})`,
      );
      if (consecutiveEmpty >= 3) break;
      await delay(REQUEST_DELAY_MS);
      continue;
    }
    consecutiveEmpty = 0;

    let added = 0;
    for (const row of rows) {
      if (seenCodes.has(row.code)) continue;
      seenCodes.add(row.code);

      const citySlug = resolveCity(row.province);
      const nameParts = row.name.split(",").map((p) => p.trim());
      // Format: "APELLIDOS, NOMBRE" or just "NOMBRE APELLIDOS"
      const formattedName =
        nameParts.length >= 2
          ? `${nameParts[1]} ${nameParts[0]}`
          : row.name;

      out.push(
        normalise({
          source: SOURCE_NAME,
          country: "ES",
          sourceId: `copao:${row.code}`,
          name: formattedName,
          categoryKey: "psicologia",
          citySlug,
          phone: row.phone,
          address: row.location,
          licenseNumber: row.code,
          metadata: {
            country: "ES",
            authority: "COPAO — Colegio Oficial de Psicología de Andalucía Oriental",
            colegio: "COPAO",
            comunidad: "Andalucía",
            provincia: row.province || undefined,
            verified_by_authority: true,
          },
        }),
      );
      added += 1;
      if (out.length >= limit) break;
    }

    console.log(
      `[copao-psicologia-es] start=${start} rows=${rows.length} added=${added} total=${out.length}`,
    );

    // If we got fewer than PAGE_SIZE, we've reached the last page
    if (rows.length < PAGE_SIZE) {
      console.log(
        `[copao-psicologia-es] last page reached (${rows.length} < ${PAGE_SIZE})`,
      );
      break;
    }

    if (out.length < limit) await delay(REQUEST_DELAY_MS);
  }

  return out;
}

// --- Source exports --------------------------------------------------------

export const copAoPsicologiaEsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_COPAO_PSICOLOGIA_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCopAoPsicologiaEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!copAoPsicologiaEsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  return withScrapeRun("copao-psicologia-es", async () => {
    const rawLimit = Number(
      process.env.PROLIO_COPAO_PSICOLOGIA_ES_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

    const records = await fetchAll(limit);
    if (records.length === 0) {
      console.warn(
        "[copao-psicologia-es] no records — page structure may have changed",
      );
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    }

    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    console.log(
      `[copao-psicologia-es] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
    return {
      rowsFetched: records.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
    };
  }).then((r) => ({
    fetched: r?.rowsFetched ?? 0,
    inserted: 0,
    updated: 0,
    skipped: r?.rowsSkipped ?? 0,
  }));
}
