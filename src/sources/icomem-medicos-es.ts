import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase, delay } from "./_bulk-utils.js";

/**
 * ICOMEM — Ilustre Colegio Oficial de Médicos de la Comunidad de Madrid.
 *
 * Pre-flight 2026-05-19: the listing at
 *   https://www.icomem.es/ventanilla-unica/buscador-colegiados/pag/{N}
 * renders 20 physicians per page in plain server-rendered HTML (Joomla CMS,
 * Ventanilla Única module, required by Ley 17/2009). robots.txt allows
 * /ventanilla-unica/. No login, no Cloudflare, no CAPTCHA. Full dataset is
 * ~56,660 active colegiados across ~2,783 pages.
 *
 * Listing fields extracted:
 *   núm_col  — 9-digit ICOMEM licence number (e.g. 281108563)
 *   nombre   — full name in "APELLIDOS, NOMBRE" uppercase form
 *   activo   — "Sí" / "No"; only active rows are ingested
 *
 * All rows map to citySlug=`madrid` (ICOMEM covers Madrid province only).
 *
 * Profile pages at /buscador-colegiados/{id}/{hash} expose address, phone,
 * email and website but would require ~56k extra fetches. Deferred to a
 * future email-enrichment pass for Madrid professionals.
 *
 * Category: medicina. Off by default. Enable: PROLIO_RUN_ICOMEM_MEDICOS=true.
 * Cap via PROLIO_ICOMEM_MEDICOS_LIMIT (default 10 000 ≈ 500 pages).
 * Cadence: monthly (professional rolls change slowly).
 */

const BASE_URL = "https://www.icomem.es";
const LISTING_PATH = "/ventanilla-unica/buscador-colegiados";
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 2_000;
const DEFAULT_LIMIT = 10_000;
const MAX_PAGES = 3_000;
const CITY_SLUG = "madrid";
const CATEGORY: CategoryKey = "medicina";
const UPSERT_BATCH_SIZE = 500;

// ICOMEM licence numbers are 9 digits. Match table rows containing:
//   <td>NNNNNNNNN</td><td>[<a href="...">]NAME[</a>]</td><td>Sí|No</td>
const ROW_RE =
  /<tr[^>]*>[\s\S]*?<td[^>]*>\s*(\d{7,10})\s*<\/td>\s*<td[^>]*>\s*(?:<a[^>]*>)?([^<\n]{4,150})(?:<\/a>)?\s*<\/td>\s*<td[^>]*>\s*(S[íi]|No|si)\s*<\/td>/gi;

function parseListingPage(
  html: string,
): Array<{ num: string; name: string; active: boolean }> {
  ROW_RE.lastIndex = 0;
  const rows: Array<{ num: string; name: string; active: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(html)) !== null) {
    const [, num, rawName, activeStr] = m;
    if (!num || !rawName) continue;
    const name = rawName
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/&#\d+;/g, "")
      .trim();
    const active = /^s[íi]/i.test(activeStr ?? "");
    rows.push({ num, name, active });
  }
  return rows;
}

// "APELLIDO APELLIDO, NOMBRE NOMBRE" → "Nombre Nombre Apellido Apellido"
function reorderSpanishName(raw: string): string {
  const idx = raw.indexOf(",");
  if (idx < 0) return toTitleCase(raw.trim());
  const apellidos = raw.slice(0, idx).trim();
  const nombre = raw.slice(idx + 1).trim();
  return toTitleCase(`${nombre} ${apellidos}`.trim());
}

async function fetchPage(pageNum: number): Promise<string | null> {
  const url =
    pageNum === 1
      ? `${BASE_URL}${LISTING_PATH}`
      : `${BASE_URL}${LISTING_PATH}/pag/${pageNum}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.1",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(`[icomem] page=${pageNum} HTTP ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[icomem] page=${pageNum} fetch failed: ${(e as Error).message}`);
    return null;
  }
}

export const icomemMedicosEsSource: ScraperSource = {
  name: "icomem-medicos-es" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_ICOMEM_MEDICOS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runIcomemMedicosEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!icomemMedicosEsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const limit = (() => {
    const raw = Number(process.env.PROLIO_ICOMEM_MEDICOS_LIMIT ?? DEFAULT_LIMIT);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
  })();

  const sink = getSink();
  const seen = new Set<string>();
  let batch: ScrapedProfessional[] = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let droppedInactive = 0;
  let droppedNoName = 0;
  let lastFingerprint: string | null = null;
  let repeatedPages = 0;

  outer: for (let page = 1; page <= MAX_PAGES; page += 1) {
    const html = await fetchPage(page);
    if (!html) break;

    const rows = parseListingPage(html);
    if (rows.length === 0) {
      console.log(`[icomem] page=${page} no rows — stopping`);
      break;
    }

    // Detect pagination loop: ICOMEM returns the last real page for any
    // over-paginated request; two consecutive identical fingerprints → stop.
    const fingerprint = rows[0].num;
    if (fingerprint === lastFingerprint) {
      repeatedPages += 1;
      if (repeatedPages >= 2) {
        console.log(`[icomem] page=${page} duplicate fingerprint — stopping`);
        break;
      }
    } else {
      repeatedPages = 0;
    }
    lastFingerprint = fingerprint;

    for (const row of rows) {
      if (!row.active) {
        droppedInactive += 1;
        continue;
      }
      if (!row.name || row.name.length < 3) {
        droppedNoName += 1;
        continue;
      }
      const sourceId = `icomem:${row.num}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      batch.push(
        normalise({
          source: "icomem-medicos-es" as ScrapeSource,
          country: "ES",
          sourceId,
          name: reorderSpanishName(row.name),
          categoryKey: CATEGORY,
          citySlug: CITY_SLUG,
          licenseNumber: row.num,
          metadata: {
            country: "ES",
            province: "Madrid",
            verified_by_authority: true,
            authority: "ICOMEM",
          },
        }),
      );

      if (batch.length >= UPSERT_BATCH_SIZE) {
        const r = await sink.upsert(batch);
        inserted += r.inserted;
        updated += r.updated;
        skipped += r.skipped;
        batch = [];
      }

      if (seen.size >= limit) break outer;
    }

    if (page < MAX_PAGES && seen.size < limit) await delay(REQUEST_DELAY_MS);
  }

  if (batch.length > 0) {
    const r = await sink.upsert(batch);
    inserted += r.inserted;
    updated += r.updated;
    skipped += r.skipped;
  }

  console.log(
    `[icomem] done — scraped=${seen.size} inserted=${inserted} updated=${updated} ` +
      `skipped=${skipped} droppedInactive=${droppedInactive} droppedNoName=${droppedNoName}`,
  );
  return { fetched: seen.size, inserted, updated, skipped };
}
