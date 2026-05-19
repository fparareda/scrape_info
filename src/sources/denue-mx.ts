import { inflateRawSync } from "node:zlib";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getCities } from "../cities.js";
import { getSink } from "../sink.js";
import { parseCsv, pick } from "./_bulk-utils.js";

/**
 * DENUE — Directorio Estadístico Nacional de Unidades Económicas
 * (INEGI). The single biggest open MX source: ~5M businesses with
 * name, address, phone, email (when registered), SCIAN code,
 * municipality, geolocation. License: free reuse per INEGI's open
 * data terms.
 *
 * Distribution: per-SCIAN-sector ZIP archives at
 * https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_<sector>_csv.zip
 * Each archive bundles a `diccionario_de_datos/...csv` (schema doc)
 * plus the actual data file `conjunto_de_datos/denue_inegi_<sector>.csv`.
 * Files use Latin-1; we decode and re-emit as UTF-8.
 *
 * SCIAN sector → Prolio category map:
 *   23 (Construcción)  → electricidad/fontaneria/carpinteria/hvac
 *   54 (Servicios profesionales) → fiscal/extranjeria/notario/arquitecto
 *   56 (Servicios administrativos) → cerrajero
 *   62 (Servicios de salud)        → medicina/dentista/psicologia/fisioterapia
 *
 * Sector 81 (mecánica + veterinarios) is intentionally OFF for v1 —
 * those archives are 80+ MB combined and SENASICA already covers
 * authorised vets. Add later if yield demands it.
 *
 * Off by default. `PROLIO_RUN_DENUE_MX=true` enables. Cap with
 * `PROLIO_DENUE_MX_LIMIT` (default 10000 across all sectors). On a
 * full run all four archives total ~45 MB compressed / ~150 MB CSV.
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const DEFAULT_LIMIT = 10_000;

interface DenueSector {
  url: string;
  /** Short label for logs. */
  label: string;
}

const DENUE_SECTORS: DenueSector[] = [
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_23_csv.zip",
    label: "23-construccion",
  },
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_54_csv.zip",
    label: "54-servicios-profesionales",
  },
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_56_csv.zip",
    label: "56-servicios-administrativos",
  },
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_62_csv.zip",
    label: "62-servicios-salud",
  },
  // Sector 81 (Otros servicios) split in two due to size — added 2026-05-07.
  // Carries 811111 (mecánica), 811211 (electrónica), 811219 (otros).
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_81_1_csv.zip",
    label: "81-1-otros-servicios-parte-1",
  },
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_81_2_csv.zip",
    label: "81-2-otros-servicios-parte-2",
  },
  // Sector 48-49 (Transporte) — carries 488410 (centros de verificación
  // vehicular = ITV equivalent en MX).
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_48-49_csv.zip",
    label: "48-49-transporte",
  },
];

/**
 * SCIAN 2018 (MX) 6-digit codes → Prolio category. The DENUE CSV
 * carries `codigo_act` as a 6-digit string. Matching is exact —
 * unmapped codes are dropped.
 */
const SCIAN_TO_CATEGORY: Record<string, CategoryKey> = {
  // Sector 23 — Construcción
  "238210": "electricidad",   // Instalaciones eléctricas en construcciones
  "238221": "fontaneria",      // Plomería en construcciones
  "238222": "fontaneria",      // Aire acondicionado y calefacción (lumped — closest to fontaneria/hvac)
  "238223": "fontaneria",      // Otras instalaciones especializadas para edificios
  "238350": "carpinteria",     // Trabajos de carpintería en construcciones

  // Sector 54 — Servicios profesionales, científicos y técnicos
  // Bufetes jurídicos and other legal services map to `abogado` — the
  // dedicated extranjería sub-specialty is rarely SCIAN-coded, so we
  // emit the parent category and let category-specific scrapers
  // (immigration bars, CGE) handle the niche.
  "541110": "abogado",         // Bufetes jurídicos
  "541120": "notario",         // Notarías públicas
  "541190": "abogado",         // Otros servicios legales
  "541211": "fiscal",          // Servicios de contabilidad y auditoría
  "541219": "fiscal",          // Otros servicios relacionados con contabilidad
  "541310": "arquitecto",      // Servicios de arquitectura
  "541320": "arquitecto",      // Servicios de arquitectura del paisaje y urbanismo
  "541940": "veterinario",     // Servicios veterinarios

  // Sector 56 — Servicios de apoyo a los negocios
  "561621": "cerrajero",       // Servicios de cerrajería

  // Sector 62 — Servicios de salud
  "621111": "medicina",        // Consultorios de medicina general
  "621112": "medicina",        // Consultorios de especialistas en medicina interna
  "621113": "medicina",        // Consultorios de especialistas en pediatría
  "621114": "medicina",        // Consultorios de especialistas en gineco-obstetricia
  "621115": "medicina",        // Consultorios de especialistas en cardiología
  "621116": "medicina",        // Consultorios de especialistas en oftalmología
  "621117": "medicina",        // Consultorios de especialistas en otorrinolaringología
  "621118": "medicina",        // Consultorios de especialistas en traumatología/ortopedia
  "621119": "medicina",        // Consultorios de otros especialistas
  "621211": "dentista",        // Consultorios dentales del sector privado
  "621212": "dentista",        // Consultorios dentales del sector público
  "621331": "psicologia",      // Consultorios de psicólogos
  "621398": "fisioterapia",    // Consultorios de otros profesionales de la salud (incl. fisio)
  "621399": "fisioterapia",    // (alt code in some SCIAN revisions)

  // Sector 81 — Otros servicios (added 2026-05-07)
  "811111": "mecanica",        // Reparación mecánica en general de automóviles y camiones
  "811112": "mecanica",        // Reparación del sistema eléctrico de automóviles y camiones
  "811113": "mecanica",        // Rectificación de partes de motor de automóviles y camiones
  "811114": "mecanica",        // Reparación de transmisiones de automóviles y camiones
  "811115": "mecanica",        // Reparación de suspensiones de automóviles y camiones
  "811116": "mecanica",        // Alineación y balanceo de automóviles y camiones
  "811119": "mecanica",        // Otras reparaciones mecánicas y eléctricas de automóviles
  "811121": "mecanica",        // Hojalatería y pintura de automóviles y camiones
  "811122": "mecanica",        // Tapicería de automóviles y camiones

  // Sector 48-49 — Transporte (added 2026-05-07). 488410 covers
  // Mexican vehicle inspection centres (equivalent to Spanish ITV).
  "488410": "itv",             // Servicios de centros de verificación vehicular

  // Sector 46 — Comercio retail (added 2026-05-18). DENUE doesn't list
  // independent farmacéuticos as a separate SCIAN, but every farmacia
  // retail unit is here — ~22k in MX. Classify the establishment as
  // `farmacia`; the owner's name + address comes from the row.
  "464111": "farmacia",        // Farmacias sin minisúper
  "464112": "farmacia",        // Farmacias con minisúper
};

/**
 * DENUE encodes the federal entity (estado) + municipio combined
 * into the field `municipio` as a label like "GUADALAJARA". The MX
 * cities seed uses ASCII slug, so slugify() does the rest. Some
 * common DENUE labels need explicit aliases.
 *
 * After migration 0074, the cities table holds the top-300 MX
 * municipios (~95% population coverage). Aliases below now mostly
 * redirect alternative spellings (e.g. "leon" → "leon-mx" because
 * the bare "leon" slug doesn't exist) and intra-MX same-name
 * disambiguations (e.g. "tonala-jal" vs "tonala-chis").
 */
const DENUE_LABEL_TO_SLUG: Record<string, string> = {
  // CDMX alcaldías now seeded individually as their own slugs
  // (iztapalapa, coyoacan, ...). Keep the legacy alias for the
  // generic "Ciudad de México" label.
  "ciudad-de-mexico": "cdmx",
  "distrito-federal": "cdmx",
  // Slugs that needed -mx suffix to avoid ES collisions
  "merida": "merida-mx",
  "leon": "leon-mx",
  "veracruz": "veracruz-mx",
  "cordoba": "cordoba-mx",
  "salamanca": "salamanca-mx",
  "zamora": "zamora-mx",
  // Intra-MX same-name disambiguations — DENUE label is bare,
  // but the seeded slug uses an estado suffix.
  "tonala": "tonala-jal",
  "guadalupe": "guadalupe-nl",
  "santa-catarina": "santa-catarina-nl",
  "juarez": "juarez-nl",
  "garcia": "garcia-nl",
  "cuautla": "cuautla-mor",
  "la-paz": "la-paz-mx",
  "guadalupe-victoria": "guadalupe-victoria-dgo",
  "lerdo": "lerdo-dgo",
  "victoria": "victoria-tam",
  "altamira": "altamira-tam",
  "ciudad-madero": "madero-tam",
  "rio-bravo": "rio-bravo-tam",
  "san-fernando": "san-fernando-tam",
  "matamoros-coahuila": "matamoros-coa",
  "frontera": "frontera-coa",
  "san-pedro": "san-pedro-coa",
  "sabinas": "sabinas-coa",
  "fortin": "cordoba-region",
  "cardenas": "cardenas-tab",
  "paraiso": "paraiso-tab",
  "alvarado": "alvarado-ver",
  "tuxpan": "tuxpan-ver",
  "compostela": "compostela-nay",
  "ayala": "ayala-mor",
  "emiliano-zapata": "emiliano-zapata-mor",
  "valladolid": "valladolid-yuc",
  "rosario": "rosario-sin",
  "el-salto": "el-salto", // Jalisco kept as bare; Durango variant is el-salto-dgo
  "nogales": "nogales-son",
  "san-luis-potosi": "san-luis-potosi",
  // Long-form variants → seeded canonical slug
  "san-pedro-tlaquepaque": "tlaquepaque",
  "tlajomulco-de-zuniga": "tlajomulco",
  "tepatitlan-de-morelos": "tepatitlan",
  "ecatepec-de-morelos": "ecatepec",
  "atizapan-de-zaragoza": "atizapan",
  "coacalco-de-berriozabal": "coacalco",
  "tlalnepantla-de-baz": "tlalnepantla",
  "valle-de-chalco-solidaridad": "valle-de-chalco",
  "naucalpan-de-juarez": "naucalpan",
  "san-andres-cholula": "san-andres-cholula",
  "san-pedro-cholula": "cholula",
  "cuautitlan-izcalli": "cuautitlan-izcalli",
  "huixquilucan-de-degollado": "huixquilucan",
  "tepotzotlan": "tepotzotlan",
  "cajeme": "ciudad-obregon",
  "ahome": "los-mochis",
  "hidalgo-del-parral": "parral",
  "general-escobedo": "escobedo",
  "san-nicolas-de-los-garza": "san-nicolas",
  "playas-de-rosarito": "rosarito",
  "cadereyta-jimenez": "cadereyta-nl",
  "cadereyta-de-montes": "cadereyta-qro",
  "ciudad-victoria": "victoria-tam",
  "cuajimalpa-de-morelos": "cuajimalpa",
  "la-magdalena-contreras": "magdalena-contreras",
  "lazaro-cardenas": "lazaro-cardenas",
  "oaxaca-de-juarez": "oaxaca",
  "juchitan-de-zaragoza": "juchitan",
  "huajuapan-de-leon": "huajuapan",
  "tlapa-de-comonfort": "tlapa",
  "chilapa-de-alvarez": "chilapa",
  "san-cristobal-de-las-casas": "san-cristobal-de-las-casas",
  "tuxtla-gutierrez": "tuxtla-gutierrez",
};

let MX_CITY_SLUGS_CACHE: Set<string> | undefined;

async function ensureMxCitySlugs(): Promise<Set<string>> {
  if (MX_CITY_SLUGS_CACHE) return MX_CITY_SLUGS_CACHE;
  const cities = await getCities({ country: "MX" });
  MX_CITY_SLUGS_CACHE = new Set(cities.map((c) => c.slug));
  return MX_CITY_SLUGS_CACHE;
}

function denueLabelToCitySlug(
  rawLabel: string,
  validSlugs: Set<string>,
): string | null {
  const slug = slugify(rawLabel);
  if (!slug) return null;
  const aliased = DENUE_LABEL_TO_SLUG[slug];
  if (aliased && validSlugs.has(aliased)) return aliased;
  return validSlugs.has(slug) ? slug : null;
}

// --- Minimal ZIP central-dir parser ------------------------------------
//
// We avoid pulling a third-party zip lib (project rule: minimise deps).
// DENUE archives are flat ZIPs (deflate, no encryption, ASCII names),
// so walking the End-of-Central-Directory record is enough.

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
}

function findEndOfCentralDir(buf: Buffer): number {
  // EOCD signature 0x06054b50, scan from end (max 64 KB comment).
  const SIG = 0x06054b50;
  const startSearch = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= startSearch; i -= 1) {
    if (buf.readUInt32LE(i) === SIG) return i;
  }
  return -1;
}

function parseCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDir(buf);
  if (eocd < 0) return [];
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  void cdSize;
  const entries: ZipEntry[] = [];
  let off = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const fnLen = buf.readUInt16LE(off + 28);
    const exLen = buf.readUInt16LE(off + 30);
    const ccLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + fnLen).toString("utf8");
    entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
    off += 46 + fnLen + exLen + ccLen;
  }
  return entries;
}

function readZipEntryData(buf: Buffer, entry: ZipEntry): Buffer | null {
  // Skip the local file header (variable length: 30 bytes + filename + extra)
  let lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const fnLen = buf.readUInt16LE(lh + 26);
  const exLen = buf.readUInt16LE(lh + 28);
  lh += 30 + fnLen + exLen;
  const slice = buf.slice(lh, lh + entry.compressedSize);
  if (entry.method === 0) return slice;
  if (entry.method === 8) {
    try {
      return inflateRawSync(slice);
    } catch (e) {
      console.warn(`[denue-mx] inflate failed for ${entry.name}: ${(e as Error).message}`);
      return null;
    }
  }
  console.warn(`[denue-mx] unsupported zip method ${entry.method} for ${entry.name}`);
  return null;
}

// DENUE CSVs are Latin-1. Decode → UTF-8 string.
const LATIN1 = new TextDecoder("latin1");

async function fetchSectorCsv(url: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    console.error(`[denue-mx] download ${url}: ${(error as Error).message}`);
    return null;
  }
  if (!response.ok) {
    console.error(`[denue-mx] ${response.status} on ${url}`);
    return null;
  }
  const ab = await response.arrayBuffer();
  const buf = Buffer.from(ab);
  const entries = parseCentralDirectory(buf);
  // Pick the largest CSV that is NOT the "diccionario_de_datos" schema.
  const dataEntry = entries
    .filter(
      (e) =>
        e.name.toLowerCase().endsWith(".csv") &&
        !/diccionario/i.test(e.name),
    )
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];
  if (!dataEntry) {
    console.error(`[denue-mx] no data CSV in archive — entries=${entries.map((e) => e.name).join(", ")}`);
    return null;
  }
  const data = readZipEntryData(buf, dataEntry);
  if (!data) return null;
  return LATIN1.decode(data);
}

async function fetchSector(
  sector: DenueSector,
  remaining: number,
): Promise<ScrapedProfessional[]> {
  if (remaining <= 0) return [];
  const text = await fetchSectorCsv(sector.url);
  if (!text) return [];
  const rows = parseCsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  const validSlugs = await ensureMxCitySlugs();

  for (const row of rows) {
    if (out.length >= remaining) break;
    const scian = pick(row, ["codigo_act", "codigo_actividad"]);
    const category = SCIAN_TO_CATEGORY[scian];
    if (!category) continue;

    const ident = pick(row, ["id", "id_unidad", "clee"]);
    if (!ident) continue;

    const municipio = pick(row, ["municipio", "nom_mun"]);
    const citySlug = denueLabelToCitySlug(municipio, validSlugs);
    if (!citySlug) continue;

    if (seen.has(ident)) continue;
    seen.add(ident);

    const name =
      pick(row, ["nom_estab", "razon_social", "nombre"]) ||
      pick(row, ["nom_v_e"]);
    if (!name) continue;

    const street =
      [
        pick(row, ["tipo_vial"]),
        pick(row, ["nom_vial", "nom_v_e"]),
        pick(row, ["numero_ext", "num_ext"]),
      ]
        .filter(Boolean)
        .join(" ");
    const cp = pick(row, ["cod_postal", "cp"]);
    const ciudad = pick(row, ["ciudad", "nom_ciudad"]) || municipio;
    const address = [street, cp, ciudad].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "denue-mx",
        country: "MX",
        sourceId: `denue-mx:${ident}`,
        name,
        categoryKey: category,
        citySlug,
        phone: pick(row, ["telefono", "tel"]) || undefined,
        email: pick(row, ["correoelec", "correo_elec", "email"]) || undefined,
        website: pick(row, ["www", "sitio_internet"]) || undefined,
        address: address || undefined,
        metadata: {
          country: "MX",
          authority: "INEGI / DENUE",
          scian: scian,
          actividad: pick(row, ["nombre_act", "actividad"]) || undefined,
          tamano: pick(row, ["per_ocu", "per_ocupado"]) || undefined,
          entidad: pick(row, ["entidad", "nom_entidad"]) || undefined,
          municipio,
          ciudad,
        },
      }),
    );
  }
  console.log(`[denue-mx] sector=${sector.label}: kept=${out.length}`);
  return out;
}

export const denueMxSource: ScraperSource = {
  name: "denue-mx",
  enabled() {
    return process.env.PROLIO_RUN_DENUE_MX === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runDenueMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!denueMxSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_DENUE_MX_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const all: ScrapedProfessional[] = [];
  for (const sector of DENUE_SECTORS) {
    if (all.length >= limit) break;
    const remaining = limit - all.length;
    const records = await fetchSector(sector, remaining);
    all.push(...records);
  }

  if (all.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(all);
  console.log(
    `[denue-mx] done — fetched=${all.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: all.length, inserted, updated, skipped };
}
