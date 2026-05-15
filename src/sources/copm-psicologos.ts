import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * COPM — Colegio Oficial de Psicólogos de Madrid.
 *
 * The Madrid psychology college publishes a public, server-rendered
 * paginated listing of all registered colegiados at:
 *
 *   https://web.copmadrid.org/ciudadania/servicios-al-ciudadano/listado-colegiados?page=N
 *
 * Pre-flight (2026-05-15):
 *
 *   robots.txt: web.copmadrid.org returns HTTP 404 (no robots.txt file
 *   = no restrictions). www.copmadrid.org robots.txt only blocks
 *   /web/img_db/, /web/files/, /img_db/, /files/ — none match our path.
 *
 *   Auth / WAF: none observed. Public listing, no login, no captcha,
 *   no Cloudflare block.
 *
 *   Record count: 22,687 colegiados confirmed (shown as "22687
 *   resultados" on page 1). Pagination: 2,269 pages at 10 records/page.
 *
 *   Data per record: name (full name in uppercase), registration number
 *   (M-##### format), academic qualification, professional status
 *   (Ejerciente / No ejerciente). No per-record address or phone.
 *
 *   All records map to citySlug `madrid` — COPM covers the Community of
 *   Madrid (one of Spain's largest psychology colleges, ~22k members).
 *
 * Category: `psicologia`.
 * Off by default. Enable with PROLIO_RUN_COPM_PSICOLOGOS=true.
 * Cap with PROLIO_COPM_PSICOLOGOS_LIMIT (default 2000).
 * Delay between pages: 1500 ms (polite).
 *
 * Parse strategy: regex on server-rendered HTML. Each record consists of
 * a name heading followed by the registration number on the next line.
 * The registration number always matches /M-\d{4,6}/ (5–8 chars after
 * "M-"). Status "No ejerciente" (non-practicing) rows are included —
 * they are still registered colegiados and useful for the index.
 */

const BASE_URL =
  process.env.PROLIO_COPM_BASE ||
  "https://web.copmadrid.org/ciudadania/servicios-al-ciudadano/listado-colegiados";
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_500;
const DEFAULT_LIMIT = 2_000;
const MAX_PAGES = 2_300; // safety cap; site has ~2,269 pages as of 2026-05-15

const CITY_SLUG = "madrid";
const SOURCE_NAME = "copm-psicologos" as const;

// Match: capture name (uppercase words, possible spaces/hyphens/apostrophes)
// followed by registration number pattern M-#### anywhere in the subsequent
// ~500 chars. Works against both "APELLIDO NOMBRE" heading styles and any
// wrapper tags around the number.
//
// Strategy: find every "M-\d{4,6}" in the HTML and walk backwards to extract
// the closest preceding name. This is more robust than trying to match a
// rigid record-boundary pattern across different CMS template versions.
//
// Name extraction: look for sequences of uppercase Latin letters (with
// spaces/hyphens) immediately before the M-#### token, skipping HTML tags
// and whitespace.
const REG_NUM_RE = /M-(\d{4,6})/g;

// Rough heuristic to get the name preceding a registration number:
// scan back from the match position for the last block of text that looks
// like a proper name (ALL-CAPS or Title-Case, ≥3 chars, possibly
// multi-word with spaces/hyphens/apostrophes).
const NAME_CANDIDATE_RE =
  /([A-ZÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛÃÕ][A-ZÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛÃÕA-Za-záéíóúüñàèìòùâêîôûãõ'\-]{1,}\s+(?:[A-ZÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛÃÕ][A-ZÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛÃÕA-Za-záéíóúüñàèìòùâêîôûãõ'\-]{1,}\s*){0,5})/g;

interface CopmRecord {
  regNum: string;
  name: string;
}

/**
 * Strip HTML tags and decode common entities; collapse whitespace.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a single HTML page and extract colegiado records.
 *
 * Approach: split on M-#### tokens. Everything in the 600-char window
 * before each token is examined for the last contiguous block of name-like
 * text (all-caps words, possibly multi-word). We strip HTML tags first.
 */
function parsePage(html: string): CopmRecord[] {
  const records: CopmRecord[] = [];
  const plain = stripHtml(html);

  REG_NUM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = REG_NUM_RE.exec(plain)) !== null) {
    const regNum = `M-${match[1]}`;
    const matchStart = match.index;

    // Look back up to 600 chars before the "M-" token.
    const windowStart = Math.max(0, matchStart - 600);
    const window = plain.slice(windowStart, matchStart).trim();

    // Find all name-like candidates in the window; take the LAST one
    // (closest to the registration number).
    NAME_CANDIDATE_RE.lastIndex = 0;
    const nameCandidates: string[] = [];
    let nm: RegExpExecArray | null;
    while ((nm = NAME_CANDIDATE_RE.exec(window)) !== null) {
      const candidate = nm[1].trim();
      // Must be at least 2 words (first + last name) and sufficiently long.
      if (candidate.split(/\s+/).length >= 2 && candidate.length >= 5) {
        nameCandidates.push(candidate);
      }
    }

    if (nameCandidates.length === 0) continue;

    // The last candidate is closest to the M-#### token.
    const rawName = nameCandidates[nameCandidates.length - 1].trim();
    const name = toTitleCase(rawName);
    if (!name) continue;

    records.push({ regNum, name });
  }

  return records;
}

/**
 * Fetch one page with polite UA first; on 403/503 retry once with Chrome UA.
 * Returns null on network error or non-OK status.
 */
async function fetchPage(page: number): Promise<string | null> {
  const url = page <= 1 ? BASE_URL : `${BASE_URL}?page=${page}`;

  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[copm-psicologos] page=${page} blocked polite UA (${response.status}); retrying`,
          );
          continue;
        }
        console.warn(
          `[copm-psicologos] page=${page} HTTP ${response.status} — skipping`,
        );
        return null;
      }
      if (!response.ok) {
        console.warn(
          `[copm-psicologos] page=${page} HTTP ${response.status} — skipping`,
        );
        return null;
      }
      return response.text();
    } catch (error) {
      clearTimeout(timer);
      console.warn(
        `[copm-psicologos] page=${page} network error: ${(error as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let consecutiveEmpty = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (out.length >= limit) break;

    const html = await fetchPage(page);
    if (!html) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= 3) {
        console.warn(`[copm-psicologos] 3 consecutive fetch failures — stopping`);
        break;
      }
      if (page < MAX_PAGES) await delay(REQUEST_DELAY_MS);
      continue;
    }
    consecutiveEmpty = 0;

    // Detect end of pagination: if the page HTML contains no registration
    // number at all, we've gone past the last page.
    if (!html.includes("M-")) {
      console.log(`[copm-psicologos] page=${page} no records — stopping`);
      break;
    }

    const records = parsePage(html);
    if (records.length === 0) {
      console.log(`[copm-psicologos] page=${page} parsed 0 records — stopping`);
      break;
    }

    for (const r of records) {
      if (seen.has(r.regNum)) continue;
      seen.add(r.regNum);

      out.push(
        normalise({
          source: SOURCE_NAME,
          sourceId: `${SOURCE_NAME}:${r.regNum}`,
          name: r.name,
          categoryKey: "psicologia",
          citySlug: CITY_SLUG,
          licenseNumber: r.regNum,
          metadata: {
            country: "ES",
            authority: "COPM",
            colegio: "Colegio Oficial de Psicólogos de Madrid",
            numero_colegiado: r.regNum,
            verified_by_authority: true,
          },
        }),
      );

      if (out.length >= limit) break;
    }

    console.log(
      `[copm-psicologos] page=${page} parsed=${records.length} total=${out.length}`,
    );

    if (out.length < limit && page < MAX_PAGES) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  return out;
}

export const copmPsicologosSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_COPM_PSICOLOGOS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCopmPsicologos(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!copmPsicologosSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(
    process.env.PROLIO_COPM_PSICOLOGOS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  console.log(`[copm-psicologos] starting — limit=${limit}`);
  const records = await fetchAll(limit);

  if (records.length === 0) {
    console.log("[copm-psicologos] no records fetched");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[copm-psicologos] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
