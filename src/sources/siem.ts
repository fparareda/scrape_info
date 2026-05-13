import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getCities } from "../cities.js";
import { getSink } from "../sink.js";
import { parseCsv, pick } from "./_bulk-utils.js";
import { mxStateToCity, MX_STATE_TO_CITY } from "./_mx-states.js";

/**
 * SIEM — Sistema de Información Empresarial Mexicano (Secretaría de
 * Economía). Single national CSV listing every establecimiento
 * registered by the autorised cámaras empresariales, ~600-700k rows
 * with razón social, dirección, CP, teléfono, e-mail and SCIAN giro.
 * License: CC-BY-4.0 (commercial reuse OK with attribution).
 *
 * Resource discovery: CKAN package
 *   GET https://datos.gob.mx/api/3/action/package_search?q=SIEM
 *   → package "sistema_informacion_empresarial_mexicano"
 *   → newest resource lives at
 *     https://repodatos.atdt.gob.mx/api_update/secretaria_economia/
 *       sistema_informacion_empresarial_mexicano/datosgob_SIEM_<YYYYMM>.csv
 *
 * The dataset is refreshed roughly monthly (the publisher labels it
 * "Anual" but in practice a new YYYYMM file appears every few weeks).
 * We hard-code the current vintage; `PROLIO_SIEM_CSV` overrides if the
 * filename rotates before this code does.
 *
 * Columns (UTF-8, comma-separated, header row present):
 *   razon_social,estado,municipio,domicilio,colonia,cp,telefono,
 *   e_mail,giro,scian,rango_empleados,registrado_por
 *
 * The `scian` cell carries the 6-digit SCIAN 2018 code — same code
 * space DENUE uses, so we reuse the same mapping philosophy: only
 * codes we have a Prolio category for survive. Email/phone are
 * commonly the literal string "sin dato" and need filtering.
 *
 * Off by default. `PROLIO_RUN_SIEM=true` enables. Cap with
 * `PROLIO_SIEM_LIMIT` (default 50000). On a full run the CSV is
 * ~35 MB compressed, ~150 MB inflated.
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const DEFAULT_LIMIT = 50_000;

// Current vintage (October 2025 snapshot, published 2026-02-17).
// Override with PROLIO_SIEM_CSV when a new YYYYMM file lands.
const DEFAULT_CSV_URL =
  "https://repodatos.atdt.gob.mx/api_update/secretaria_economia/sistema_informacion_empresarial_mexicano/datosgob_SIEM_202509.csv";

/**
 * SCIAN 2018 (MX) 6-digit code → Prolio category. SIEM uses the same
 * code space as DENUE, but the empirical mix is heavier on retail /
 * professional services (cámaras tilt that way). We carry the same
 * 23/54/56/62/81/48-49 mappings as denue-mx for consistency, plus a
 * few extras commonly seen in SIEM-only rows (electricistas under
 * 238100, plomería 238221, etc.).
 *
 * Anything unmapped is dropped — SIEM has 600+ giros spanning all
 * sectors; we only want those that line up with one of the 16 Prolio
 * categories. Keep this map in sync with denue-mx's SCIAN_TO_CATEGORY
 * if new categories are added there.
 */
const SCIAN_TO_CATEGORY: Record<string, CategoryKey> = {
  // Sector 23 — Construcción
  "238210": "electricidad",
  "238221": "fontaneria",
  "238222": "fontaneria",
  "238223": "fontaneria",
  "238350": "carpinteria",

  // Sector 54 — Servicios profesionales
  "541110": "extranjeria",
  "541120": "notario",
  "541190": "extranjeria",
  "541211": "fiscal",
  "541219": "fiscal",
  "541310": "arquitecto",
  "541320": "arquitecto",
  "541940": "veterinario",

  // Sector 56 — Servicios de apoyo a los negocios
  "561621": "cerrajero",

  // Sector 62 — Servicios de salud
  "621111": "medicina",
  "621112": "medicina",
  "621113": "medicina",
  "621114": "medicina",
  "621115": "medicina",
  "621116": "medicina",
  "621117": "medicina",
  "621118": "medicina",
  "621119": "medicina",
  "621211": "dentista",
  "621212": "dentista",
  "621331": "psicologia",
  "621398": "fisioterapia",
  "621399": "fisioterapia",

  // Sector 81 — Otros servicios (mecánica)
  "811111": "mecanica",
  "811112": "mecanica",
  "811113": "mecanica",
  "811114": "mecanica",
  "811115": "mecanica",
  "811116": "mecanica",
  "811119": "mecanica",
  "811121": "mecanica",
  "811122": "mecanica",

  // Sector 48-49 — Transporte (centros de verificación vehicular)
  "488410": "itv",
};

/**
 * SIEM frequently writes the giro field as plain Spanish prose without
 * a numeric SCIAN — e.g. "Servicios de plomería", "Notarías públicas".
 * For rows whose `scian` cell doesn't match SCIAN_TO_CATEGORY, we fall
 * back to keyword matching on `giro`. Ordered by specificity: longer
 * phrases checked first to avoid "médico" eating "veterinario".
 */
const GIRO_KEYWORD_TO_CATEGORY: Array<[RegExp, CategoryKey]> = [
  [/\bnotar[ií]a/i, "notario"],
  [/\bveterinari/i, "veterinario"],
  [/\barquitect/i, "arquitecto"],
  [/\bcontador|contabilidad|fiscal\b/i, "fiscal"],
  [/\babogad|bufete|jur[ií]dic|legal\b/i, "extranjeria"],
  [/\bcerrajer/i, "cerrajero"],
  [/\belectricista|instalaci[oó]n el[eé]ctrica/i, "electricidad"],
  [/\bplomer[ií]a|fontaner|hidr[aá]ulica/i, "fontaneria"],
  [/\bcarpinter/i, "carpinteria"],
  [/\bmec[aá]nic|hojalater|alineac/i, "mecanica"],
  [/\bverificaci[oó]n vehicular/i, "itv"],
  [/\bdentista|dental|odontolog/i, "dentista"],
  [/\bpsic[oó]log/i, "psicologia"],
  [/\bfisioterap/i, "fisioterapia"],
  [/\bm[eé]dic|consultorio m[eé]dico|cl[ií]nica/i, "medicina"],
];

let MX_CITY_SLUGS_CACHE: Set<string> | undefined;

async function ensureMxCitySlugs(): Promise<Set<string>> {
  if (MX_CITY_SLUGS_CACHE) return MX_CITY_SLUGS_CACHE;
  const cities = await getCities({ country: "MX" });
  MX_CITY_SLUGS_CACHE = new Set(cities.map((c) => c.slug));
  return MX_CITY_SLUGS_CACHE;
}

/**
 * Pick a city slug for a SIEM row. SIEM gives us both `municipio`
 * (free-text label) and `estado`. We try the municipio first against
 * the seeded MX cities; on miss, fall back to the state → metro
 * mapping used by other MX sources.
 */
function siemRowToCitySlug(
  municipio: string,
  estado: string,
  validSlugs: Set<string>,
): string | null {
  const muniSlug = slugify(municipio);
  if (muniSlug && validSlugs.has(muniSlug)) return muniSlug;
  const stateMapped = mxStateToCity(estado);
  if (stateMapped && validSlugs.has(stateMapped)) return stateMapped;
  // Last-ditch: even if the state slug isn't seeded, MX_STATE_TO_CITY
  // collapses to a known metro for every estado.
  const stateSlug = slugify(estado);
  if (stateSlug && MX_STATE_TO_CITY[stateSlug]) {
    const fallback = MX_STATE_TO_CITY[stateSlug];
    if (validSlugs.has(fallback)) return fallback;
  }
  return null;
}

function categoriseRow(scian: string, giro: string): CategoryKey | null {
  if (scian && SCIAN_TO_CATEGORY[scian]) return SCIAN_TO_CATEGORY[scian];
  if (!giro) return null;
  for (const [pattern, cat] of GIRO_KEYWORD_TO_CATEGORY) {
    if (pattern.test(giro)) return cat;
  }
  return null;
}

/** SIEM uses "sin dato" / "n/a" / "no aplica" as null sentinels. */
function cleanSentinel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (/^(sin\s*dato|n\/?a|no\s*aplica|ninguno|s\.?d\.?)$/i.test(v))
    return undefined;
  return v;
}

async function fetchCsv(url: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/csv,text/plain,*/*",
      },
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    console.error(`[siem] download ${url}: ${(error as Error).message}`);
    return null;
  }
  if (!response.ok) {
    console.error(`[siem] ${response.status} on ${url}`);
    return null;
  }
  return await response.text();
}

export const siemSource: ScraperSource = {
  name: "siem" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_SIEM === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runSiem(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!siemSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_SIEM_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const url = process.env.PROLIO_SIEM_CSV || DEFAULT_CSV_URL;

  const text = await fetchCsv(url);
  if (!text) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rows = parseCsv(text);
  console.log(`[siem] parsed ${rows.length} rows from ${url}`);
  const validSlugs = await ensureMxCitySlugs();

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCategory = 0;
  let droppedNoCity = 0;

  for (const row of rows) {
    if (out.length >= limit) break;

    const scian = pick(row, ["scian", "codigo_act", "codigo_actividad"]);
    const giro = pick(row, ["giro", "actividad", "nombre_act"]);
    const category = categoriseRow(scian, giro);
    if (!category) {
      droppedNoCategory += 1;
      continue;
    }

    const name = pick(row, ["razon_social", "nombre", "nom_estab"]);
    if (!name) continue;

    const estado = pick(row, ["estado", "entidad"]);
    const municipio = pick(row, ["municipio", "nom_mun"]);
    const citySlug = siemRowToCitySlug(municipio, estado, validSlugs);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }

    // Stable dedupe key: SIEM doesn't ship a stable folio / RFC column,
    // so we hash razon_social + estado + municipio + cp.
    const cp = pick(row, ["cp", "codigo_postal"]);
    const dedupeKey = `${slugify(name)}|${slugify(estado)}|${slugify(municipio)}|${cp}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const domicilio = pick(row, ["domicilio", "direccion"]);
    const colonia = pick(row, ["colonia"]);
    const address = [domicilio, colonia, cp, municipio, estado]
      .filter(Boolean)
      .join(", ");

    out.push(
      normalise({
        source: "siem" as ScrapeSource,
        sourceId: `siem:${dedupeKey}`,
        name,
        categoryKey: category,
        citySlug,
        phone: cleanSentinel(pick(row, ["telefono", "tel"])),
        email: cleanSentinel(pick(row, ["e_mail", "email", "correo"])),
        address: address || undefined,
        metadata: {
          country: "MX",
          authority: "SIEM",
          scian: scian || undefined,
          giro: giro || undefined,
          estado: estado || undefined,
          municipio: municipio || undefined,
          colonia: colonia || undefined,
          cp: cp || undefined,
          rango_empleados:
            pick(row, ["rango_empleados", "tamano", "per_ocu"]) || undefined,
          registrado_por: pick(row, ["registrado_por"]) || undefined,
        },
      }),
    );
  }

  console.log(
    `[siem] kept=${out.length} dropped_no_category=${droppedNoCategory} dropped_no_city=${droppedNoCity}`,
  );

  if (out.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(out);
  console.log(
    `[siem] done — fetched=${out.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: out.length, inserted, updated, skipped };
}
