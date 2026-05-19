import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * AMDA — Asociación Mexicana de Distribuidores de Automotores.
 *
 *   https://www.amda.mx
 *
 * AMDA agrupa a los distribuidores oficiales de autos nuevos en
 * México. La industria habla de ~2,000 distribuidores afiliados,
 * pero AMDA NO publica un directorio público navegable de esos
 * concesionarios individuales: la sección "Directorios" del portal
 * sólo expone dos listados públicos a nivel de agrupación
 * (auditados 2026-05-13):
 *
 *   - 23 asociaciones de marca
 *     https://www.amda.mx/asociaciones-de-marca/
 *     (una entidad por OEM: Ford, GM, Honda, Nissan, Toyota, VW,
 *     Audi/BMW/Porsche, Mercedes, Stellantis, Kia, Hyundai, MG,
 *     GWM, Renault, Suzuki, Mitsubishi, Lexus, Volvo, Isuzu, Hino,
 *     International, Daimler vans, etc.)
 *
 *   - 28 asociaciones estatales
 *     https://www.amda.mx/asociaciones-estatales/
 *     (una por estado o región — Aguascalientes, BC, BCS, Coahuila,
 *     …, frontera, Yucatán peninsular, Veracruz/Tabasco, etc.)
 *
 * El padrón individual de concesionarios queda detrás de "ACCESO A
 * ASOCIADOS" (mi-amda) y requiere credenciales. Sin login no es
 * scrapable.
 *
 * Esta fuente emite las 51 asociaciones AMDA como entidades con
 * cédula `mecanica` (el match más cercano del enum — un
 * concesionario oficial siempre incluye taller postventa y son los
 * únicos talleres certificados de marca). Cada registro lleva en
 * metadata su tipo (brand vs state), la marca/estado y el correo de
 * contacto AMDA. Sirven como semillas para enriquecimiento posterior
 * (Google Places → dealers individuales por marca/estado).
 *
 * Off by default. `PROLIO_RUN_AMDA_DISTRIBUIDORES=true`.
 * Cap with `PROLIO_AMDA_DISTRIBUIDORES_LIMIT` (default 3000).
 */

const DEFAULT_LIMIT = 3_000;
const CATEGORY: CategoryKey = "mecanica";

interface AmdaEntry {
  /** Display name as listed by AMDA. */
  name: string;
  /** "brand" — asociación de marca; "state" — asociación estatal. */
  kind: "brand" | "state";
  /** Brand (e.g. "Ford") for kind=brand; undefined for state. */
  brand?: string;
  /** State/region name (e.g. "Jalisco") for kind=state; undefined for brand. */
  state?: string;
  /** City slug from cities.ts. */
  citySlug: string;
  address?: string;
  phone?: string;
  email?: string;
}

/**
 * AMDA brand associations (asociaciones de marca).
 *
 * Snapshot 2026-05-13. All 23 entities sit in CDMX (national HQ per
 * brand). Phones/emails are the contacto público publicado por AMDA.
 * Brands grouped under a single legal association (e.g. ADBMW for
 * Audi+BMW+Porsche) emit one record per legal association.
 */
const BRAND_ASSOCIATIONS: AmdaEntry[] = [
  {
    name: "Asociación de Distribuidores de Automóviles Alemanes (ADBMW)",
    kind: "brand",
    brand: "BMW/Audi/Porsche",
    citySlug: "cdmx",
    address: "Bosque de Cidros 54-101, Bosques de las Lomas, CDMX",
    phone: "+52 55 5531 7447",
    email: "administracion@adbmw.mx",
  },
  {
    name: "Asociación Mexicana de Distribuidores Ford (AMDF)",
    kind: "brand",
    brand: "Ford",
    citySlug: "cdmx",
    address: "Guillermo González Camarena 1000, CDMX",
    phone: "+52 55 5985 2600",
    email: "cacuna@amdf.com.mx",
  },
  {
    name: "Asociación Mexicana de Distribuidores General Motors",
    kind: "brand",
    brand: "General Motors",
    citySlug: "cdmx",
    address: "Palmas 735, Lomas de Chapultepec, CDMX",
    phone: "+52 55 9138 1750",
    email: "abeltran@distribuidoresgm.com.mx",
  },
  {
    name: "Asociación Mexicana de Concesionarios Honda (AMECAH)",
    kind: "brand",
    brand: "Honda",
    citySlug: "cdmx",
    address: "Av. Insurgentes Sur 730, CDMX",
    phone: "+52 55 3000 5050",
    email: "spons@amecah.com.mx",
  },
  {
    name: "Asociación Nacional de Distribuidores Nissan (ANDANAC)",
    kind: "brand",
    brand: "Nissan",
    citySlug: "cdmx",
    address: "Adolfo Prieto 624, Del Valle, CDMX",
    phone: "+52 55 5340 0000",
    email: "kaschentrupp@andanac.com",
  },
  {
    name: "Distribuidores Toyota México (DTMAC)",
    kind: "brand",
    brand: "Toyota",
    citySlug: "cdmx",
    address: "Paseos de Tamarindos 400, Bosques de las Lomas, CDMX",
    phone: "+52 55 9177 2777",
    email: "denisa.garcia@dtmac.com.mx",
  },
  {
    name: "Asociación Nacional de Concesionarios Grupo Volkswagen (ANCGVW)",
    kind: "brand",
    brand: "Volkswagen",
    citySlug: "cdmx",
    address: "Av. Río Mixcoac 258, CDMX",
    phone: "+52 55 5200 0500",
    email: "lombardo@ancgvw.com",
  },
  { name: "Asociación de Distribuidores Daimler México", kind: "brand", brand: "Daimler", citySlug: "cdmx" },
  { name: "Asociación de Distribuidores GWM México", kind: "brand", brand: "GWM", citySlug: "cdmx" },
  { name: "Asociación de Distribuidores Hino México", kind: "brand", brand: "Hino", citySlug: "cdmx" },
  { name: "Asociación Mexicana de Distribuidores Hyundai", kind: "brand", brand: "Hyundai", citySlug: "cdmx" },
  { name: "Asociación de Distribuidores International México", kind: "brand", brand: "International", citySlug: "cdmx" },
  { name: "Asociación de Distribuidores Isuzu México", kind: "brand", brand: "Isuzu", citySlug: "cdmx" },
  { name: "Asociación Mexicana de Distribuidores Kia", kind: "brand", brand: "Kia", citySlug: "cdmx" },
  { name: "Asociación de Distribuidores Lexus México", kind: "brand", brand: "Lexus", citySlug: "cdmx" },
  { name: "Asociación de Distribuidores Mercedes-Benz México", kind: "brand", brand: "Mercedes-Benz", citySlug: "cdmx" },
  { name: "Asociación de Distribuidores Mercedes-Benz Vans México", kind: "brand", brand: "Mercedes-Benz Vans", citySlug: "cdmx" },
  { name: "Asociación de Distribuidores MG México", kind: "brand", brand: "MG", citySlug: "cdmx" },
  { name: "Asociación Mexicana de Distribuidores Mitsubishi", kind: "brand", brand: "Mitsubishi", citySlug: "cdmx" },
  { name: "Asociación de Distribuidores Renault México", kind: "brand", brand: "Renault", citySlug: "cdmx" },
  { name: "Asociación de Distribuidores Stellantis México", kind: "brand", brand: "Stellantis", citySlug: "cdmx" },
  { name: "Asociación Mexicana de Distribuidores Suzuki", kind: "brand", brand: "Suzuki", citySlug: "cdmx" },
  { name: "Asociación de Distribuidores Volvo México", kind: "brand", brand: "Volvo", citySlug: "cdmx" },
];

/**
 * AMDA state/regional associations (asociaciones estatales).
 *
 * Snapshot 2026-05-13. 28 entries; cubre todos los estados con
 * mercado relevante de auto nuevo. Algunas son interestatales
 * (Veracruz/Tabasco, Puebla/Tlaxcala, Peninsular = Yucatán+QRoo+Camp,
 * Frontera = Tamaulipas norte). citySlug elegido por ubicación de
 * la sede AMDA, no por el alcance territorial.
 */
const STATE_ASSOCIATIONS: AmdaEntry[] = [
  {
    name: "Asociación Fronteriza de Distribuidores de Automotores",
    kind: "state",
    state: "Tamaulipas (Frontera)",
    citySlug: "reynosa",
    address: "Calle Perales 750, Reynosa, Tamaulipas",
    phone: "+52 899 460 4240",
    email: "nsanchez@amda.mx",
  },
  {
    name: "AMDA Aguascalientes",
    kind: "state",
    state: "Aguascalientes",
    citySlug: "aguascalientes",
    address: "Calle Monte Bello 101, Aguascalientes",
    phone: "+52 449 917 2120",
    email: "fmorenom@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Baja California Sur",
    kind: "state",
    state: "Baja California Sur",
    citySlug: mxStateToCity("Baja California Sur") ?? "mazatlan",
    address: "Ignacio Allende 490, La Paz, BCS",
    phone: "+52 612 123 5212",
    email: "evelezr@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Coahuila",
    kind: "state",
    state: "Coahuila",
    citySlug: "torreon",
    address: "Boulevard Independencia 2690, Torreón, Coahuila",
    phone: "+52 871 717 7869",
    email: "kmendozam@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Colima",
    kind: "state",
    state: "Colima",
    citySlug: mxStateToCity("Colima") ?? "guadalajara",
    address: "Av. Rey Colimán 329, Colima",
    phone: "+52 312 314 2202",
    email: "fvizcainom@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Chiapas",
    kind: "state",
    state: "Chiapas",
    citySlug: mxStateToCity("Chiapas") ?? "villahermosa",
    address: "Andador 3ra. Oriente 137, Tuxtla Gutiérrez, Chiapas",
    phone: "+52 961 617 2931",
    email: "svaldenegroz@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Chihuahua",
    kind: "state",
    state: "Chihuahua",
    citySlug: "chihuahua",
    address: "Calle Pedro Zuloaga 11270-1, Chihuahua",
    phone: "+52 614 410 7089",
    email: "glongoriag@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Durango",
    kind: "state",
    state: "Durango",
    citySlug: mxStateToCity("Durango") ?? "torreon",
    address: "Calle Pino Suárez 609, Durango",
    phone: "+52 618 812 0292",
    email: "mzamudioa@amda.mx",
  },
  {
    name: "Asociación de Distribuidores del Estado de México",
    kind: "state",
    state: "Estado de México",
    citySlug: "tlalnepantla",
    address: "Leona Vicario 729-A, Metepec, Edomex",
    phone: "+52 722 199 2363",
    email: "gguadarramab@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Guanajuato",
    kind: "state",
    state: "Guanajuato",
    citySlug: "leon-mx",
    address: "Paseo del Moral 1030-19, León, Guanajuato",
    phone: "+52 477 718 4453",
    email: "agonzalezp@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Hidalgo",
    kind: "state",
    state: "Hidalgo",
    citySlug: mxStateToCity("Hidalgo") ?? "cdmx",
    address: "Altar 103, Pachuca, Hidalgo",
    phone: "+52 771 715 5571",
    email: "sibarram@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Guerrero",
    kind: "state",
    state: "Guerrero",
    citySlug: "acapulco",
    address: "Av. Cuauhtémoc 239, Acapulco, Guerrero",
    phone: "+52 744 485 7721",
    email: "rrojasm@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Jalisco",
    kind: "state",
    state: "Jalisco",
    citySlug: "guadalajara",
    address: "Av. Parque Juan Diego 510, Zapopan, Jalisco",
    phone: "+52 33 3121 7066",
    email: "mmaldonadoo@amda.mx",
  },
  {
    name: "Asociación Michoacana de Distribuidores",
    kind: "state",
    state: "Michoacán",
    citySlug: "morelia",
    address: "Av. Camelinas 3163, Morelia, Michoacán",
    phone: "+52 443 315 9535",
    email: "plarreat@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Morelos",
    kind: "state",
    state: "Morelos",
    citySlug: "cuernavaca",
    address: "Oaxaca 1, Cuernavaca, Morelos",
    phone: "+52 777 318 6100",
    email: "scortesn@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Nayarit",
    kind: "state",
    state: "Nayarit",
    citySlug: mxStateToCity("Nayarit") ?? "guadalajara",
    address: "Insurgentes Poniente 821-1, Tepic, Nayarit",
    phone: "+52 311 217 1823",
    email: "arodrigueze@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Nuevo León",
    kind: "state",
    state: "Nuevo León",
    citySlug: "monterrey",
    address: "Av. Alfonso Reyes 2615, Monterrey, Nuevo León",
    phone: "+52 81 2314 0180",
    email: "aricob@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Oaxaca",
    kind: "state",
    state: "Oaxaca",
    citySlug: mxStateToCity("Oaxaca") ?? "acapulco",
    address: "Huerto Los Laureles 121, Oaxaca",
    phone: "+52 951 518 9610",
    email: "psanchezr@amda.mx",
  },
  {
    name: "Asociación Peninsular de Distribuidores",
    kind: "state",
    state: "Yucatán/Quintana Roo/Campeche",
    citySlug: "merida-mx",
    address: "Calle 21 #266, Mérida, Yucatán",
    email: "mabdalah@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Puebla y Tlaxcala",
    kind: "state",
    state: "Puebla/Tlaxcala",
    citySlug: "puebla",
    address: "15 Poniente 3504, Puebla",
    phone: "+52 222 248 5646",
    email: "eorozcoo@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Querétaro",
    kind: "state",
    state: "Querétaro",
    citySlug: "queretaro",
    address: "Camino Real de Carretas 299-2, Querétaro",
    phone: "+52 442 215 2231",
    email: "lrodriguezm@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de San Luis Potosí",
    kind: "state",
    state: "San Luis Potosí",
    citySlug: "san-luis-potosi",
    address: "Av. Muñoz 355-A, San Luis Potosí",
    phone: "+52 444 833 4453",
    email: "fherrerah@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Sinaloa",
    kind: "state",
    state: "Sinaloa",
    citySlug: "culiacan",
    address: "Río Orinoco 3133, Culiacán, Sinaloa",
    phone: "+52 667 715 1341",
    email: "lzambranoe@amda.mx",
  },
  {
    name: "AMDA Sonora",
    kind: "state",
    state: "Sonora",
    citySlug: "hermosillo",
    address: "Calle General Piña 49, Hermosillo, Sonora",
    phone: "+52 662 210 8798",
    email: "rmartinezs@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Tamaulipas",
    kind: "state",
    state: "Tamaulipas",
    citySlug: mxStateToCity("Tamaulipas") ?? "reynosa",
    address: "Juan Bautista 409, Ciudad Victoria, Tamaulipas",
    phone: "+52 834 314 6888",
    email: "jmedinac@amda.mx",
  },
  {
    name: "Unión de Concesionarios de Automóviles Nuevos (Baja California)",
    kind: "state",
    state: "Baja California",
    citySlug: "mexicali",
    address: "Av. Álvaro Obregón 1501, Mexicali, Baja California",
    phone: "+52 686 552 3630",
    email: "alopezc@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Veracruz y Tabasco",
    kind: "state",
    state: "Veracruz/Tabasco",
    citySlug: "veracruz-mx",
    address: "Av. Américas 140, Boca del Río, Veracruz",
    phone: "+52 229 980 7448",
    email: "lpalomarm@amda.mx",
  },
  {
    name: "Asociación de Distribuidores de Zacatecas",
    kind: "state",
    state: "Zacatecas",
    citySlug: mxStateToCity("Zacatecas") ?? "aguascalientes",
    address: "Av. Pedro Coronel 123-5, Guadalupe, Zacatecas",
    phone: "+52 492 923 3460",
    email: "dcastrob@amda.mx",
  },
];

const SEED: AmdaEntry[] = [...BRAND_ASSOCIATIONS, ...STATE_ASSOCIATIONS];

function buildRecords(limit: number): ScrapedProfessional[] {
  const out: ScrapedProfessional[] = [];
  for (const entry of SEED) {
    if (out.length >= limit) break;
    const slugBase = slugify(
      `${entry.kind}-${entry.brand ?? entry.state ?? entry.name}`,
    );
    const sourceId = `amda:${slugBase}`;
    out.push(
      normalise({
        source: "amda-distribuidores" as ScrapeSource,
        country: "MX",
        sourceId,
        name: entry.name,
        categoryKey: CATEGORY,
        citySlug: entry.citySlug,
        address: entry.address,
        phone: entry.phone,
        email: entry.email,
        website: "https://www.amda.mx",
        metadata: {
          country: "MX",
          authority: "AMDA",
          verified_by_authority: true,
          amda_kind: entry.kind,
          marca: entry.brand,
          raw_state: entry.state,
          source_url:
            entry.kind === "brand"
              ? "https://www.amda.mx/asociaciones-de-marca/"
              : "https://www.amda.mx/asociaciones-estatales/",
        },
      }),
    );
  }
  return out;
}

export const amdaDistribuidoresEnabled = (): boolean =>
  process.env.PROLIO_RUN_AMDA_DISTRIBUIDORES === "true";

export const amdaDistribuidoresSource: ScraperSource = {
  name: "amda-distribuidores" as ScrapeSource,
  enabled: amdaDistribuidoresEnabled,
  async fetch() {
    return [];
  },
};

export async function runAmdaDistribuidores(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!amdaDistribuidoresEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("amda-distribuidores", async () => {
    const rawLimit = Number(
      process.env.PROLIO_AMDA_DISTRIBUIDORES_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
    const records = buildRecords(limit);
    console.log(
      `[amda-distribuidores] seeded ${records.length} associations ` +
        `(${BRAND_ASSOCIATIONS.length} brand + ${STATE_ASSOCIATIONS.length} state)`,
    );
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
