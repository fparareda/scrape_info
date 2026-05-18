import type { CategoryKey } from "../../prolio-types.js";
import { SPANISH_CITIES } from "../../cities.js";

/**
 * Target CNAE codes (Clasificación Nacional de Actividades Económicas)
 * for Prolio's regulated-profession scope. Mapping CNAE → CategoryKey
 * is one-to-one for the categories Prolio currently surfaces in the
 * public directory; CNAEs without a Prolio category (69.10 abogados,
 * 71.11 arquitectos, 71.12 ingenieros) are tracked here so the CNAE is
 * still attached to metadata for future backfill, but their entries are
 * dropped at classification time until those category keys exist.
 */
export const CNAE_TO_CATEGORY: Record<string, CategoryKey | null> = {
  "69.10": null, // actividades jurídicas — no Prolio key yet
  "69.20": "fiscal", // contabilidad / asesoría fiscal
  "86.22": "medicina", // actividades médicas especializadas
  "71.11": null, // arquitectura — no Prolio key yet
  "71.12": null, // ingeniería — no Prolio key yet
  "43.21": "electricidad", // instalaciones eléctricas
  "43.22": "fontaneria", // fontanería + climatización
  "43.32": "carpinteria", // carpintería
  "45.20": "mecanica", // mantenimiento + reparación vehículos
};

export const ALL_TARGET_CNAES = Object.keys(CNAE_TO_CATEGORY);

/**
 * Reverse lookup CategoryKey → primary CNAE — used when classification
 * comes from `Objeto social` keywords (BORME rarely prints the numeric
 * code) so metadata still carries the canonical CNAE. Keys without a
 * clean CNAE bucket (psicologia, extranjeria, itv) are intentionally
 * absent so we never claim a code that doesn't fit.
 */
export const CATEGORY_TO_CNAE: Partial<Record<CategoryKey, string>> = {
  fiscal: "69.20",
  medicina: "86.22",
  dentista: "86.23",
  fisioterapia: "86.90",
  veterinario: "75.00",
  arquitecto: "71.11",
  hvac: "43.22",
  electricidad: "43.21",
  fontaneria: "43.22",
  carpinteria: "43.32",
  mecanica: "45.20",
};

/**
 * Keywords looked for in the company's `Objeto social`. Precision matters
 * more than recall here: BORME is noisy, and a bad match pollutes the
 * public directory until someone reports it. Keep these tight.
 */
const CATEGORY_KEYWORDS: Record<CategoryKey, string[]> = {
  fiscal: [
    "asesoria fiscal",
    "asesoramiento fiscal",
    "asesoramiento tributario",
    "consultoria fiscal",
    "consultoria tributaria",
    "gestoria",
    "asesoria contable y fiscal",
    "servicios de asesoramiento contable",
    "servicios de asesoria fiscal",
  ],
  extranjeria: [
    "asesoramiento juridico en materia de extranjeria",
    "asesoria juridica en extranjeria",
    "derecho de extranjeria",
    "asistencia juridica a extranjeros",
    "inmigracion",
    "tramitacion de visados",
    "nacionalidad española",
  ],
  psicologia: [
    "psicologia clinica",
    "psicologia sanitaria",
    "servicios de psicologia",
    "consulta de psicologia",
    "terapia psicologica",
    "atencion psicologica",
    "salud mental",
    "psicoterapia",
  ],
  medicina: [
    "consulta medica",
    "servicios medicos privados",
    "centro medico",
    "clinica medica",
    "asistencia medica privada",
    "servicios sanitarios",
  ],
  dentista: [
    "clinica dental",
    "consulta dental",
    "consulta odontologica",
    "servicios odontologicos",
    "odontologia",
    "ortodoncia",
    "implantologia dental",
  ],
  fisioterapia: [
    "fisioterapia",
    "centro de fisioterapia",
    "consulta de fisioterapia",
    "rehabilitacion fisica",
    "tratamientos fisioterapicos",
  ],
  veterinario: [
    "clinica veterinaria",
    "consulta veterinaria",
    "servicios veterinarios",
    "hospital veterinario",
    "atencion veterinaria",
  ],
  notario: [
    "notaria",
    "servicios notariales",
    "actividad notarial",
  ],
  arquitecto: [
    "estudio de arquitectura",
    "servicios de arquitectura",
    "proyectos arquitectonicos",
    "despacho de arquitectos",
  ],
  cerrajero: [
    "cerrajeria",
    "servicios de cerrajeria",
    "instalacion y reparacion de cerraduras",
  ],
  hvac: [
    "instalacion de aire acondicionado",
    "instalacion de climatizacion",
    "instalacion de calefaccion",
    "instalacion de bombas de calor",
    "aerotermia",
  ],
  carpinteria: [
    "carpinteria",
    "carpinteria de madera",
    "fabricacion de muebles",
    "instalacion de carpinteria",
    "ebanisteria",
  ],
  fontaneria: [
    "fontaneria",
    "instalaciones de fontaneria",
    "reparacion de fontaneria",
    "instalaciones sanitarias",
  ],
  electricidad: [
    "instalaciones electricas",
    "electricidad",
    "servicios de electricidad",
    "reparaciones electricas",
    "boletines electricos",
  ],
  mecanica: [
    "taller mecanico",
    "reparacion de vehiculos",
    "mecanica de automoviles",
    "taller de reparacion",
  ],
  itv: [
    "inspeccion tecnica de vehiculos",
    "estacion itv",
    "itv",
  ],
  ingenieria: [
    "ingenieria",
    "ingeniero",
    "ingenieria civil",
    "ingenieria industrial",
  ],
  enfermeria: [
    "enfermeria",
    "servicios de enfermeria",
    "atencion de enfermeria",
    "cuidados de enfermeria",
    "venta al por menor de productos farmaceuticos",
  ],
  farmacia: [
    "farmacia",
    "oficina de farmacia",
    "servicios farmaceuticos",
    "farmaceutico",
    "venta al por menor de productos farmaceuticos",
  ],
  abogado: [
    "abogados",
    "abogacia",
    "actividades juridicas",
    "servicios juridicos",
    "asesoramiento juridico",
    "despacho de abogados",
    "bufete",
  ],
};

/** Strip diacritics, lowercase, collapse whitespace. */
export function normaliseText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyCategory(
  objetoSocial: string | undefined,
): CategoryKey | null {
  if (!objetoSocial) return null;
  const haystack = normaliseText(objetoSocial);
  for (const [category, needles] of Object.entries(CATEGORY_KEYWORDS) as Array<
    [CategoryKey, string[]]
  >) {
    if (needles.some((n) => haystack.includes(n))) return category;
  }
  return null;
}

/**
 * Best-effort extraction of an explicit CNAE code printed in the BORME
 * Objeto social blob. BORME does not mandate the code, so this returns
 * `null` for the majority of entries — callers fall back to keyword
 * classification + `CATEGORY_TO_CNAE`. Only returns codes in our target
 * set to avoid falsely tagging unrelated companies. Accepts forms like
 * `CNAE 69.20`, `CNAE: 69.20`, `CNAE-2009 69.20`, `(69.20)`.
 */
export function extractCnaeCode(text: string | undefined): string | null {
  if (!text) return null;
  const re = /\b(\d{2})\.(\d{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const code = `${m[1]}.${m[2]}`;
    if (code in CNAE_TO_CATEGORY) return code;
  }
  return null;
}

/**
 * Match a BORME domicilio against Prolio's 50 city slugs. Addresses look
 * like:
 *   "C/ EJEMPLO 23, 28013 MADRID"
 *   "CARRER BALMES 1, 08007 (BARCELONA)"
 *   "CL VALLE DE VALDEBEZANA, 63 09572 (VALLE DE VALDEBEZANA)"
 * We do a simple substring check on the normalised address against each
 * city's normalised name. Longer names (e.g. "L'Hospitalet de Llobregat")
 * win over shorter (e.g. "Llobregat") because we check in length-desc order.
 */
const CITY_PATTERNS: Array<{ slug: string; needle: string }> = SPANISH_CITIES
  .map((c) => ({ slug: c.slug, needle: normaliseText(c.name) }))
  .sort((a, b) => b.needle.length - a.needle.length);

export function matchCitySlug(domicilio: string | undefined): string | null {
  if (!domicilio) return null;
  const haystack = normaliseText(domicilio);
  for (const { slug, needle } of CITY_PATTERNS) {
    if (haystack.includes(needle)) return slug;
  }
  return null;
}
