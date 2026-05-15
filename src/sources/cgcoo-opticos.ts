import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * CGCOO — Consejo General de Colegios de Ópticos-Optometristas.
 * Ventanilla Única: https://www.ventanillaunicacgcoo.es/.
 *
 * National ES public registry of colegiados ejercientes (optómetras /
 * ópticos), published under Ley 17/2009. The endpoint is plain WP/PHP
 * with a GET form at `/consulta-publica-de-colegiados-ejercientes/`:
 *
 *   ?palabra_clave=&nif=&num_colegiado=&provincia=28
 *    &colegio=&municipio=&cp=&verificado=&pagina=N
 *
 * Each page renders 10 rows under `<li class="FilaEntidades">` with the
 * pattern `<h3>NAME</h3><dl><dt>Número colegiado: NNNN</dt></dl>`. The
 * top of the result block shows "Número de resultados: NNNN".
 *
 * National corpus is ~20k (~3k just for Madrid). We iterate each
 * provincia and walk pages until empty. Address/colegio cells are
 * present but minimal; we capture the colegiado number + name + colegio
 * label from a sibling div when available.
 *
 * Routed to category `medicina` (CategoryKey doesn't have a dedicated
 * óptica/optometría bucket; medicina is the closest healthcare match
 * used by Prolio's existing pharma/medical sources).
 *
 * Off by default; toggle with `PROLIO_RUN_CGCOO_OPTICOS=true`. Total
 * row cap via `PROLIO_CGCOO_OPTICOS_LIMIT` (default 25000). Restrict to
 * specific provincias with `PROLIO_CGCOO_OPTICOS_ONLY=28,8`.
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const BASE = "https://www.ventanillaunicacgcoo.es";
const PATH = "/consulta-publica-de-colegiados-ejercientes/";
const REQUEST_DELAY_MS = 1200;
const DEFAULT_LIMIT = 25000;
const MAX_PAGES_PER_PROVINCIA = 500;

interface ProvinciaConfig {
  id: number;
  citySlug: string;
  cityName: string;
}

const PROVINCIAS: ProvinciaConfig[] = [
  { id: 1,  citySlug: "vitoria-gasteiz",         cityName: "Álava" },
  { id: 2,  citySlug: "albacete",                cityName: "Albacete" },
  { id: 3,  citySlug: "alicante",                cityName: "Alicante" },
  { id: 4,  citySlug: "almeria",                 cityName: "Almería" },
  { id: 5,  citySlug: "avila",                   cityName: "Ávila" },
  { id: 6,  citySlug: "badajoz",                 cityName: "Badajoz" },
  { id: 7,  citySlug: "palma-de-mallorca",       cityName: "Baleares" },
  { id: 8,  citySlug: "barcelona",               cityName: "Barcelona" },
  { id: 9,  citySlug: "burgos",                  cityName: "Burgos" },
  { id: 10, citySlug: "caceres",                 cityName: "Cáceres" },
  { id: 11, citySlug: "cadiz",                   cityName: "Cádiz" },
  { id: 12, citySlug: "castellon-de-la-plana",   cityName: "Castellón" },
  { id: 13, citySlug: "ciudad-real",             cityName: "Ciudad Real" },
  { id: 14, citySlug: "cordoba",                 cityName: "Córdoba" },
  { id: 15, citySlug: "a-coruna",                cityName: "A Coruña" },
  { id: 16, citySlug: "cuenca",                  cityName: "Cuenca" },
  { id: 17, citySlug: "girona",                  cityName: "Girona" },
  { id: 18, citySlug: "granada",                 cityName: "Granada" },
  { id: 19, citySlug: "guadalajara-es",          cityName: "Guadalajara" },
  { id: 20, citySlug: "san-sebastian",           cityName: "Gipuzkoa" },
  { id: 21, citySlug: "huelva",                  cityName: "Huelva" },
  { id: 22, citySlug: "huesca",                  cityName: "Huesca" },
  { id: 23, citySlug: "jaen",                    cityName: "Jaén" },
  { id: 24, citySlug: "leon-es",                 cityName: "León" },
  { id: 25, citySlug: "lleida",                  cityName: "Lleida" },
  { id: 26, citySlug: "logrono",                 cityName: "La Rioja" },
  { id: 27, citySlug: "lugo",                    cityName: "Lugo" },
  { id: 28, citySlug: "madrid",                  cityName: "Madrid" },
  { id: 29, citySlug: "malaga",                  cityName: "Málaga" },
  { id: 30, citySlug: "murcia",                  cityName: "Murcia" },
  { id: 31, citySlug: "pamplona",                cityName: "Navarra" },
  { id: 32, citySlug: "ourense",                 cityName: "Ourense" },
  { id: 33, citySlug: "oviedo",                  cityName: "Asturias" },
  { id: 34, citySlug: "palencia",                cityName: "Palencia" },
  { id: 35, citySlug: "las-palmas",              cityName: "Las Palmas" },
  { id: 36, citySlug: "pontevedra",              cityName: "Pontevedra" },
  { id: 37, citySlug: "salamanca",               cityName: "Salamanca" },
  { id: 38, citySlug: "santa-cruz-de-tenerife",  cityName: "Tenerife" },
  { id: 39, citySlug: "santander",               cityName: "Cantabria" },
  { id: 40, citySlug: "segovia",                 cityName: "Segovia" },
  { id: 41, citySlug: "sevilla",                 cityName: "Sevilla" },
  { id: 42, citySlug: "soria",                   cityName: "Soria" },
  { id: 43, citySlug: "tarragona",               cityName: "Tarragona" },
  { id: 44, citySlug: "teruel",                  cityName: "Teruel" },
  { id: 45, citySlug: "toledo",                  cityName: "Toledo" },
  { id: 46, citySlug: "valencia",                cityName: "Valencia" },
  { id: 47, citySlug: "valladolid",              cityName: "Valladolid" },
  { id: 48, citySlug: "bilbao",                  cityName: "Bizkaia" },
  { id: 49, citySlug: "zamora",                  cityName: "Zamora" },
  { id: 50, citySlug: "zaragoza",                cityName: "Zaragoza" },
  { id: 51, citySlug: "ceuta",                   cityName: "Ceuta" },
  { id: 52, citySlug: "melilla",                 cityName: "Melilla" },
];

interface ColegiadoRow {
  num: string;
  name: string;
}

// Each card looks like:
//   <h3> CASANOVA SAEZ REBECA </h3>
//   <dl><dt>Número colegiado: 14349</dt></dl>
const ROW_RE =
  /<h3>\s*([^<]+?)\s*<\/h3>[\s\S]{0,400}?N[úu]mero\s+colegiado:\s*([0-9A-Za-z\-]+)\s*</gi;

const TOTAL_RE = /N[úu]mero\s+de\s+resultados:\s*<\/strong>\s*(\d+)/i;

function parseRows(html: string): { rows: ColegiadoRow[]; total: number } {
  const rows: ColegiadoRow[] = [];
  ROW_RE.lastIndex = 0;
  for (const m of html.matchAll(ROW_RE)) {
    const [, name, num] = m;
    if (name && num) rows.push({ num: num.trim(), name: name.trim() });
  }
  const totalMatch = html.match(TOTAL_RE);
  const total = totalMatch ? Number(totalMatch[1]) : -1;
  return { rows, total };
}

async function fetchPage(
  prov: ProvinciaConfig,
  page: number,
): Promise<{ rows: ColegiadoRow[]; total: number }> {
  const url = new URL(`${BASE}${PATH}`);
  url.searchParams.set("palabra_clave", "");
  url.searchParams.set("nif", "");
  url.searchParams.set("num_colegiado", "");
  url.searchParams.set("provincia", String(prov.id));
  url.searchParams.set("colegio", "");
  url.searchParams.set("municipio", "");
  url.searchParams.set("cp", "");
  url.searchParams.set("verificado", "");
  if (page > 1) url.searchParams.set("pagina", String(page));
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    throw new Error(`cgcoo-opticos prov=${prov.id} p${page} → ${response.status}`);
  }
  const html = await response.text();
  return parseRows(html);
}

function selectProvincias(): ProvinciaConfig[] {
  const only = (process.env.PROLIO_CGCOO_OPTICOS_ONLY || "").trim();
  if (!only) return PROVINCIAS;
  const wanted = new Set(
    only.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)),
  );
  return PROVINCIAS.filter((p) => wanted.has(p.id));
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  const targets = selectProvincias();
  console.log(
    `[cgcoo-opticos] fan-out: ${targets.length}/${PROVINCIAS.length} provincias`,
  );

  outer: for (const prov of targets) {
    let provHits = 0;
    let reportedTotal = -1;
    for (let p = 1; p <= MAX_PAGES_PER_PROVINCIA; p += 1) {
      if (out.length >= limit) break outer;
      let result: { rows: ColegiadoRow[]; total: number };
      try {
        result = await fetchPage(prov, p);
      } catch (e) {
        console.error(`[cgcoo-opticos] ${prov.cityName} p${p}: ${(e as Error).message}`);
        break;
      }
      if (p === 1) reportedTotal = result.total;
      if (result.rows.length === 0) break;
      let added = 0;
      for (const r of result.rows) {
        const key = `${prov.id}:${r.num}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          normalise({
            source: "cgcoo-opticos",
            sourceId: `cgcoo-opticos:${prov.id}:${r.num}`,
            name: toTitleCase(r.name),
            categoryKey: "medicina",
            citySlug: prov.citySlug,
            licenseNumber: r.num,
            metadata: {
              country: "ES",
              authority: "CGCOO",
              provincia: prov.cityName,
              provincia_id: prov.id,
              profession: "optico-optometrista",
              verified_by_authority: true,
            },
          }),
        );
        added += 1;
        provHits += 1;
        if (out.length >= limit) break;
      }
      if (added === 0) break;
      if (p < MAX_PAGES_PER_PROVINCIA) await delay(REQUEST_DELAY_MS);
    }
    console.log(
      `[cgcoo-opticos] prov=${prov.cityName} total=${provHits}` +
        (reportedTotal >= 0 ? ` (reported=${reportedTotal})` : ""),
    );
  }
  return out;
}

export const cgcooOpticosSource: ScraperSource = {
  name: "cgcoo-opticos",
  enabled() {
    return process.env.PROLIO_RUN_CGCOO_OPTICOS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCgcooOpticos(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cgcooOpticosSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const raw = Number(process.env.PROLIO_CGCOO_OPTICOS_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[cgcoo-opticos] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
