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
