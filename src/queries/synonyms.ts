import type { CategoryKey } from "../prolio-types.js";

type QueryLocale = "es" | "en" | "fr";

/**
 * Per-category phrasings per locale, used to widen Google Places +
 * OSM coverage. Each synonym is combined with a location suffix
 * (barrio + city, or just city) to form a Text Search query. Keep
 * tight — every synonym multiplies the API budget.
 *
 * "itv" is ES-only (the concession model doesn't exist in EN/FR
 * countries we serve) — we leave the EN/FR arrays empty and
 * targets.ts skips `itv` for non-ES cities.
 */
export const CATEGORY_SYNONYMS: Record<CategoryKey, Record<QueryLocale, string[]>> = {
  fiscal: {
    es: ["asesor fiscal", "gestoría", "asesoría fiscal"],
    en: ["tax advisor", "tax accountant", "chartered accountant"],
    fr: ["conseiller fiscal", "comptable agréé", "cabinet comptable"],
  },
  extranjeria: {
    es: ["abogado extranjería", "abogado inmigración", "abogado nacionalidad"],
    en: ["immigration lawyer", "immigration attorney", "immigration consultant"],
    fr: ["avocat immigration", "conseiller immigration", "avocat en droit des étrangers"],
  },
  psicologia: {
    es: ["psicólogo", "psicóloga sanitaria", "centro psicología"],
    en: ["psychologist", "therapist", "mental health clinic"],
    fr: ["psychologue", "thérapeute", "cabinet de psychologie"],
  },
  medicina: {
    es: ["médico privado", "clínica médica", "centro médico privado"],
    en: ["private doctor", "medical clinic", "walk-in clinic"],
    fr: ["médecin privé", "clinique médicale", "clinique sans rendez-vous"],
  },
  dentista: {
    es: ["dentista", "clínica dental", "odontólogo"],
    en: ["dentist", "dental clinic", "orthodontist"],
    fr: ["dentiste", "cabinet dentaire", "orthodontiste"],
  },
  fisioterapia: {
    es: ["fisioterapeuta", "fisioterapia deportiva", "centro de fisioterapia"],
    en: ["physiotherapist", "physical therapist", "physiotherapy clinic"],
    fr: ["kinésithérapeute", "kiné", "centre de kinésithérapie"],
  },
  veterinario: {
    es: ["veterinario", "clínica veterinaria", "hospital veterinario"],
    en: ["veterinarian", "vet clinic", "animal hospital"],
    fr: ["vétérinaire", "clinique vétérinaire", "hôpital vétérinaire"],
  },
  notario: {
    es: ["notario", "notaría", "notario público"],
    en: ["notary", "notary public", "civil-law notary"],
    fr: ["notaire", "office notarial", "étude de notaire"],
  },
  arquitecto: {
    es: ["arquitecto", "estudio de arquitectura", "despacho de arquitectos"],
    en: ["architect", "architecture firm", "architectural office"],
    fr: ["architecte", "agence d'architecture", "cabinet d'architecte"],
  },
  cerrajero: {
    es: ["cerrajero", "cerrajería 24h", "urgencias cerrajero", "cerrajero apertura"],
    en: ["locksmith", "emergency locksmith", "24h locksmith"],
    fr: ["serrurier", "serrurier urgence", "serrurier 24h"],
  },
  hvac: {
    es: ["aire acondicionado", "instalador climatización", "bomba de calor", "aerotermia"],
    en: ["hvac contractor", "air conditioning installer", "heat pump installer"],
    fr: ["climaticien", "installateur climatisation", "pompe à chaleur"],
  },
  carpinteria: {
    es: ["carpintero", "carpintería madera", "muebles a medida"],
    en: ["carpenter", "cabinet maker", "custom woodwork"],
    fr: ["menuisier", "ébéniste", "meubles sur mesure"],
  },
  fontaneria: {
    es: ["fontanero", "fontanero urgencias", "reparación fugas"],
    en: ["plumber", "emergency plumber", "leak repair"],
    fr: ["plombier", "plombier urgence", "réparation de fuite"],
  },
  electricidad: {
    es: ["electricista", "electricista boletín", "instalador eléctrico"],
    en: ["electrician", "licensed electrician", "electrical contractor"],
    fr: ["électricien", "entrepreneur électricien", "installateur électrique"],
  },
  mecanica: {
    es: ["taller mecánico", "mecánico coches", "taller reparación"],
    en: ["auto repair", "mechanic", "car garage"],
    fr: ["garage automobile", "mécanicien", "atelier de réparation"],
  },
  itv: {
    es: ["ITV", "estación ITV", "inspección técnica vehículos"],
    en: [],
    fr: [],
  },
  ingenieria: {
    es: ["ingeniero", "ingeniera", "ingeniería"],
    en: ["engineer", "engineering"],
    fr: ["ingénieur", "ingénierie"],
  },
  enfermeria: {
    es: ["enfermero", "enfermera", "DUE", "enfermería"],
    en: ["nurse", "registered nurse", "RN", "LPN"],
    fr: ["infirmier", "infirmière", "IDE", "infirmier libéral"],
  },
  farmacia: {
    es: ["farmacéutico", "farmacia", "farmacéutica"],
    en: ["pharmacist", "pharmacy", "chemist"],
    fr: ["pharmacien", "pharmacie", "pharmacien d'officine"],
  },
  abogado: {
    es: ["abogado", "abogada", "despacho de abogados", "letrado"],
    en: ["lawyer", "attorney", "law firm", "barrister"],
    fr: ["avocat", "avocate", "cabinet d'avocats"],
  },
};
