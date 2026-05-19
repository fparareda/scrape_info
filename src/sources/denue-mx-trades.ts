import { inflateRawSync } from "node:zlib";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getCities } from "../cities.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv, pick } from "./_bulk-utils.js";

/**
 * DENUE-MX Trades — sister source to `denue-mx.ts` that re-uses the
 * same INEGI bulk archives (SCIAN 23, 33, 81) but extends the
 * SCIAN→category map to cover trades that `denue-mx.ts` deliberately
 * skips: refrigeration/HVAC, white-goods repair, electronics repair,
 * upholstery (carpintería retrofit), additional construction
 * sub-codes (cimentación, concreto, herrería, ventanería).
 *
 * Why a separate source instead of widening `denue-mx.ts`?
 *   1) `denue-mx.ts` enum + scheduling already shipped in production;
 *      adding 15+ new SCIAN codes there inflates row counts and changes
 *      its baseline silently.
 *   2) These categories overlap heavily with trades that `denue-mx.ts`
 *      already maps under different SCIANs (e.g. 238221 fontanería vs
 *      811412 reparación de white-goods → both "fontaneria"); keeping
 *      them in a separate run lets us A/B the dedup behaviour.
 *   3) The "trades" archive cuts also include SCIAN 337 (fabricación
 *      de muebles) which `denue-mx.ts` does NOT download today.
 *
 * Target: +50,000 trades rows (mecánica/carpintería/fontanería/electricidad)
 * after dedup against `denue-mx.ts` existing 38k rows.
 *
 * Distribution (same as denue-mx.ts):
 *   https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_<sector>_csv.zip
 *
 * License: INEGI open data (free reuse with attribution).
 *
 * Off by default. `PROLIO_RUN_DENUE_MX_TRADES=true`. Cap with
 * `PROLIO_DENUE_MX_TRADES_LIMIT` (default 50000 rows).
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const DEFAULT_LIMIT = 50_000;

interface DenueSector {
  url: string;
  label: string;
}

const DENUE_SECTORS: DenueSector[] = [
  // Sector 23 — construcción (instalaciones especializadas adicionales)
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_23_csv.zip",
    label: "23-construccion-trades",
  },
  // Sector 33 — fabricación de muebles, cocina, baño (337XXX dentro)
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_33_csv.zip",
    label: "33-manufacturas-muebles",
  },
  // Sector 81 partes 1 y 2 — talleres de reparación (mecánica auto +
  // electrónicos + electrodomésticos + tapicería)
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_81_1_csv.zip",
    label: "81-1-talleres-trades",
  },
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_81_2_csv.zip",
    label: "81-2-talleres-trades",
  },
];

/**
 * Extended SCIAN map — SOLO trades NO cubiertos por `denue-mx.ts`.
 * Cualquier código que ya esté en `denue-mx.ts` se OMITE aquí para
 * evitar doble extracción innecesaria. Los IDs DENUE son únicos a
 * nivel global, así que de todos modos el sink hace dedup, pero
 * preferimos no descargar la misma fila dos veces.
 */
const SCIAN_TO_CATEGORY: Record<string, CategoryKey> = {
  // Sector 23 — Construcción (instalaciones extra)
  "238110": "carpinteria",     // Cimentación (encofrado, often carpintero obra)
  "238121": "electricidad",    // Montaje de estructuras prefabricadas eléctricas
  "238122": "electricidad",
  "238130": "carpinteria",     // Trabajos de albañilería (col. yeseros / fachadistas)
  "238190": "carpinteria",     // Otros trabajos de cimentación
  "238290": "fontaneria",      // Otras instalaciones de equipo
  "238310": "carpinteria",     // Colocación de muros falsos / aislamiento
  "238320": "carpinteria",     // Trabajos de pintura y otros recubrimientos
  "238330": "carpinteria",     // Trabajos de instalación de productos de carpintería
  "238340": "carpinteria",     // Trabajos de instalación de pisos
  "238390": "carpinteria",     // Otros trabajos de acabados

  // Sector 33 — fabricación de muebles (carpintería de fábrica + a medida)
  "337110": "carpinteria",     // Fabricación de muebles de cocina y baño
  "337120": "carpinteria",     // Fabricación de muebles, excepto cocina y baño
  "337210": "carpinteria",     // Fabricación de muebles de oficina y estantería
  "337910": "carpinteria",     // Fabricación de colchones (skip si es industrial)
  "337920": "carpinteria",     // Fabricación de persianas y cortineros

  // Sector 81 — reparación / talleres NO automotor (los 811111-811122
  // mecánica auto ya están en `denue-mx.ts`).
  "811211": "electricidad",    // Reparación y mantenimiento de equipo electrónico
  "811219": "electricidad",    // Otros equipos electrónicos
  "811311": "mecanica",        // Reparación de maquinaria y equipo agropecuario/industrial
  "811312": "mecanica",        // Reparación de maquinaria y equipo comercial/servicios
  "811411": "carpinteria",     // Reparación de calzado (skip a fontanería; near miss)
  "811412": "fontaneria",      // Reparación de electrodomésticos menores (white goods)
  "811420": "carpinteria",     // Reparación de tapicería de muebles
  "811430": "cerrajero",       // Reparación de relojes (cerca de cerrajería; coda pequeña)
  "811490": "mecanica",        // Otros servicios de reparación y mantenimiento
};

const DENUE_LABEL_TO_SLUG: Record<string, string> = {
  "ciudad-de-mexico": "cdmx",
  "distrito-federal": "cdmx",
  merida: "merida-mx",
  leon: "leon-mx",
  veracruz: "veracruz-mx",
  cordoba: "cordoba-mx",
  tonala: "tonala-jal",
  guadalupe: "guadalupe-nl",
  "santa-catarina": "santa-catarina-nl",
  juarez: "juarez-nl",
  garcia: "garcia-nl",
  "la-paz": "la-paz-mx",
  victoria: "victoria-tam",
  altamira: "altamira-tam",
  "san-pedro-tlaquepaque": "tlaquepaque",
  "tlajomulco-de-zuniga": "tlajomulco",
  "ecatepec-de-morelos": "ecatepec",
  "atizapan-de-zaragoza": "atizapan",
  "tlalnepantla-de-baz": "tlalnepantla",
  "naucalpan-de-juarez": "naucalpan",
  "coacalco-de-berriozabal": "coacalco",
  "valle-de-chalco-solidaridad": "valle-de-chalco",
  "cuautitlan-izcalli": "cuautitlan-izcalli",
  cajeme: "ciudad-obregon",
  ahome: "los-mochis",
  "general-escobedo": "escobedo",
  "san-nicolas-de-los-garza": "san-nicolas",
  "oaxaca-de-juarez": "oaxaca",
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

// --- ZIP central-dir parser (local copy from denue-mx.ts) -------------

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
}

function findEndOfCentralDir(buf: Buffer): number {
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
  const cdOffset = buf.readUInt32LE(eocd + 16);
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
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method,
      localHeaderOffset,
    });
    off += 46 + fnLen + exLen + ccLen;
  }
  return entries;
}

function readZipEntryData(buf: Buffer, entry: ZipEntry): Buffer | null {
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
      console.warn(
        `[denue-mx-trades] inflate failed for ${entry.name}: ${(e as Error).message}`,
      );
      return null;
    }
  }
  console.warn(
    `[denue-mx-trades] unsupported zip method ${entry.method} for ${entry.name}`,
  );
  return null;
}

const LATIN1 = new TextDecoder("latin1");

async function fetchSectorCsv(url: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    console.error(
      `[denue-mx-trades] download ${url}: ${(error as Error).message}`,
    );
    return null;
  }
  if (!response.ok) {
    console.error(`[denue-mx-trades] ${response.status} on ${url}`);
    return null;
  }
  const ab = await response.arrayBuffer();
  const buf = Buffer.from(ab);
  const entries = parseCentralDirectory(buf);
  const dataEntry = entries
    .filter(
      (e) =>
        e.name.toLowerCase().endsWith(".csv") && !/diccionario/i.test(e.name),
    )
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];
  if (!dataEntry) {
    console.error(`[denue-mx-trades] no data CSV in ${url}`);
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
    if (seen.has(ident)) continue;
    seen.add(ident);

    const municipio = pick(row, ["municipio", "nom_mun"]);
    const citySlug = denueLabelToCitySlug(municipio, validSlugs);
    if (!citySlug) continue;

    const name =
      pick(row, ["nom_estab", "razon_social", "nombre"]) ||
      pick(row, ["nom_v_e"]);
    if (!name) continue;

    const street = [
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
        source: "denue-mx-trades" as ScrapeSource,
        country: "MX",
        // Same id-namespace as denue-mx so the sink dedup catches it if
        // somehow we extract the same SCIAN twice across the two sources.
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
          authority: "INEGI / DENUE (trades expansion)",
          scian,
          actividad: pick(row, ["nombre_act", "actividad"]) || undefined,
          tamano: pick(row, ["per_ocu", "per_ocupado"]) || undefined,
          entidad: pick(row, ["entidad", "nom_entidad"]) || undefined,
          municipio,
          ciudad,
        },
      }),
    );
  }
  console.log(`[denue-mx-trades] sector=${sector.label}: kept=${out.length}`);
  return out;
}

export const denueMxTradesEnabled = (): boolean =>
  process.env.PROLIO_RUN_DENUE_MX_TRADES === "true";

export const denueMxTradesSource: ScraperSource = {
  name: "denue-mx-trades" as ScrapeSource,
  enabled: denueMxTradesEnabled,
  async fetch() {
    return [];
  },
};

export async function runDenueMxTrades(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!denueMxTradesEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("denue-mx-trades" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_DENUE_MX_TRADES_LIMIT ?? DEFAULT_LIMIT,
    );
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
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(all);
    console.log(
      `[denue-mx-trades] done — fetched=${all.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
    return {
      rowsFetched: all.length,
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
