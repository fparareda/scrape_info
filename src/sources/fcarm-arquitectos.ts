import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * FCARM — Federación de Colegios de Arquitectos de la República
 * Mexicana.
 *
 *   https://fcarm.org.mx/colegios/
 *
 * Patrón "federación → colegios estatales" (análogo a CSCAE/ES en
 * src/sources/cscae.ts). La federación lista ~75 colegios estatales
 * y regionales repartidos en 7 regiones (mucho más fragmentada que
 * la red española: muchos colegios son por municipio o microregión).
 *
 * Realidad (auditada 2026-05-13, ver tabla al final del fichero):
 *   - La gran mayoría de colegios MX NO publican padrón público.
 *     CDMX (CAM-SAM), Jalisco, Nuevo León y Edomex — los 4 originales
 *     del seed — están todos en "sitio en construcción" o sin
 *     directorio público (clase B/C/E).
 *   - Sólo dos colegios publican padrones completos navegables sin
 *     login: Hermosillo (CACH, ~118 asociados activos + DROs) y
 *     Reynosa (CAR, ~38 DROs + 3 miembros certificados).
 *   - Varios más (~10) tienen menú "Directorio" que devuelve "#" o
 *     requiere login → no scrapables sin credenciales.
 *
 * Estrategia v2:
 *   - SEED_COLEGIOS contiene los ~75 colegios con URL oficial cuando
 *     se conoce, marcados por estado de acceso. Los de tipo "A" se
 *     procesan con un extractor adecuado (genérico o custom).
 *   - Los de tipo B/C/D/E se mantienen en la tabla como referencia
 *     para revisión periódica pero NO se golpean en runtime.
 *
 * Off by default. `PROLIO_RUN_FCARM_ARQUITECTOS=true`.
 * Cap with `PROLIO_FCARM_ARQUITECTOS_LIMIT` (default 1000).
 */

const BASE_URL =
  process.env.PROLIO_FCARM_ARQUITECTOS_URL ||
  "https://fcarm.org.mx/colegios/";
const DEFAULT_LIMIT = 1_000;
const POLITE_UA =
  "Mozilla/5.0 (compatible; ProlioBot/1.0; +https://prolio.co/bot)";
const CATEGORY: CategoryKey = "arquitecto";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type AccessClass = "A" | "B" | "C" | "D" | "E";

interface ColegioEntry {
  /** Display name as listed by FCARM. */
  name: string;
  /** State or region — informational, kept in metadata.raw_state. */
  state: string;
  /** Best-known public URL. Empty string if FCARM did not link one. */
  url: string;
  /** Mapping to a seeded city in src/cities.ts. */
  citySlug: string;
  /**
   * Access classification (see header):
   *   A · scrapable padrón público
   *   B · solo junta directiva / no member list
   *   C · login requerido
   *   D · cloudflare / captcha / TLS broken
   *   E · 404 / sitio en construcción / sin web
   */
  access: AccessClass;
  /**
   * If access==='A', optional URL of the actual directory page within
   * the site (the URL field is the homepage). The extractor will
   * fetch this URL instead of the homepage.
   */
  directoryUrl?: string;
  /**
   * Custom extractor key. If unset and access==='A' the generic
   * extractMembersGeneric is used.
   */
  extractor?: "hermosillo" | "reynosa";
}

/**
 * Full registry of FCARM member colegios (~75 entries). The `citySlug`
 * column maps to entries already seeded in src/cities.ts; for cities
 * without a dedicated slug we fall back to the state capital (the
 * actual location is preserved in metadata.raw_state). New citySlugs
 * MUST be added to src/cities.ts before being referenced here, but to
 * avoid bloating cities.ts for one-off colegios we currently route
 * all unseeded locations to the state capital.
 */
const SEED_COLEGIOS: ColegioEntry[] = [
  // REGIÓN I — Central
  { name: "Colegio de Arquitectos de la Ciudad de México AC (CAM-SAM)", state: "Ciudad de México", url: "https://cam-sam.org/", citySlug: "cdmx", access: "E" },
  { name: "Colegio de Arquitectos del Estado de México AC", state: "Estado de México", url: "https://caem.org.mx/", citySlug: "tlalnepantla", access: "D" },
  { name: "Colegio de Arquitectos del Estado de Oaxaca AC", state: "Oaxaca", url: "", citySlug: "cdmx", access: "E" },
  { name: "Colegio de Arquitectos del Estado de Tlaxcala AC", state: "Tlaxcala", url: "", citySlug: "puebla", access: "E" },
  { name: "Colegio de Arquitectos de Guerrero AC", state: "Guerrero", url: "", citySlug: "acapulco", access: "E" },
  { name: "Colegio de Arquitectos de Hidalgo AC", state: "Hidalgo", url: "", citySlug: "cdmx", access: "E" },
  { name: "Colegio de Arquitectos de Morelos AC", state: "Morelos", url: "", citySlug: "cuernavaca", access: "E" },
  { name: "Colegio de Arquitectos de Puebla AC (CAPAC)", state: "Puebla", url: "https://capac.org.mx/", citySlug: "puebla", access: "B" },

  // REGIÓN II — Bajío / Centro
  { name: "Colegio de Arquitectos de Acámbaro, Gto AC", state: "Guanajuato", url: "", citySlug: "leon-mx", access: "E" },
  { name: "Colegio de Arquitectos de Celaya AC", state: "Guanajuato", url: "", citySlug: "leon-mx", access: "E" },
  { name: "Colegio de Arquitectos del Centro del Estado de Michoacán AC", state: "Michoacán", url: "", citySlug: "morelia", access: "E" },
  { name: "Colegio de Arquitectos del Estado de Aguascalientes AC (CAEA)", state: "Aguascalientes", url: "", citySlug: "aguascalientes", access: "E" },
  { name: "Colegio de Arquitectos del Estado de Querétaro AC (CAEQ)", state: "Querétaro", url: "https://caeq.org/", citySlug: "queretaro", access: "B" },
  { name: "Colegio de Arquitectos Guanajuatenses AC", state: "Guanajuato", url: "", citySlug: "leon-mx", access: "E" },
  { name: "Colegio de Arquitectos de la Huasteca Potosina AC", state: "San Luis Potosí", url: "", citySlug: "san-luis-potosi", access: "E" },
  { name: "Colegio de Arquitectos de Irapuato, Gto", state: "Guanajuato", url: "", citySlug: "leon-mx", access: "E" },
  { name: "Colegio de Arquitectos de la Piedad Michoacán AC", state: "Michoacán", url: "", citySlug: "morelia", access: "E" },
  { name: "Colegio de Arquitectos de León AC", state: "Guanajuato", url: "", citySlug: "leon-mx", access: "E" },
  { name: "Colegio de Arquitectos de Michoacán AC", state: "Michoacán", url: "", citySlug: "morelia", access: "E" },
  { name: "Colegio de Arquitectos Moroleón-Uriangato AC", state: "Guanajuato", url: "", citySlug: "leon-mx", access: "E" },
  { name: "Colegio de Arquitectos de Salamanca AC", state: "Guanajuato", url: "", citySlug: "leon-mx", access: "E" },
  { name: "Colegio de Arquitectos de San Luis de la Paz AC", state: "Guanajuato", url: "", citySlug: "leon-mx", access: "E" },
  { name: "Colegio de Arquitectos de San Luis Potosí AC", state: "San Luis Potosí", url: "https://caslp.com.mx/", citySlug: "san-luis-potosi", access: "D" },
  { name: "Colegio de Arquitectos de San Miguel de Allende Gto AC", state: "Guanajuato", url: "", citySlug: "leon-mx", access: "E" },
  { name: "Colegio de Arquitectos de Valle de Santiago AC", state: "Guanajuato", url: "", citySlug: "leon-mx", access: "E" },
  { name: "Colegio de Arquitectos de Zacatecas AC", state: "Zacatecas", url: "", citySlug: "aguascalientes", access: "E" },

  // REGIÓN III — Sureste
  { name: "Colegio de Arquitectos de Campeche AC", state: "Campeche", url: "", citySlug: "merida-mx", access: "E" },
  { name: "Colegio de Arquitectos Cancún AC", state: "Quintana Roo", url: "https://coarqcun.com/", citySlug: "cancun", access: "C" },
  { name: "Colegio de Arquitectos del Carmen AC", state: "Campeche", url: "", citySlug: "merida-mx", access: "E" },
  { name: "Colegio de Arquitectos Chiapanecos AC", state: "Chiapas", url: "https://cachac.org.mx/cachac/", citySlug: "villahermosa", access: "B" },
  { name: "Colegio de Arquitectos de Chiapas AC", state: "Chiapas", url: "", citySlug: "villahermosa", access: "E" },
  { name: "Colegio de Arquitectos de Comitán AC", state: "Chiapas", url: "", citySlug: "villahermosa", access: "E" },
  { name: "Colegio de Arquitectos de Cozumel AC", state: "Quintana Roo", url: "", citySlug: "cancun", access: "E" },
  { name: "Colegio de Arquitectos del Estado de Veracruz Córdoba y Orizaba AC", state: "Veracruz", url: "", citySlug: "veracruz-mx", access: "E" },
  { name: "Colegio de Arquitectos del Puerto de Veracruz AC", state: "Veracruz", url: "", citySlug: "veracruz-mx", access: "E" },
  { name: "Colegio de Arquitectos de Quintana Roo AC", state: "Quintana Roo", url: "http://colegioarquitectosquintanarooac.com.mx/", citySlug: "cancun", access: "B" },
  { name: "Colegio de Arquitectos de la Riviera Maya AC", state: "Quintana Roo", url: "", citySlug: "cancun", access: "E" },
  { name: "Colegio de Arquitectos de Tulum AC", state: "Quintana Roo", url: "", citySlug: "cancun", access: "E" },
  { name: "Colegio de Arquitectos Tabasqueños AC", state: "Tabasco", url: "", citySlug: "villahermosa", access: "E" },
  { name: "Colegio de Arquitectos de Tuxpán y Norte de Veracruz AC", state: "Veracruz", url: "", citySlug: "veracruz-mx", access: "E" },
  { name: "Colegio de Arquitectos CAXEV AC", state: "Veracruz", url: "", citySlug: "veracruz-mx", access: "E" },
  { name: "Colegio Yucateco de Arquitectos AC (CYA)", state: "Yucatán", url: "https://cya.org.mx/", citySlug: "merida-mx", access: "C" },

  // REGIÓN IV — Noreste
  { name: "Colegio de Arquitectos de Chihuahua AC (CACHAC)", state: "Chihuahua", url: "https://cachac.com/", citySlug: "chihuahua", access: "C" },
  { name: "Colegio de Arquitectos de Ciudad Juárez AC", state: "Chihuahua", url: "https://arquitectosjuarez.com/", citySlug: "ciudad-juarez", access: "C" },
  { name: "Colegio de Arquitectos de Coahuila Región Sureste AC", state: "Coahuila", url: "", citySlug: "saltillo", access: "E" },
  { name: "Colegio de Arquitectos de la Comarca Lagunera AC", state: "Coahuila", url: "", citySlug: "torreon", access: "E" },
  { name: "Colegio de Arquitectos de Durango AC", state: "Durango", url: "", citySlug: "torreon", access: "E" },
  { name: "Colegio de Arquitectos de Hidalgo del Parral AC", state: "Chihuahua", url: "", citySlug: "chihuahua", access: "E" },
  { name: "Colegio de Arquitectos del Noreste de Tamaulipas AC", state: "Tamaulipas", url: "", citySlug: "reynosa", access: "E" },
  { name: "Colegio de Arquitectos de Nuevo Laredo AC", state: "Tamaulipas", url: "", citySlug: "reynosa", access: "E" },
  { name: "Colegio de Arquitectos de Nuevo León AC", state: "Nuevo León", url: "http://colegioarquitectosnl.org/", citySlug: "monterrey", access: "B" },
  { name: "Colegio de Arquitectos de Piedras Negras Coahuila AC", state: "Coahuila", url: "", citySlug: "saltillo", access: "E" },
  {
    name: "Colegio de Arquitectos de Reynosa AC (CAR)",
    state: "Tamaulipas",
    url: "https://colegiodearquitectos.mx/",
    citySlug: "reynosa",
    access: "A",
    directoryUrl: "https://colegiodearquitectos.mx/dro-vigentes/",
    extractor: "reynosa",
  },
  { name: "Colegio de Arquitectos del Sur de Tamaulipas AC", state: "Tamaulipas", url: "", citySlug: "tampico", access: "E" },

  // REGIÓN V — Oeste
  { name: "Colegio de Arquitectos de Baja California Sur AC", state: "Baja California Sur", url: "", citySlug: "tijuana", access: "E" },
  { name: "Colegio de Arquitectos del Estado de Colima AC", state: "Colima", url: "", citySlug: "guadalajara", access: "E" },
  { name: "Colegio de Arquitectos del Estado de Jalisco AC", state: "Jalisco", url: "https://www.colegiodearquitectosjalisco.org.mx/", citySlug: "guadalajara", access: "D" },
  { name: "Colegio de Arquitectos del Estado de Nayarit AC", state: "Nayarit", url: "", citySlug: "guadalajara", access: "E" },
  { name: "Colegio de Arquitectos de Guasave AC", state: "Sinaloa", url: "", citySlug: "culiacan", access: "E" },
  { name: "Colegio de Arquitectos de Mazatlán AC", state: "Sinaloa", url: "", citySlug: "mazatlan", access: "E" },
  { name: "Colegio de Arquitectos del Norte de Sinaloa AC", state: "Sinaloa", url: "", citySlug: "culiacan", access: "E" },
  { name: "Colegio de Arquitectos de Puerto Vallarta del Estado de Jalisco AC", state: "Jalisco", url: "", citySlug: "guadalajara", access: "E" },
  { name: "Colegio de Arquitectos de Sinaloa AC", state: "Sinaloa", url: "https://colegiodearquitectosdesinaloa.org/", citySlug: "culiacan", access: "E" },
  { name: "Colegio de Arquitectos del Sur del Estado de Jalisco AC", state: "Jalisco", url: "", citySlug: "guadalajara", access: "E" },

  // REGIÓN VI — Sonora
  { name: "Colegio de Arquitectos de Agua Prieta AC", state: "Sonora", url: "", citySlug: "hermosillo", access: "E" },
  { name: "Colegio de Arquitectos de Caborca AC", state: "Sonora", url: "", citySlug: "hermosillo", access: "E" },
  {
    name: "Colegio de Arquitectos de la Ciudad de Hermosillo AC (CACH)",
    state: "Sonora",
    url: "https://www.arquitectoshermosillo.com.mx/",
    citySlug: "hermosillo",
    access: "A",
    directoryUrl: "https://www.arquitectoshermosillo.com.mx/asociados/",
    extractor: "hermosillo",
  },
  { name: "Colegio de Arquitectos de Ciudad Obregón AC", state: "Sonora", url: "", citySlug: "hermosillo", access: "E" },
  { name: "Colegio de Arquitectos de Nogales AC", state: "Sonora", url: "", citySlug: "hermosillo", access: "E" },
  { name: "Colegio de Arquitectos Rocaportenses AC", state: "Sonora", url: "", citySlug: "hermosillo", access: "E" },
  { name: "Colegio de Arquitectos de San Luis Río Colorado Sonora AC", state: "Sonora", url: "", citySlug: "hermosillo", access: "E" },
  { name: "Colegio de Arquitectos del Sur de Sonora AC", state: "Sonora", url: "", citySlug: "hermosillo", access: "E" },

  // REGIÓN VII — Baja California
  { name: "Colegio de Arquitectos de Ensenada AC", state: "Baja California", url: "", citySlug: "tijuana", access: "E" },
  { name: "Colegio de Arquitectos de Mexicali AC", state: "Baja California", url: "", citySlug: "mexicali", access: "E" },
  { name: "Colegio de Arquitectos de Playas de Rosarito AC", state: "Baja California", url: "", citySlug: "tijuana", access: "E" },
  { name: "Colegio de Arquitectos de Tecate AC", state: "Baja California", url: "", citySlug: "tijuana", access: "E" },
  { name: "Colegio de Arquitectos de Tijuana AC (CATAC)", state: "Baja California", url: "https://catac.mx/", citySlug: "tijuana", access: "B" },
];

async function politeFetch(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/html,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[fcarm-arquitectos] ${res.status} on ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[fcarm-arquitectos] network ${url}: ${(err as Error).message}`);
    return null;
  }
}

interface MemberRow {
  name: string;
  licenseNumber?: string;
  role?: string;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}

function cleanName(raw: string): string {
  return raw
    .replace(/^(?:Arq\.?|Arquitect[oa]\.?|Ing\.?|M\.?\s*Arq\.?|Dr\.?)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hermosillo (CACH) — /asociados/ renders one `<li>` per member with
 * the structure `<p>FirstName Surname</p>...<div>R6-NNNN</div>` (all
 * inline on a single HTML line). We pair each R6 folio with the
 * nearest preceding `<p>...</p>` text.
 *
 * Audited 2026-05-13: 118 R6 folios on the page.
 */
function extractMembersHermosillo(html: string): MemberRow[] {
  const out: MemberRow[] = [];
  const FOLIO_RE = /<p[^>]*>\s*([^<]{4,80})<\/p>\s*<\/div>\s*<div[^>]*>\s*(R6-\d{4})\s*<\/div>/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = FOLIO_RE.exec(html)) !== null) {
    const folio = m[2];
    if (seen.has(folio)) continue;
    seen.add(folio);
    const name = cleanName(stripTags(m[1]));
    if (name.length < 4 || /^(?:Asociados?|Activos?|Folio)$/i.test(name)) continue;
    out.push({ name, licenseNumber: folio });
  }
  // Fallback: looser pattern if the precise structure changes
  if (out.length === 0) {
    const LOOSE = /<p[^>]*>([^<]{4,80})<\/p>[^<]*(?:<[^>]+>[^<]*)*?(R6-\d{4})/g;
    let m2: RegExpExecArray | null;
    while ((m2 = LOOSE.exec(html)) !== null) {
      const folio = m2[2];
      if (seen.has(folio)) continue;
      seen.add(folio);
      const name = cleanName(stripTags(m2[1]));
      if (name.length < 4) continue;
      out.push({ name, licenseNumber: folio });
    }
  }
  return out;
}

/**
 * Reynosa (CAR) — /dro-vigentes/ renders `<li>Surname Name <strong>DRO-SOP/NN</strong>...</li>`.
 * We split on `<li>` and within each chunk pair the inline text up to
 * the first `<strong>` with the DRO-SOP folio.
 *
 * Audited 2026-05-13: 38 DRO-SOP folios on the page.
 */
function extractMembersReynosa(html: string): MemberRow[] {
  const out: MemberRow[] = [];
  const seen = new Set<string>();
  const liChunks = html.split(/<li[^>]*>/i);
  for (const chunk of liChunks) {
    const folioMatch = chunk.match(/<strong[^>]*>\s*(DRO-SOP\/\d{1,3})/i);
    if (!folioMatch) continue;
    const folio = folioMatch[1];
    if (seen.has(folio)) continue;
    // The name precedes the first <strong>; strip tags then trim.
    const beforeStrong = chunk.slice(0, folioMatch.index);
    const name = cleanName(stripTags(beforeStrong).replace(/,\s*$/g, ""));
    if (name.length < 4) continue;
    seen.add(folio);
    out.push({ name, licenseNumber: folio, role: "DRO" });
  }
  return out;
}

/**
 * Generic best-effort extractor — used as a fallback when a colegio
 * is reclassified as "A" but has no custom extractor yet.
 */
function extractMembersGeneric(html: string): MemberRow[] {
  const out: MemberRow[] = [];
  const NAME_RE =
    /<h[234][^>]*>\s*((?:Arq\.?|Arquitect[oa]\.?)\s*[A-ZÁÉÍÓÚÑa-záéíóúñ.\s]{6,80})\s*<\/h[234]>/gi;
  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(html)) !== null) {
    const name = cleanName(m[1]);
    const after = html.slice(m.index, m.index + 300);
    const lic = after.match(/(?:Cédula|Registro|ARC|No\.?)\s*:?\s*([A-Z0-9\-]{3,15})/i);
    out.push({ name, licenseNumber: lic?.[1] });
  }
  return out;
}

function pickExtractor(c: ColegioEntry): (html: string) => MemberRow[] {
  switch (c.extractor) {
    case "hermosillo":
      return extractMembersHermosillo;
    case "reynosa":
      return extractMembersReynosa;
    default:
      return extractMembersGeneric;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];

  // Discovery — verify federation index is reachable (telemetry only).
  const indexHtml = await politeFetch(BASE_URL);
  if (indexHtml) {
    console.log(`[fcarm-arquitectos] index OK (${indexHtml.length} bytes)`);
  } else {
    console.warn(`[fcarm-arquitectos] index unreachable, continuing with seed`);
  }

  const scrapable = SEED_COLEGIOS.filter((c) => c.access === "A");
  console.log(
    `[fcarm-arquitectos] ${SEED_COLEGIOS.length} colegios known, ${scrapable.length} scrapable (A)`,
  );

  for (const colegio of scrapable) {
    if (out.length >= limit) break;
    await sleep(REQUEST_DELAY_MS);
    const url = colegio.directoryUrl ?? colegio.url;
    const html = await politeFetch(url);
    if (!html) continue;
    const extract = pickExtractor(colegio);
    const members = extract(html);
    let added = 0;
    for (const member of members) {
      if (out.length >= limit) break;
      const sidBase = member.licenseNumber
        ? `${colegio.citySlug}:${member.licenseNumber}`
        : `${colegio.citySlug}:${slugify(member.name)}`;
      const sid = `fcarm:${sidBase}`;
      out.push(
        normalise({
          source: "fcarm-arquitectos" as ScrapeSource,
          sourceId: sid,
          name: member.name,
          categoryKey: CATEGORY,
          citySlug: colegio.citySlug,
          licenseNumber: member.licenseNumber,
          website: colegio.url,
          metadata: {
            country: "MX",
            authority: "FCARM",
            verified_by_authority: true,
            colegio_estatal: colegio.name,
            raw_state: colegio.state,
            role: member.role,
            source_url: url,
          },
        }),
      );
      added += 1;
    }
    console.log(
      `[fcarm-arquitectos] colegio=${colegio.citySlug} parsed=${members.length} added=${added}`,
    );
  }

  return out;
}

export const fcarmArquitectosEnabled = (): boolean =>
  process.env.PROLIO_RUN_FCARM_ARQUITECTOS === "true";

export const fcarmArquitectosSource: ScraperSource = {
  name: "fcarm-arquitectos" as ScrapeSource,
  enabled: fcarmArquitectosEnabled,
  async fetch() {
    return [];
  },
};

export async function runFcarmArquitectos(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!fcarmArquitectosEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("fcarm-arquitectos", async () => {
    const rawLimit = Number(
      process.env.PROLIO_FCARM_ARQUITECTOS_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
    const records = await fetchAll(limit);
    if (records.length === 0)
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
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

/**
 * ---------------------------------------------------------------------
 * FCARM colegios — clasificación de acceso (auditoría 2026-05-13)
 * ---------------------------------------------------------------------
 * Leyenda:
 *   A · padrón público scrapable sin login
 *   B · web pública pero sólo junta directiva / sin lista de socios
 *   C · web pública, lista de socios existe pero requiere login
 *   D · Cloudflare / TLS roto / 403 / no responde
 *   E · sin web pública, 404, o "sitio en construcción"
 *
 * Resumen: 75 colegios catalogados · 2 A · 6 B · 4 C · 4 D · 59 E
 *
 * | Región | Colegio                                              | URL                                              | Clase |
 * | ------ | ---------------------------------------------------- | ------------------------------------------------ | ----- |
 * | I      | CAM-SAM (CDMX)                                       | cam-sam.org                                      | E     |
 * | I      | CAEM (Edomex)                                        | caem.org.mx                                      | D     |
 * | I      | Oaxaca                                               | —                                                | E     |
 * | I      | Tlaxcala                                             | —                                                | E     |
 * | I      | Guerrero                                             | —                                                | E     |
 * | I      | Hidalgo                                              | —                                                | E     |
 * | I      | Morelos                                              | —                                                | E     |
 * | I      | CAPAC (Puebla)                                       | capac.org.mx                                     | B     |
 * | II     | Acámbaro Gto                                         | —                                                | E     |
 * | II     | Celaya                                               | —                                                | E     |
 * | II     | Centro Michoacán                                     | —                                                | E     |
 * | II     | CAEA (Aguascalientes)                                | —                                                | E     |
 * | II     | CAEQ (Querétaro)                                     | caeq.org                                         | B     |
 * | II     | Guanajuatenses                                       | —                                                | E     |
 * | II     | Huasteca Potosina                                    | —                                                | E     |
 * | II     | Irapuato                                             | —                                                | E     |
 * | II     | La Piedad Michoacán                                  | —                                                | E     |
 * | II     | León                                                 | —                                                | E     |
 * | II     | Michoacán                                            | —                                                | E     |
 * | II     | Moroleón-Uriangato                                   | —                                                | E     |
 * | II     | Salamanca                                            | —                                                | E     |
 * | II     | San Luis de la Paz                                   | —                                                | E     |
 * | II     | CASLP (San Luis Potosí)                              | caslp.com.mx                                     | D     |
 * | II     | San Miguel de Allende                                | —                                                | E     |
 * | II     | Valle de Santiago                                    | —                                                | E     |
 * | II     | Zacatecas                                            | —                                                | E     |
 * | III    | Campeche                                             | —                                                | E     |
 * | III    | Cancún (COARQCUN)                                    | coarqcun.com                                     | C     |
 * | III    | Carmen                                               | —                                                | E     |
 * | III    | Chiapanecos                                          | cachac.org.mx/cachac                             | B     |
 * | III    | Chiapas                                              | —                                                | E     |
 * | III    | Comitán                                              | —                                                | E     |
 * | III    | Cozumel                                              | —                                                | E     |
 * | III    | Veracruz Córdoba/Orizaba                             | —                                                | E     |
 * | III    | Puerto de Veracruz                                   | —                                                | E     |
 * | III    | Quintana Roo                                         | colegioarquitectosquintanarooac.com.mx           | B     |
 * | III    | Riviera Maya                                         | —                                                | E     |
 * | III    | Tulum                                                | —                                                | E     |
 * | III    | Tabasqueños                                          | —                                                | E     |
 * | III    | Tuxpán y Norte Veracruz                              | —                                                | E     |
 * | III    | CAXEV                                                | —                                                | E     |
 * | III    | CYA (Yucatán)                                        | cya.org.mx                                       | C     |
 * | IV     | CACHAC (Chihuahua)                                   | cachac.com                                       | C     |
 * | IV     | Cd Juárez                                            | arquitectosjuarez.com                            | C     |
 * | IV     | Coahuila Sureste                                     | —                                                | E     |
 * | IV     | Comarca Lagunera                                     | —                                                | E     |
 * | IV     | Durango                                              | —                                                | E     |
 * | IV     | Hidalgo del Parral                                   | —                                                | E     |
 * | IV     | Noreste Tamaulipas                                   | —                                                | E     |
 * | IV     | Nuevo Laredo                                         | —                                                | E     |
 * | IV     | Nuevo León                                           | colegioarquitectosnl.org                         | B     |
 * | IV     | Piedras Negras                                       | —                                                | E     |
 * | IV     | **CAR (Reynosa)**                                    | **colegiodearquitectos.mx/dro-vigentes**         | **A** |
 * | IV     | Sur Tamaulipas                                       | —                                                | E     |
 * | V      | BCS                                                  | —                                                | E     |
 * | V      | Colima                                               | —                                                | E     |
 * | V      | Jalisco                                              | colegiodearquitectosjalisco.org.mx               | D     |
 * | V      | Nayarit                                              | —                                                | E     |
 * | V      | Guasave                                              | —                                                | E     |
 * | V      | Mazatlán                                             | —                                                | E     |
 * | V      | Norte Sinaloa                                        | —                                                | E     |
 * | V      | Puerto Vallarta                                      | —                                                | E     |
 * | V      | Sinaloa                                              | colegiodearquitectosdesinaloa.org                | E     |
 * | V      | Sur Jalisco                                          | —                                                | E     |
 * | VI     | Agua Prieta                                          | —                                                | E     |
 * | VI     | Caborca                                              | —                                                | E     |
 * | VI     | **CACH (Hermosillo)**                                | **arquitectoshermosillo.com.mx/asociados**       | **A** |
 * | VI     | Cd Obregón                                           | —                                                | E     |
 * | VI     | Nogales                                              | —                                                | E     |
 * | VI     | Rocaportenses                                        | —                                                | E     |
 * | VI     | SLRC Sonora                                          | —                                                | E     |
 * | VI     | Sur Sonora                                           | —                                                | E     |
 * | VII    | Ensenada                                             | —                                                | E     |
 * | VII    | Mexicali                                             | —                                                | E     |
 * | VII    | Playas Rosarito                                      | —                                                | E     |
 * | VII    | Tecate                                               | —                                                | E     |
 * | VII    | CATAC (Tijuana)                                      | catac.mx                                         | B     |
 *
 * Volumen alcanzable hoy (suma de los dos "A"):
 *   - CACH Hermosillo: ~118 asociados activos R6 + DROs municipales.
 *   - CAR Reynosa: ~38 DROs DRO-SOP/NN + 3 miembros certificados.
 *   - Total estimado: ~160 profesionales con cédula colegiada
 *     verificable.
 *
 * Blockers para crecer:
 *   - 4 colegios "C" (Cancún, Yucatán, Chihuahua, Cd Juárez) tienen
 *     padrones reales tras login. Sin credenciales, no scrapables.
 *   - 4 colegios "D" (Edomex, San Luis Potosí, Jalisco) — TLS roto o
 *     bloqueo Cloudflare; reintentar trimestralmente.
 *   - 6 colegios "B" tienen web pero sólo junta directiva. Para estos
 *     vale la pena emitir la *junta directiva* (5-15 personas/colegio)
 *     como fallback, queda como TODO.
 *   - Los ~59 "E" probablemente nunca tendrán scraping vía web
 *     pública; alternativa real es Google Places o registros estatales
 *     de DROs municipales (cada estado mexicano publica su propia
 *     lista de DROs autorizados — fuente separada, fuera de FCARM).
 */
