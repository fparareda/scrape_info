import type { ScraperSource } from "../types.js";
import {
  fetchHtml,
  parseRowsLoose,
  CONSEJO_REQUEST_DELAY_MS,
  CONSEJO_MAX_PAGES,
  CONSEJO_DEFAULT_LIMIT,
  runConsejoFederation,
  type ConsejoColegioConfig,
  type ConsejoExtractor,
  type ConsejoFederationConfig,
} from "./_consejo-vu-utils.js";
import { delay } from "./_bulk-utils.js";

/**
 * CGE-Economistas-ES — Consejo General de Economistas de España.
 *
 * Spain's national federation of 48 colegios de economistas y titulados
 * mercantiles (~60k colegiados nationwide). Each colegio is required by
 * Ley 17/2009 (Ventanilla Única — Servicios en el Mercado Interior) to
 * publish a public padrón of its members.
 *
 * Pre-flight findings (2026-05-20):
 *
 *   COEV Valencia (coev.com) — BUILT ✓
 *     Public directory at /colegiados. 4,121 members. Pagination:
 *     ?page=N (0-indexed). 20-25 rows per page. robots.txt: Disallow:
 *     (empty = allow all). Server-rendered Drupal/WordPress hybrid.
 *     Fields: Nº colegiado + full name. Passed pre-flight.
 *
 *   Sevilla (economistas-sevilla.com) — BUILT ✓
 *     1,272 members. Alphabetical pagination: ?letter=A-Z. ~60-70
 *     rows per letter. robots.txt: allows /directorio-de-colegiados/.
 *     Fields: Nº colegiado, APELLIDOS, NOMBRE. Passed pre-flight.
 *
 *   A Coruña (economistascoruna.org) — BUILT ✓
 *     ~1,000 members. Drupal views with alphabetical glosario:
 *     ?f[0]=glosario:A&page=,N (0-indexed). 10 rows per page.
 *     robots.txt: allows /colegiados_buscador. Passed pre-flight.
 *
 *   ECOVA Valladolid/Palencia/Zamora (ecova.es) — BUILT ✓
 *     ~980 members (98 pages × 10 rows). Flat HTML files:
 *     /colegiados_en_activo.html, /colegiados_en_activo_2.html, …
 *     robots.txt: does NOT disallow /colegiados_en_activo.html.
 *     Fields: Nº colegiado, nombre, apellidos, provincia. Passed.
 *
 *   Madrid CEMAD (cemad.es) — AJAX/B
 *     "Encuentra tu economista" at /ventanilla-unica/ uses AJAX
 *     (province dropdown + spinner GIF). Could not retrieve member
 *     data with plain HTTP. Reserved status B.
 *
 *   CGE central buscar-colegiados (economistas.es) — 403
 *     Both /buscar-colegiados/ and /robots.txt return 403 from
 *     datacenter IPs. Can't verify robots.txt. Skipped.
 *
 * Collectively the four live colegios deliver ~7,373 economist
 * records → well above the 500-record viability threshold.
 *
 * Taxonomy mapping: `fiscal` — economistas act as tax advisors
 * (asesores fiscales) in Spain; they overlap significantly with
 * gestores and accountants. The REAF sub-registry (6,000+) is a
 * subset of CGE members who are accredited fiscal advisors.
 *
 * Off by default. Enable via `PROLIO_RUN_CGE_ECONOMISTAS_ES=true`.
 * Limit per colegio: `PROLIO_CGE_ECONOMISTAS_ES_LIMIT` (default 2000).
 * Restrict to one colegio: `PROLIO_CGE_ECONOMISTAS_ES_ONLY=coev,sevilla`.
 */

// ─── Bespoke extractor: COEV Valencia (coev.com) ─────────────────────────

/**
 * COEV directory at https://www.coev.com/colegiados?page=N.
 * Each page delivers ~20 entries. Pagination is 0-indexed.
 * Row format observed: "NNNN Apellido1 Apellido2, Nombre" inside a
 * data cell or strong element — the generic parseRowsLoose TABLE regex
 * matches well because entries appear as <td>NNNN Nombre...</td> pairs.
 *
 * However the actual structure is a custom WordPress theme with entries
 * like:
 *   <div class="colegiado-numero">1624</div>
 *   <div class="colegiado-nombre">Abad Alvaro, Alfredo</div>
 * So we use a dedicated regex that covers both the generic table pattern
 * AND the custom div pattern.
 */
const COEV_ROW_RE =
  /class="[^"]*(?:colegiado-numero|col-nro)[^"]*"[^>]*>\s*(\d{2,7})\s*<\/[a-z]+>[\s\S]{0,400}?class="[^"]*(?:colegiado-nombre|col-nombre)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

const coevExtractor: ConsejoExtractor = async (colegio, limit) => {
  const out: Array<{ num: string; name: string }> = [];
  const seen = new Set<string>();
  for (let p = 0; p < CONSEJO_MAX_PAGES; p += 1) {
    if (out.length >= limit) break;
    const url = `${colegio.base}${colegio.padronPath ?? "/colegiados"}?page=${p}`;
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      console.error(`[cge-economistas] coev p${p} fetch: ${(e as Error).message}`);
      break;
    }
    // Try custom div pattern first, fall back to generic table regex.
    COEV_ROW_RE.lastIndex = 0;
    const matches = [...html.matchAll(COEV_ROW_RE)];
    let rows = matches
      .map((m) => ({ num: m[1]!, name: m[2]!.trim() }))
      .filter((r) => r.num && r.name);

    if (rows.length === 0) {
      // Fallback to generic (handles plain table or class-tagged spans).
      rows = parseRowsLoose(html);
    }
    if (rows.length === 0) break;

    let added = 0;
    for (const r of rows) {
      if (seen.has(r.num)) continue;
      seen.add(r.num);
      out.push(r);
      added += 1;
      if (out.length >= limit) break;
    }
    // Detect pagination end: if no new rows were added, we've looped.
    if (added === 0) break;
    if (p < CONSEJO_MAX_PAGES - 1) await delay(CONSEJO_REQUEST_DELAY_MS);
  }
  return out;
};

// ─── Bespoke extractor: Sevilla (economistas-sevilla.com) ────────────────

/**
 * Sevilla directory uses alphabetical pagination: ?letter=A through ?letter=Z.
 * Each letter page returns 60-70 entries. The HTML uses <strong> elements:
 *   <strong>APELLIDOS</strong> Fernández García
 *   <strong>NOMBRE</strong> Juan
 *   <strong>Nº COLEGIADO</strong> 1234
 * We capture Nº COLEGIADO and reconstruct "Apellidos, Nombre".
 */
const SEVILLA_NUM_RE = /Nº\s*COLEGIADO[^<]*<\/strong>\s*([0-9]+)/gi;
const SEVILLA_APELLIDOS_RE = /APELLIDOS[^<]*<\/strong>\s*([^<]+)/gi;
const SEVILLA_NOMBRE_RE = /NOMBRE[^<]*<\/strong>\s*([^<]+)/gi;

function parseSevillaPage(html: string): Array<{ num: string; name: string }> {
  const nums: string[] = [];
  const apellidos: string[] = [];
  const nombres: string[] = [];

  SEVILLA_NUM_RE.lastIndex = 0;
  for (const m of html.matchAll(SEVILLA_NUM_RE)) {
    nums.push(m[1]!.trim());
  }
  SEVILLA_APELLIDOS_RE.lastIndex = 0;
  for (const m of html.matchAll(SEVILLA_APELLIDOS_RE)) {
    apellidos.push(m[1]!.trim());
  }
  SEVILLA_NOMBRE_RE.lastIndex = 0;
  for (const m of html.matchAll(SEVILLA_NOMBRE_RE)) {
    nombres.push(m[1]!.trim());
  }

  const out: Array<{ num: string; name: string }> = [];
  const len = Math.min(nums.length, apellidos.length, nombres.length);
  for (let i = 0; i < len; i += 1) {
    const num = nums[i]!;
    const name = `${apellidos[i]}, ${nombres[i]}`.trim();
    if (num && name !== ", ") out.push({ num, name });
  }
  // If the three arrays don't align (different lengths), fall back to
  // just the number+apellidos pairs (better than nothing).
  if (out.length === 0 && nums.length > 0 && apellidos.length > 0) {
    for (let i = 0; i < Math.min(nums.length, apellidos.length); i += 1) {
      out.push({ num: nums[i]!, name: apellidos[i]! });
    }
  }
  return out;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const sevillaExtractor: ConsejoExtractor = async (colegio, limit) => {
  const out: Array<{ num: string; name: string }> = [];
  const seen = new Set<string>();
  for (const letter of LETTERS) {
    if (out.length >= limit) break;
    const url = `${colegio.base}${colegio.padronPath ?? "/directorio-de-colegiados/"}?letter=${letter}`;
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      console.error(`[cge-economistas] sevilla letter=${letter}: ${(e as Error).message}`);
      continue;
    }
    const rows = parseSevillaPage(html);
    // Also try generic as fallback.
    const generic = parseRowsLoose(html);
    const combined = rows.length >= generic.length ? rows : generic;

    let added = 0;
    for (const r of combined) {
      if (seen.has(r.num)) continue;
      seen.add(r.num);
      out.push(r);
      added += 1;
      if (out.length >= limit) break;
    }
    if (added > 0) await delay(CONSEJO_REQUEST_DELAY_MS);
  }
  return out;
};

// ─── Bespoke extractor: A Coruña (economistascoruna.org) ─────────────────

/**
 * Drupal Views with alphabetical glossary filter.
 * URL pattern: /es/colegiados_buscador?f[0]=glosario:A&page=,N
 * (Note: page= is comma-prefixed, 0-indexed: page=,0 is page 1.)
 * 10 rows per page. Rows appear in a <table> with:
 *   <td>NUMBER</td><td>NOMBRE COMPLETO</td><td>Si/No</td>
 * The generic TABLE regex handles this perfectly.
 */
const CORUNA_LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

const corunaExtractor: ConsejoExtractor = async (colegio, limit) => {
  const out: Array<{ num: string; name: string }> = [];
  const seen = new Set<string>();
  const base = `${colegio.base}/es/colegiados_buscador`;

  for (const letter of CORUNA_LETTERS) {
    if (out.length >= limit) break;
    // Iterate pages within each letter until empty.
    for (let p = 0; p < 50; p += 1) {
      if (out.length >= limit) break;
      const url = `${base}?f%5B0%5D=glosario%3A${letter}&page=%2C${p}`;
      let html: string;
      try {
        html = await fetchHtml(url);
      } catch (e) {
        console.error(`[cge-economistas] coruna ${letter} p${p}: ${(e as Error).message}`);
        break;
      }
      const rows = parseRowsLoose(html);
      if (rows.length === 0) break;
      let added = 0;
      for (const r of rows) {
        if (seen.has(r.num)) continue;
        seen.add(r.num);
        out.push(r);
        added += 1;
        if (out.length >= limit) break;
      }
      if (added === 0) break;
      await delay(CONSEJO_REQUEST_DELAY_MS);
    }
  }
  return out;
};

// ─── Bespoke extractor: ECOVA Valladolid/Palencia/Zamora (ecova.es) ──────

/**
 * ECOVA uses sequential flat HTML files:
 *   /colegiados_en_activo.html (page 1)
 *   /colegiados_en_activo_2.html
 *   /colegiados_en_activo_3.html
 *   …
 *   /colegiados_en_activo_98.html (last page confirmed at pre-flight)
 * 10 rows per page × 98 pages ≈ 980 members.
 * Rows are <tr>/<td> tables — generic TABLE regex works.
 */
const ECOVA_MAX_PAGES = 120; // headroom above observed 98

const ecovaExtractor: ConsejoExtractor = async (colegio, limit) => {
  const out: Array<{ num: string; name: string }> = [];
  const seen = new Set<string>();
  const base = colegio.base;

  for (let p = 1; p <= ECOVA_MAX_PAGES; p += 1) {
    if (out.length >= limit) break;
    const path =
      p === 1
        ? "/colegiados_en_activo.html"
        : `/colegiados_en_activo_${p}.html`;
    const url = `${base}${path}`;
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      // 404 signals end of pages.
      console.error(`[cge-economistas] ecova p${p}: ${(e as Error).message}`);
      break;
    }
    // Check for an empty page (no table rows) which would indicate past the end.
    const rows = parseRowsLoose(html);
    if (rows.length === 0) break;
    let added = 0;
    for (const r of rows) {
      if (seen.has(r.num)) continue;
      seen.add(r.num);
      out.push(r);
      added += 1;
      if (out.length >= limit) break;
    }
    if (added === 0) break;
    if (p < ECOVA_MAX_PAGES) await delay(CONSEJO_REQUEST_DELAY_MS);
  }
  return out;
};

// ─── Registry of participating colegios ──────────────────────────────────

const COLEGIOS: ConsejoColegioConfig[] = [
  // ── A: scrapable ────────────────────────────────────────────────────────
  {
    slug: "coev",
    name: "Ilustre Colegio de Economistas de Valencia",
    citySlug: "valencia",
    cityName: "Valencia",
    base: "https://www.coev.com",
    padronPath: "/colegiados",
    status: "A",
    extractor: coevExtractor,
    notes:
      "4,121 members. robots.txt: Disallow: (empty). Pagination: ?page=N (0-indexed).",
  },
  {
    slug: "sevilla",
    name: "Colegio de Economistas de Sevilla",
    citySlug: "sevilla",
    cityName: "Sevilla",
    base: "https://economistas-sevilla.com",
    padronPath: "/directorio-de-colegiados/",
    status: "A",
    extractor: sevillaExtractor,
    notes:
      "1,272 members. Alphabetical: ?letter=A-Z. robots.txt: allows path.",
  },
  {
    slug: "coruna",
    name: "Colegio de Economistas de A Coruña",
    citySlug: "a-coruna",
    cityName: "A Coruña",
    base: "https://economistascoruna.org",
    padronPath: "/es/colegiados_buscador",
    status: "A",
    extractor: corunaExtractor,
    notes:
      "~1,000 members. Drupal Views alphabetical glossary. robots.txt: allows path.",
  },
  {
    slug: "ecova",
    name: "ECOVA – Colegio de Economistas de Valladolid, Palencia y Zamora",
    citySlug: "valladolid",
    cityName: "Valladolid",
    base: "https://www.ecova.es",
    padronPath: "/colegiados_en_activo.html",
    status: "A",
    extractor: ecovaExtractor,
    notes:
      "~980 members. Flat HTML files: /colegiados_en_activo_N.html. robots.txt: path not blocked.",
  },

  // ── B: limited / needs investigation ────────────────────────────────────
  {
    slug: "cemad",
    name: "Colegio de Economistas de Madrid",
    citySlug: "madrid",
    cityName: "Madrid",
    base: "https://www.cemad.es",
    status: "B",
    extractor: null,
    notes:
      "'Encuentra tu economista' uses AJAX province-dropdown. Pre-flight: AJAX/B — dynamic spinner, no static HTML.",
  },
  {
    slug: "cge-central",
    name: "Consejo General de Economistas (buscar-colegiados)",
    citySlug: "madrid",
    cityName: "Madrid",
    base: "https://economistas.es",
    status: "B",
    extractor: null,
    notes:
      "economistas.es returns 403 from datacenter IPs for both /buscar-colegiados/ and /robots.txt. Cannot verify access.",
  },
];

// ─── Federation config ────────────────────────────────────────────────────

const FEDERATION_CFG: ConsejoFederationConfig = {
  federationSlug: "cge-economistas",
  sourceName: "colegio",
  authority: "CGE",
  categoryKey: "fiscal",
  colegios: COLEGIOS,
  onlyEnv: "PROLIO_CGE_ECONOMISTAS_ES_ONLY",
};

// ─── Public exports ───────────────────────────────────────────────────────

export const cgeEconomistasEsSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_CGE_ECONOMISTAS_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export function cgeEconomistasEsEnabled(): boolean {
  return cgeEconomistasEsSource.enabled();
}

export async function runCgeEconomistasEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cgeEconomistasEsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return runConsejoFederation(FEDERATION_CFG, {
    limitEnv: "PROLIO_CGE_ECONOMISTAS_ES_LIMIT",
    defaultLimit: CONSEJO_DEFAULT_LIMIT,
  });
}
