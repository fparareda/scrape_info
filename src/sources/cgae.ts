import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * CGAE — Consejo General de la Abogacía Española.
 *
 * Architecture: federation fan-out.
 *
 * The CGAE central buscador (abogacia.es/servicios/abogados/buscador-de-letrados/)
 * historically returned 0 public rows for our UA — most queries went
 * straight to "introduzca criterios" pages, and the few that resolved
 * landed behind a `_form_/data` JS handshake. Inspecting the federation
 * index page (abogacia.es/conocenos/consejo-general/colegios-y-consejos/)
 * confirms what we suspected: the real "Censo de Letrados" data each
 * colegio is forced to publish under Ley 17/2009 (Ventanilla Única) lives
 * on the *provincial* colegio sites, not the CGAE umbrella.
 *
 * So this source becomes a tiny dispatcher: it iterates a registry of the
 * 83 colegios provinciales/autonómicos and, for each one classified as
 * ✅-scrapable, calls a colegio-specific extractor. The first pass focuses
 * on the 8 largest colegios (Madrid ICAM, Barcelona ICAB, Valencia ICAV,
 * Sevilla ICAS, Bilbao, Málaga, Zaragoza, Las Palmas) — together they
 * cover ~60% of Spain's ~150k colegiados.
 *
 * Many colegios reuse one of three off-the-shelf "Censo" CMS templates
 * (Infórmate.es, Web&Apps, Redegal). For those, a single generic extractor
 * works; we only need one bespoke parser per "shape". When a colegio is
 * marked C (login required) or B (captcha), it's left in the registry as
 * documentation but `extractor` is null so the loop skips it cleanly.
 *
 * Off by default; toggle with `PROLIO_RUN_CGAE=true`. Cap with
 * `PROLIO_CGAE_LIMIT_PER_COLEGIO` (default 1000). Filter to specific
 * colegios with `PROLIO_CGAE_ONLY=icam,icab` for debugging.
 *
 * Routed to `extranjeria` (Prolio's lawyer category).
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 2000;
const DEFAULT_LIMIT_PER_COLEGIO = 1000;
const MAX_PAGES = 300;

type ScrapeStatus = "A" | "B" | "C";
//   A = scrapable: public directory, no captcha, paginable
//   B = limited: captcha, JS-only, or partial public results
//   C = closed: login wall / private-only

interface ColegioRow {
  num: string;
  name: string;
}

type Extractor = (
  colegio: ColegioConfig,
  limit: number,
) => Promise<ColegioRow[]>;

interface ColegioConfig {
  slug: string;            // short id (icam, icab, …)
  name: string;            // human label
  citySlug: string;        // seeded city slug for the sink
  cityName: string;        // display
  base: string;            // colegio root URL
  censoPath?: string;      // path to "Censo de Letrados" / buscador
  status: ScrapeStatus;
  /** When null: skip (documentation only). When set: per-colegio fetcher. */
  extractor: Extractor | null;
  /** Free-form notes for the next operator. */
  notes?: string;
}

// ─── Generic HTML row extractors ───────────────────────────────────────────

const ROW_RE_GENERIC =
  /(?:n[º°o]?\s*coleg[^<]*?[:>]\s*|colegiad[oa][^<]*?[:>]\s*)?(\d{3,7})[\s\S]{0,300}?<[^>]+class="[^"]*(?:nombre|name|abogado|letrado|colegiado|apellidos)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

// Some "Censo" templates render as a flat HTML table:
//   <td>12345</td><td>APELLIDO1 APELLIDO2, NOMBRE</td>
const ROW_RE_TABLE =
  /<tr[^>]*>\s*<td[^>]*>\s*(\d{3,7})\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/gi;

function parseRowsLoose(html: string): ColegioRow[] {
  const out: ColegioRow[] = [];
  const seen = new Set<string>();
  for (const re of [ROW_RE_TABLE, ROW_RE_GENERIC]) {
    re.lastIndex = 0;
    for (const m of html.matchAll(re)) {
      const [, num, name] = m;
      if (!num || !name) continue;
      if (seen.has(num)) continue;
      seen.add(num);
      out.push({ num, name: name.trim() });
    }
    if (out.length > 0) break; // first regex that matched wins
  }
  return out;
}

async function fetchHtml(url: URL | string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${typeof url === "string" ? url : url.pathname} → ${response.status}`);
  }
  return response.text();
}

/**
 * Generic paginated extractor — works against any colegio that publishes
 * a "Censo de Letrados" with ?page=N pagination and either a table-shaped
 * or class-tagged HTML response. About half of the major colegios use a
 * stock template that matches this.
 */
const genericPaginatedExtractor: Extractor = async (colegio, limit) => {
  const out: ColegioRow[] = [];
  const seen = new Set<string>();
  if (!colegio.censoPath) return out;
  for (let p = 1; p <= MAX_PAGES; p += 1) {
    if (out.length >= limit) break;
    const url = new URL(`${colegio.base}${colegio.censoPath}`);
    if (p > 1) url.searchParams.set("page", String(p));
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      console.error(`[cgae] ${colegio.slug} p${p} fetch: ${(e as Error).message}`);
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
    if (p < MAX_PAGES) await delay(REQUEST_DELAY_MS);
  }
  return out;
};

// ─── Registry of the 83 colegios ───────────────────────────────────────────
//
// Status assignments are a *first pass* based on what abogacia.es lists +
// known characteristics of each colegio's web platform. Each one needs a
// follow-up sanity check on real HTML before we trust the row counts.
// When an extractor is null, the row stays for documentation; the runner
// silently skips it.

const COLEGIOS: ColegioConfig[] = [
  // ── A: scrapable, large colegios (focus of first pass) ────────────────
  {
    slug: "icam",
    name: "Ilustre Colegio de la Abogacía de Madrid",
    citySlug: "madrid",
    cityName: "Madrid",
    base: "https://web.icam.es",
    censoPath: "/censo-letrados/",
    status: "A",
    extractor: genericPaginatedExtractor,
    notes: "Largest colegio (~80k). Public Censo by Ley 17/2009.",
  },
  {
    slug: "icab",
    name: "Il·lustre Col·legi de l'Advocacia de Barcelona",
    citySlug: "barcelona",
    cityName: "Barcelona",
    base: "https://www.icab.cat",
    censoPath: "/es/profesionales/censo-de-abogados/",
    status: "A",
    extractor: genericPaginatedExtractor,
    notes: "~25k. Bilingual site; /es and /ca variants both work.",
  },
  {
    slug: "icav",
    name: "Ilustre Colegio de Abogados de Valencia",
    citySlug: "valencia",
    cityName: "Valencia",
    base: "https://www.icav.es",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
    notes: "~11k.",
  },
  {
    slug: "icas",
    name: "Ilustre Colegio de Abogados de Sevilla",
    citySlug: "sevilla",
    cityName: "Sevilla",
    base: "https://www.icas.es",
    censoPath: "/censo-letrados/",
    status: "A",
    extractor: genericPaginatedExtractor,
    notes: "~8k.",
  },
  {
    slug: "icasv",
    name: "Ilustre Colegio de la Abogacía de Bizkaia",
    citySlug: "bilbao",
    cityName: "Bilbao",
    base: "https://www.icasv-bilbao.com",
    censoPath: "/cms/Censo-de-letrados/index.html",
    status: "A",
    extractor: genericPaginatedExtractor,
    notes: "~5k. Confirmed public Censo.",
  },
  {
    slug: "icamalaga",
    name: "Ilustre Colegio de Abogados de Málaga",
    citySlug: "malaga",
    cityName: "Málaga",
    base: "https://www.icamalaga.org",
    censoPath: "/site/index.php?option=com_letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
    notes: "~6k. Joomla com_letrados component.",
  },
  {
    slug: "reicaz",
    name: "Real e Ilustre Colegio de Abogados de Zaragoza",
    citySlug: "zaragoza",
    cityName: "Zaragoza",
    base: "https://www.reicaz.es",
    censoPath: "/index.php/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
    notes: "~3.5k.",
  },
  {
    slug: "icalpa",
    name: "Ilustre Colegio de Abogados de Las Palmas",
    citySlug: "las-palmas",
    cityName: "Las Palmas",
    base: "https://www.icalpa.es",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
    notes: "~3.5k.",
  },

  // ── A: scrapable, medium colegios ────────────────────────────────────
  {
    slug: "icaalicante",
    name: "Ilustre Colegio de Abogados de Alicante",
    citySlug: "alicante",
    cityName: "Alicante",
    base: "https://www.icali.es",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },
  {
    slug: "icava",
    name: "Ilustre Colegio de Abogados de Valladolid",
    citySlug: "valladolid",
    cityName: "Valladolid",
    base: "https://www.icava.org",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },
  {
    slug: "icamur",
    name: "Ilustre Colegio de Abogados de Murcia",
    citySlug: "murcia",
    cityName: "Murcia",
    base: "https://www.icamur.org",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },
  {
    slug: "icapalma",
    name: "Il·lustre Col·legi de l'Advocacia de les Illes Balears",
    citySlug: "palma-de-mallorca",
    cityName: "Palma de Mallorca",
    base: "https://www.icaib.org",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },
  {
    slug: "icaoviedo",
    name: "Ilustre Colegio de Abogados de Oviedo",
    citySlug: "oviedo",
    cityName: "Oviedo",
    base: "https://www.icaoviedo.es",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },
  {
    slug: "icasal",
    name: "Ilustre Colegio de Abogados de Cantabria",
    citySlug: "santander",
    cityName: "Santander",
    base: "https://www.icacantabria.com",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },
  {
    slug: "icaco",
    name: "Ilustre Colegio de Abogados de A Coruña",
    citySlug: "a-coruna",
    cityName: "A Coruña",
    base: "https://www.icacoruna.es",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },
  {
    slug: "icavigo",
    name: "Ilustre Colegio de Abogados de Vigo",
    citySlug: "vigo",
    cityName: "Vigo",
    base: "https://www.icavigo.org",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },
  {
    slug: "icagranada",
    name: "Ilustre Colegio de Abogados de Granada",
    citySlug: "granada",
    cityName: "Granada",
    base: "https://www.icagr.es",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },
  {
    slug: "icacordoba",
    name: "Ilustre Colegio de Abogados de Córdoba",
    citySlug: "cordoba",
    cityName: "Córdoba",
    base: "https://www.icacordoba.es",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },
  {
    slug: "icasantacruz",
    name: "Ilustre Colegio de Abogados de Santa Cruz de Tenerife",
    citySlug: "santa-cruz-de-tenerife",
    cityName: "Santa Cruz de Tenerife",
    base: "https://www.icatf.es",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },
  {
    slug: "icapamplona",
    name: "Ilustre Colegio de Abogados de Pamplona",
    citySlug: "pamplona",
    cityName: "Pamplona",
    base: "https://www.micap.es",
    censoPath: "/censo-letrados",
    status: "A",
    extractor: genericPaginatedExtractor,
  },

  // ── B: limited (captcha / JS-only / partial) — left disabled ──────────
  // These return HTML but require either solving a captcha or executing
  // JS to obtain rows. Flagged for later headless-browser pass.
  { slug: "icalbacete", name: "Albacete", citySlug: "albacete", cityName: "Albacete", base: "https://www.icalbacete.com", status: "B", extractor: null, notes: "captcha" },
  { slug: "icalmeria", name: "Almería", citySlug: "almeria", cityName: "Almería", base: "https://www.icalmeria.com", status: "B", extractor: null },
  { slug: "icavila", name: "Ávila", citySlug: "avila", cityName: "Ávila", base: "https://www.icavila.com", status: "B", extractor: null },
  { slug: "icabadajoz", name: "Badajoz", citySlug: "badajoz", cityName: "Badajoz", base: "https://www.icabadajoz.es", status: "B", extractor: null },
  { slug: "icaburgos", name: "Burgos", citySlug: "burgos", cityName: "Burgos", base: "https://www.icaburgos.com", status: "B", extractor: null },
  { slug: "icacaceres", name: "Cáceres", citySlug: "caceres", cityName: "Cáceres", base: "https://www.abogacia-caceres.com", status: "B", extractor: null },
  { slug: "icacadiz", name: "Cádiz", citySlug: "cadiz", cityName: "Cádiz", base: "https://www.icadiz.com", status: "B", extractor: null },
  { slug: "icacastellon", name: "Castellón", citySlug: "castellon-de-la-plana", cityName: "Castellón", base: "https://www.icacs.com", status: "B", extractor: null },
  { slug: "icacr", name: "Ciudad Real", citySlug: "ciudad-real", cityName: "Ciudad Real", base: "https://www.icacr.es", status: "B", extractor: null },
  { slug: "icacuenca", name: "Cuenca", citySlug: "cuenca", cityName: "Cuenca", base: "https://www.abogadosdecuenca.com", status: "B", extractor: null },
  { slug: "icag", name: "Girona", citySlug: "girona", cityName: "Girona", base: "https://www.icag.es", status: "B", extractor: null },
  { slug: "icagu", name: "Guadalajara", citySlug: "guadalajara-es", cityName: "Guadalajara", base: "https://www.icagu.es", status: "B", extractor: null },
  { slug: "icasgi", name: "Gipuzkoa", citySlug: "san-sebastian", cityName: "San Sebastián", base: "https://www.icagi.net", status: "B", extractor: null },
  { slug: "icahuelva", name: "Huelva", citySlug: "huelva", cityName: "Huelva", base: "https://www.icahuelva.es", status: "B", extractor: null },
  { slug: "icahuesca", name: "Huesca", citySlug: "huesca", cityName: "Huesca", base: "https://www.icahuesca.es", status: "B", extractor: null },
  { slug: "icajaen", name: "Jaén", citySlug: "jaen", cityName: "Jaén", base: "https://www.icajaen.es", status: "B", extractor: null },
  { slug: "icajerez", name: "Jerez de la Frontera", citySlug: "jerez-de-la-frontera", cityName: "Jerez", base: "https://www.icajerez.org", status: "B", extractor: null },
  { slug: "icaleon", name: "León", citySlug: "leon-es", cityName: "León", base: "https://www.icaleon.com", status: "B", extractor: null },
  { slug: "icalleida", name: "Lleida", citySlug: "lleida", cityName: "Lleida", base: "https://www.advocatslleida.org", status: "B", extractor: null },
  { slug: "icalogrono", name: "La Rioja", citySlug: "logrono", cityName: "Logroño", base: "https://www.icalrioja.com", status: "B", extractor: null },
  { slug: "icalugo", name: "Lugo", citySlug: "lugo", cityName: "Lugo", base: "https://www.icalugo.com", status: "B", extractor: null },
  { slug: "icaalcala", name: "Alcalá de Henares", citySlug: "alcala-de-henares", cityName: "Alcalá de Henares", base: "https://www.icaah.es", status: "B", extractor: null },
  { slug: "icaorense", name: "Ourense", citySlug: "ourense", cityName: "Ourense", base: "https://www.icaourense.com", status: "B", extractor: null },
  { slug: "icapontevedra", name: "Pontevedra", citySlug: "pontevedra", cityName: "Pontevedra", base: "https://www.icapontevedra.com", status: "B", extractor: null },
  { slug: "icasalamanca", name: "Salamanca", citySlug: "salamanca", cityName: "Salamanca", base: "https://www.icasal.com", status: "B", extractor: null },
  { slug: "icasegovia", name: "Segovia", citySlug: "segovia", cityName: "Segovia", base: "https://www.icasegovia.com", status: "B", extractor: null },
  { slug: "icasoria", name: "Soria", citySlug: "soria", cityName: "Soria", base: "https://www.icasoria.es", status: "B", extractor: null },
  { slug: "icatarragona", name: "Tarragona", citySlug: "tarragona", cityName: "Tarragona", base: "https://www.icatarragona.com", status: "B", extractor: null },
  { slug: "icateruel", name: "Teruel", citySlug: "teruel", cityName: "Teruel", base: "https://www.icateruel.com", status: "B", extractor: null },
  { slug: "icatoledo", name: "Toledo", citySlug: "toledo", cityName: "Toledo", base: "https://www.icatoledo.com", status: "B", extractor: null },
  { slug: "icava-alava", name: "Álava", citySlug: "vitoria-gasteiz", cityName: "Vitoria", base: "https://www.icaalava.com", status: "B", extractor: null },
  { slug: "icazamora", name: "Zamora", citySlug: "zamora", cityName: "Zamora", base: "https://www.icazamora.com", status: "B", extractor: null },
  { slug: "icamotril", name: "Antequera", citySlug: "antequera", cityName: "Antequera", base: "https://www.icaantequera.com", status: "B", extractor: null },
  { slug: "icalucena", name: "Lucena", citySlug: "lucena", cityName: "Lucena", base: "https://www.icalucena.com", status: "B", extractor: null },
  { slug: "icaelche", name: "Elche", citySlug: "elche", cityName: "Elche", base: "https://www.icae.es", status: "B", extractor: null },
  { slug: "icaalcoy", name: "Alcoy", citySlug: "alcoi", cityName: "Alcoi", base: "https://www.icalcoy.com", status: "B", extractor: null },
  { slug: "icasabadell", name: "Sabadell", citySlug: "sabadell", cityName: "Sabadell", base: "https://www.icasbd.org", status: "B", extractor: null },
  { slug: "icaterrassa", name: "Terrassa", citySlug: "terrassa", cityName: "Terrassa", base: "https://www.icaterrassa.com", status: "B", extractor: null },
  { slug: "icamataro", name: "Mataró", citySlug: "mataro", cityName: "Mataró", base: "https://www.icamat.org", status: "B", extractor: null },
  { slug: "icamanresa", name: "Manresa", citySlug: "manresa", cityName: "Manresa", base: "https://www.icamanresa.cat", status: "B", extractor: null },
  { slug: "icavic", name: "Vic", citySlug: "vic", cityName: "Vic", base: "https://www.icavic.com", status: "B", extractor: null },
  { slug: "icareus", name: "Reus", citySlug: "reus", cityName: "Reus", base: "https://www.icar.cat", status: "B", extractor: null },
  { slug: "icatortosa", name: "Tortosa", citySlug: "tortosa", cityName: "Tortosa", base: "https://www.advocatstortosa.com", status: "B", extractor: null },
  { slug: "icafigueres", name: "Figueres", citySlug: "figueres", cityName: "Figueres", base: "https://www.icaf.cat", status: "B", extractor: null },
  { slug: "icaolot", name: "Olot", citySlug: "olot", cityName: "Olot", base: "https://www.icaolot.com", status: "B", extractor: null },
  { slug: "icamenorca", name: "Menorca", citySlug: "mao", cityName: "Maó", base: "https://www.icamenorca.org", status: "B", extractor: null },
  { slug: "icaibiza", name: "Eivissa-Formentera", citySlug: "ibiza", cityName: "Eivissa", base: "https://www.icaeivissa.com", status: "B", extractor: null },
  { slug: "icalanzarote", name: "Lanzarote", citySlug: "arrecife", cityName: "Arrecife", base: "https://www.icalanzarote.com", status: "B", extractor: null },
  { slug: "icalapalma", name: "La Palma", citySlug: "santa-cruz-de-la-palma", cityName: "Santa Cruz de La Palma", base: "https://www.icalp.es", status: "B", extractor: null },
  { slug: "icamelilla", name: "Melilla", citySlug: "melilla", cityName: "Melilla", base: "https://www.icamelilla.es", status: "B", extractor: null },
  { slug: "icaceuta", name: "Ceuta", citySlug: "ceuta", cityName: "Ceuta", base: "https://www.icaceuta.com", status: "B", extractor: null },
  { slug: "icapalencia", name: "Palencia", citySlug: "palencia", cityName: "Palencia", base: "https://www.icapalencia.com", status: "B", extractor: null },

  // ── C: closed (login wall) — documented only ──────────────────────────
  { slug: "icasf", name: "Santiago de Compostela", citySlug: "santiago-de-compostela", cityName: "Santiago", base: "https://www.icasantiago.org", status: "C", extractor: null, notes: "login required" },
  { slug: "icaorihuela", name: "Orihuela", citySlug: "orihuela", cityName: "Orihuela", base: "https://www.icaorihuela.com", status: "C", extractor: null },
  { slug: "icasueca", name: "Sueca", citySlug: "sueca", cityName: "Sueca", base: "https://www.icasueca.es", status: "C", extractor: null },
  { slug: "icaalzira", name: "Alzira", citySlug: "alzira", cityName: "Alzira", base: "https://www.icaalzira.com", status: "C", extractor: null },
];

// ─── Runner ───────────────────────────────────────────────────────────────

function selectColegios(): ColegioConfig[] {
  const only = (process.env.PROLIO_CGAE_ONLY || "").trim();
  if (only) {
    const wanted = new Set(only.split(",").map((s) => s.trim().toLowerCase()));
    return COLEGIOS.filter((c) => wanted.has(c.slug));
  }
  return COLEGIOS.filter((c) => c.status === "A" && c.extractor !== null);
}

async function fetchAll(limitPerColegio: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const targets = selectColegios();
  console.log(
    `[cgae] fan-out: ${targets.length}/${COLEGIOS.length} colegios in scope ` +
      `(A=${COLEGIOS.filter((c) => c.status === "A").length}, ` +
      `B=${COLEGIOS.filter((c) => c.status === "B").length}, ` +
      `C=${COLEGIOS.filter((c) => c.status === "C").length})`,
  );

  for (const colegio of targets) {
    if (!colegio.extractor) continue;
    let rows: ColegioRow[] = [];
    try {
      rows = await colegio.extractor(colegio, limitPerColegio);
    } catch (error) {
      console.error(
        `[cgae] ${colegio.slug} extractor failed: ${(error as Error).message}`,
      );
      rows = [];
    }
    for (const r of rows) {
      out.push(
        normalise({
          source: "colegio",
          country: "ES",
          sourceId: `cgae:${colegio.slug}:${r.num}`,
          name: toTitleCase(r.name),
          categoryKey: "extranjeria",
          citySlug: colegio.citySlug,
          licenseNumber: r.num,
          metadata: {
            country: "ES",
            authority: "CGAE",
            colegio: colegio.slug.toUpperCase(),
            colegio_name: colegio.name,
            verified_by_authority: true,
          },
        }),
      );
    }
    console.log(`[cgae] ${colegio.slug} (${colegio.cityName}) → ${rows.length} rows`);
    // Inter-colegio politeness pause.
    if (rows.length > 0) await delay(REQUEST_DELAY_MS);
  }
  return out;
}

export const cgaeSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_CGAE === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCgae(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cgaeSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_CGAE_LIMIT_PER_COLEGIO ?? DEFAULT_LIMIT_PER_COLEGIO,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? rawLimit
      : DEFAULT_LIMIT_PER_COLEGIO;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[cgae] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
