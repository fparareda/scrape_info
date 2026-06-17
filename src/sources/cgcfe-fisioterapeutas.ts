import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, parseCsv, toTitleCase } from "./_bulk-utils.js";

/**
 * CGCFE — Consejo General de Colegios de Fisioterapeutas de España.
 *
 * Pre-flight 2026-05-14:
 *   robots.txt at https://www.consejo-fisioterapia.org/robots.txt
 *   Disallows only /adjuntos/{memoria_anual,cuentas_auditadas,presupuesto_contrato}/
 *   and states `Allow: /` — the registry path is explicitly permitted.
 *
 * Public directory: https://www.consejo-fisioterapia.org/vu_colegiados.html
 *   Paginated HTML (2306 pages, ~9 rows/page, ~19 861 total records).
 *   Per-page CSV download:
 *     https://www.consejo-fisioterapia.org/vu_colegiados/pag_N/descargar.html
 *   Returns semicolon-delimited CSV with three columns: COLEGIO, NUMERO, NOMBRE.
 *   No bulk single-shot URL exists; must paginate.
 *   Last updated: 2026-05-14. No CAPTCHA, no login, no WAF observed.
 *
 * City mapping: the CSV has no address field. We derive a city slug from
 * the college name using COLLEGE_TO_CITY (autonomous community → largest
 * seeded ES city). Unrecognised colleges fall back to "madrid".
 *
 * Off by default. Enable: `PROLIO_RUN_CGCFE_FISIOTERAPEUTAS=true`.
 * Cap with `PROLIO_CGCFE_LIMIT` (default 25000 — full sweep).
 */

const BASE_URL = "https://www.consejo-fisioterapia.org";
const PAGE_URL = (n: number) =>
  `${BASE_URL}/vu_colegiados/pag_${n}/descargar.html`;

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 500;
const TOTAL_PAGES = 2306; // verified 2026-05-14; last page = 2306
const DEFAULT_LIMIT = 25_000;
const CATEGORY: CategoryKey = "fisioterapia";

/**
 * Map college name fragment → representative ES city slug.
 * Covers all 17 autonomous communities. Case-insensitive substring match.
 */
const COLLEGE_CITY_PATTERNS: Array<[RegExp, string]> = [
  [/madrid/i, "madrid"],
  [/catalunya|cataluña|catalu/i, "barcelona"],
  [/andaluc/i, "sevilla"],
  [/pa[ií]s vasco|euskadi/i, "bilbao"],
  [/galicia|galiza/i, "vigo"],
  [/murcia/i, "murcia"],
  [/aragon|aragón/i, "zaragoza"],
  [/canarias/i, "las-palmas"],
  [/castilla.la mancha/i, "albacete"],
  [/castilla y le[oó]n/i, "valladolid"],
  [/comunidad valenciana|c\.?v\.?|valenciana/i, "valencia"],
  [/navarra/i, "pamplona"],
  [/asturias/i, "oviedo"],
  [/cantabria/i, "santander"],
  [/extremadura/i, "badajoz"],
  [/la rioja|rioja/i, "logrono"],
  [/baleares|illes balears/i, "palma"],
  [/ceuta/i, "madrid"],
  [/melilla/i, "madrid"],
];

function collegeToCity(college: string): string {
  for (const [re, slug] of COLLEGE_CITY_PATTERNS) {
    if (re.test(college)) return slug;
  }
  return "madrid"; // national fallback
}

async function fetchPageCsv(pageNum: number): Promise<string | null> {
  const url = PAGE_URL(pageNum);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/csv,text/plain,*/*",
        Referer: `${BASE_URL}/vu_colegiados/pag_${pageNum}.html`,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 404) return null; // past last page
      console.warn(`[cgcfe] page ${pageNum} → HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(
      `[cgcfe] page ${pageNum} network error: ${(err as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface CgcfeRow {
  colegio: string;
  numero: string;
  nombre: string;
}

function parseRows(csv: string): CgcfeRow[] {
  const rows = parseCsv(csv); // auto-detects ; separator
  const out: CgcfeRow[] = [];
  for (const row of rows) {
    // parseCsv normalises headers to snake_case
    const colegio = (row["colegio"] ?? "").trim();
    const numero = (row["numero"] ?? row["n_mero"] ?? row["num"] ?? "").trim();
    const nombre = (row["nombre"] ?? "").trim();
    if (!nombre || !numero) continue;
    out.push({ colegio, numero, nombre });
  }
  return out;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let emptyStreak = 0;

  for (let p = 1; p <= TOTAL_PAGES && out.length < limit; p++) {
    const csv = await fetchPageCsv(p);
    if (csv === null) {
      emptyStreak++;
      if (emptyStreak >= 5) {
        console.warn(`[cgcfe] 5 consecutive empty pages at p=${p}; stopping`);
        break;
      }
      continue;
    }
    emptyStreak = 0;
    const rows = parseRows(csv);
    if (rows.length === 0) {
      emptyStreak++;
      continue;
    }

    for (const r of rows) {
      if (out.length >= limit) break;
      // Build a stable source ID: college abbreviation + licence number
      const key = `cgcfe:${r.colegio.slice(0, 40)}:${r.numero}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const citySlug = collegeToCity(r.colegio);
      out.push(
        normalise({
          source: "cgcfe-fisioterapeutas" as ScrapeSource,
          country: "ES",
          sourceId: key,
          name: toTitleCase(r.nombre),
          categoryKey: CATEGORY,
          citySlug,
          licenseNumber: r.numero,
          metadata: {
            country: "ES",
            authority: "CGCFE",
            colegio: r.colegio,
            verified_by_authority: true,
          },
        }),
      );
    }

    if (p % 100 === 0) {
      console.log(`[cgcfe] page ${p}/${TOTAL_PAGES} — collected ${out.length}`);
    }
    if (p < TOTAL_PAGES && out.length < limit) {
      await delay(REQUEST_DELAY_MS);
    }
  }
  return out;
}

export const cgcfeFisioterapeutasSource: ScraperSource = {
  name: "cgcfe-fisioterapeutas" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CGCFE_FISIOTERAPEUTAS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCgcfeFisioterapeutas(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cgcfeFisioterapeutasSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_CGCFE_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(cap);
  if (records.length === 0) {
    console.warn(
      "[cgcfe] no rows fetched — CSV endpoint may have changed",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cgcfe] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
