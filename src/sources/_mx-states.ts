import { slugify } from "../normalise.js";

/**
 * Shared MX state-name → city-slug mapping for sources that ship
 * record locations as state names rather than city names. Maps each
 * of the 32 Mexican states to its seeded metro slug (from
 * `MEXICAN_CITIES` in `cities.ts`). Anything unmapped is returned
 * as-is and dropped at sink if not a valid seeded slug.
 *
 * Kept small and conservative: when in doubt we prefer the largest
 * metro in the state. Cleanup over time.
 */
export const MX_STATE_TO_CITY: Record<string, string> = {
  "aguascalientes": "aguascalientes",
  "baja-california": "tijuana",
  "baja-california-sur": "mazatlan",
  "campeche": "merida-mx",
  "chiapas": "villahermosa",
  "chihuahua": "chihuahua",
  "ciudad-de-mexico": "cdmx",
  "cdmx": "cdmx",
  "distrito-federal": "cdmx",
  "df": "cdmx",
  "coahuila": "saltillo",
  "coahuila-de-zaragoza": "saltillo",
  "colima": "guadalajara",
  "durango": "torreon",
  "estado-de-mexico": "tlalnepantla",
  "mexico": "tlalnepantla",
  "edomex": "tlalnepantla",
  "guanajuato": "leon-mx",
  "guerrero": "acapulco",
  "hidalgo": "cdmx",
  "jalisco": "guadalajara",
  "michoacan": "morelia",
  "michoacan-de-ocampo": "morelia",
  "morelos": "cuernavaca",
  "nayarit": "guadalajara",
  "nuevo-leon": "monterrey",
  "oaxaca": "acapulco",
  "puebla": "puebla",
  "queretaro": "queretaro",
  "queretaro-de-arteaga": "queretaro",
  "quintana-roo": "cancun",
  "san-luis-potosi": "san-luis-potosi",
  "sinaloa": "culiacan",
  "sonora": "hermosillo",
  "tabasco": "villahermosa",
  "tamaulipas": "reynosa",
  "tlaxcala": "puebla",
  "veracruz": "veracruz-mx",
  "veracruz-de-ignacio-de-la-llave": "veracruz-mx",
  "yucatan": "merida-mx",
  "zacatecas": "aguascalientes",
};

/** Return city-slug for a raw state/region string, or undefined. */
export function mxStateToCity(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const slug = slugify(raw);
  if (!slug) return undefined;
  if (MX_STATE_TO_CITY[slug]) return MX_STATE_TO_CITY[slug];
  // Maybe the input is already a known city slug — caller handles
  // validity at sink.
  return slug;
}

/**
 * Common MX municipio variations → seeded city slug. Many MX datasets
 * (SIEM, DENUE, INEGI) write the full ceremonial municipio name
 * ("Chilpancingo de los Bravo") while our cities.ts seeds the shorter
 * popular form ("chilpancingo"). Slug keys are normalised via slugify.
 *
 * Keep aliases here when:
 *   - the popular form is the seeded slug, OR
 *   - two municipios collapse to the same metro (e.g. Naucalpan ⇒ CDMX
 *     suburb served by tlalnepantla seed).
 */
export const MX_MUNI_ALIASES: Record<string, string> = {
  // Guerrero
  "chilpancingo-de-los-bravo": "chilpancingo",

  // Guanajuato
  "leon": "leon-mx",
  "leon-de-los-aldama": "leon-mx",

  // Tabasco
  "cardenas": "cardenas-tab",
  "centro": "villahermosa", // Villahermosa cabecera

  // Estado de México (CDMX metro)
  "atizapan-de-zaragoza": "atizapan",
  "cuautitlan-izcalli": "cuautitlan",
  "naucalpan-de-juarez": "naucalpan",
  "ecatepec-de-morelos": "ecatepec",
  "nezahualcoyotl": "nezahualcoyotl",
  "ciudad-nezahualcoyotl": "nezahualcoyotl",
  "tlalnepantla-de-baz": "tlalnepantla",
  "valle-de-chalco-solidaridad": "chalco",
  "chalco-de-diaz-covarrubias": "chalco",
  "tultitlan-de-mariano-escobedo": "tultitlan",
  "coacalco-de-berriozabal": "coacalco",
  "ixtapaluca": "ixtapaluca",
  "chimalhuacan": "chimalhuacan",
  "la-paz": "tlalnepantla", // Edomex La Paz, not BCS

  // Zacatecas / Nuevo León share "Guadalupe"
  "guadalupe": "guadalupe-zac",

  // Morelos
  "emiliano-zapata": "emiliano-zapata-mor",
  "jiutepec": "jiutepec",
  "temixco": "temixco",

  // Jalisco
  "tlajomulco-de-zuniga": "tlajomulco",
  "san-pedro-tlaquepaque": "tlaquepaque",
  "tlaquepaque": "tlaquepaque",
  "tonala": "tonala-jal",
  "zapopan": "zapopan",
  "el-salto": "guadalajara",
  "puerto-vallarta": "puerto-vallarta",

  // Nuevo León
  "san-pedro-garza-garcia": "san-pedro",
  "san-nicolas-de-los-garza": "san-nicolas",
  "general-escobedo": "escobedo",
  "ciudad-apodaca": "apodaca",
  "apodaca": "apodaca",
  "santa-catarina": "santa-catarina",
  "garcia": "garcia",

  // Yucatán / Quintana Roo
  "merida": "merida-mx",
  "benito-juarez": "cancun", // Cancún cabecera (Quintana Roo)
  "othon-p-blanco": "chetumal",
  "solidaridad": "playa-del-carmen",

  // Veracruz
  "veracruz": "veracruz-mx",
  "h-veracruz": "veracruz-mx",
  "boca-del-rio": "veracruz-mx",
  "coatzacoalcos": "coatzacoalcos",
  "poza-rica-de-hidalgo": "poza-rica",
  "xalapa-enriquez": "xalapa",
  "xalapa": "xalapa",

  // Puebla
  "puebla-de-zaragoza": "puebla",
  "heroica-puebla-de-zaragoza": "puebla",
  "san-andres-cholula": "puebla",
  "san-pedro-cholula": "puebla",

  // Querétaro
  "santiago-de-queretaro": "queretaro",
  "queretaro": "queretaro",
  "corregidora": "queretaro",
  "el-marques": "queretaro",

  // Tamaulipas
  "heroica-matamoros": "matamoros",
  "matamoros": "matamoros",
  "nuevo-laredo": "nuevo-laredo",
  "ciudad-victoria": "ciudad-victoria",
  "ciudad-madero": "tampico",
  "altamira": "tampico",

  // Sonora
  "heroica-nogales": "nogales",
  "nogales": "nogales",
  "ciudad-obregon": "obregon",
  "cajeme": "obregon",

  // Chihuahua
  "juarez": "ciudad-juarez",
  "ciudad-juarez": "ciudad-juarez",
  "heroica-ciudad-de-juarez": "ciudad-juarez",

  // Sinaloa
  "ahome": "los-mochis",
  "mazatlan": "mazatlan",

  // Baja California
  "tijuana": "tijuana",
  "ensenada": "ensenada",
  "mexicali": "mexicali",
  "playas-de-rosarito": "rosarito",

  // San Luis Potosí
  "soledad-de-graciano-sanchez": "san-luis-potosi",

  // Michoacán
  "morelia": "morelia",
  "uruapan": "uruapan",
  "lazaro-cardenas": "lazaro-cardenas",

  // CDMX alcaldías → cdmx
  "alvaro-obregon": "cdmx",
  "azcapotzalco": "cdmx",
  "benito-juarez-cdmx": "cdmx",
  "coyoacan": "cdmx",
  "cuajimalpa-de-morelos": "cdmx",
  "cuauhtemoc": "cdmx",
  "gustavo-a-madero": "cdmx",
  "iztacalco": "cdmx",
  "iztapalapa": "cdmx",
  "magdalena-contreras": "cdmx",
  "la-magdalena-contreras": "cdmx",
  "miguel-hidalgo": "cdmx",
  "milpa-alta": "cdmx",
  "tlahuac": "cdmx",
  "tlalpan": "cdmx",
  "venustiano-carranza": "cdmx",
  "xochimilco": "cdmx",
};

/**
 * Resolve a raw MX municipio string to a seeded city slug, applying
 * the alias map first then a direct slugify match. Returns undefined
 * if nothing maps; callers fall back to mxStateToCity().
 */
export function mxMunicipioToCity(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const slug = slugify(raw);
  if (!slug) return undefined;
  if (MX_MUNI_ALIASES[slug]) return MX_MUNI_ALIASES[slug];
  return slug;
}
