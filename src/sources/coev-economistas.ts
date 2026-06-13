import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay } from "./_bulk-utils.js";

/**
 * COEV — Colegio Oficial de Economistas de Valencia.
 *
 * Public member directory at coev.com/colegiados. 4,120 licensed
 * economists as of 2026-06-13. Members provide tax advisory, financial
 * consulting, and fiscal services — mapped to Prolio `fiscal` category.
 *
 * robots.txt: Disallow: (empty) → all paths allowed.
 *
 * Pagination: zero-indexed GET param `?page=N` (25 entries per page,
 * ~165 pages for the full corpus). Page 0 == first page.
 *
 * Row format: "NNNN Apellido1 Apellido2, Nombre" as rendered text.
 * Each entry includes an expand icon; the expanded view shows only
 * "Sin datos" for most members, so we capture number + name only.
 *
 * Off by default. Toggle with PROLIO_RUN_COEV_ECONOMISTAS=true.
 * Cap with PROLIO_COEV_ECONOMISTAS_LIMIT (default 5000).
 *
 * Pre-flight checks (2026-06-13):
 *   - robots.txt: https://www.coev.com/robots.txt → Disallow: (none)
 *   - Test page:  https://www.coev.com/colegiados → HTTP 200, 4120 total
 *   - Pagination: ?page=1 returns next 25 entries (zero-indexed)
 *   - No captcha, no auth, no JS-only rendering
 *   - Page size: 25 entries
 *   - Total entries: 4,120 (well above 500-record threshold)
 */

const BASE = "https://www.coev.com";
const LISTADO_PATH = "/colegiados";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 1000;
const DEFAULT_LIMIT = 5000;
const PAGE_SIZE = 25;

// Match entries like:
//   "1624 Abad Alvaro, Alfredo"
//   "2621 Abad Cervera, Pedro Luis"
// The number is the colegiado number; name is "Apellidos, Nombre" format.
// We accept any line starting with 3-5 digits followed by a space and
// at least 3 name characters. Captures: [1]=number, [2]=full name text.
const ENTRY_RE = /\b(\d{3,5})\s+([A-ZÁÉÍÓÚÜÑ][A-Za-záéíóúüñ\s,\.'-]{2,})/g;

interface EconomistaRow {
  num: string;
  name: string;
}

function parseRows(html: string): EconomistaRow[] {
  const out: EconomistaRow[] = [];
  const seen = new Set<string>();

  // Strategy 1: look for list items / table cells containing "Nº Colegiado" pattern
  // The page renders as: <span class="...">1624</span> <span>Abad Alvaro, Alfredo</span>
  // We use a loose regex that finds lines with "number name" pattern.

  // Strip script/style blocks first to reduce false positives
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");

  ENTRY_RE.lastIndex = 0;
  for (const m of cleaned.matchAll(ENTRY_RE)) {
    const num = m[1];
    const rawName = m[2].replace(/\s+/g, " ").trim();
    // Filter out very short names and common false positives
    if (rawName.length < 5) continue;
    // Deduplicate by number
    if (seen.has(num)) continue;
    seen.add(num);
    out.push({ num, name: rawName });
  }
  return out;
}

async function fetchPage(page: number): Promise<{ html: string; ok: boolean }> {
  const url = new URL(`${BASE}${LISTADO_PATH}`);
  url.searchParams.set("page", String(page));
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "es-ES,es;q=0.9",
        Referer: `${BASE}${LISTADO_PATH}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.error(`[coev-economistas] page=${page} network error: ${(e as Error).message}`);
    return { html: "", ok: false };
  }
  if (!response.ok) {
    console.error(`[coev-economistas] page=${page} → HTTP ${response.status}`);
    return { html: "", ok: false };
  }
  const html = await response.text();
  return { html, ok: true };
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seenNums = new Set<string>();

  let consecutiveEmpty = 0;
  const maxConsecutiveEmpty = 3;

  for (let page = 0; out.length < limit; page += 1) {
    const { html, ok } = await fetchPage(page);
    if (!ok) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= maxConsecutiveEmpty) break;
      await delay(REQUEST_DELAY_MS * 2);
      continue;
    }

    const rows = parseRows(html);
    if (rows.length === 0) {
      consecutiveEmpty += 1;
      console.log(`[coev-economistas] page=${page} → 0 rows (empty=${consecutiveEmpty})`);
      if (consecutiveEmpty >= maxConsecutiveEmpty) break;
      await delay(REQUEST_DELAY_MS);
      continue;
    }
    consecutiveEmpty = 0;

    let added = 0;
    for (const r of rows) {
      if (seenNums.has(r.num)) continue;
      seenNums.add(r.num);
      out.push(
        normalise({
          source: "coev-economistas" as ScrapeSource,
          country: "ES",
          sourceId: `coev:${r.num}`,
          name: r.name,
          categoryKey: "fiscal",
          citySlug: "valencia",
          licenseNumber: r.num,
          metadata: {
            country: "ES",
            authority: "COEV",
            colegio: "Colegio Oficial de Economistas de Valencia",
            verified_by_authority: true,
          },
        }),
      );
      added += 1;
      if (out.length >= limit) break;
    }

    console.log(
      `[coev-economistas] page=${page} rows=${rows.length} added=${added} total=${out.length}`,
    );

    // Stop if we received fewer rows than a full page (last page signal)
    if (rows.length < PAGE_SIZE) {
      console.log(`[coev-economistas] last page reached (${rows.length} < ${PAGE_SIZE})`);
      break;
    }

    if (out.length < limit) await delay(REQUEST_DELAY_MS);
  }

  return out;
}

export const coevEconomistasSource: ScraperSource = {
  name: "coev-economistas" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_COEV_ECONOMISTAS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCoevEconomistas(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!coevEconomistasSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_COEV_ECONOMISTAS_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0) {
    console.warn("[coev-economistas] no records — page structure may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[coev-economistas] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
