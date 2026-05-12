import type { ScraperSource } from "../../types.js";
import { copcSource } from "./copc.js";
import { copmSource } from "./copm.js";
import { coamSource } from "./coam.js";

/**
 * Registry of colegio-backed scrapers. Each module is a self-contained
 * ScraperSource: it decides which (categoryKey, citySlug) targets it can
 * serve, fetches publicly available colegiado data, and returns
 * normalised rows. Keep one file per colegio so we can extract the
 * scraper into its own worker or repo later without rewiring consumers.
 *
 * Currently wired:
 *  - COPC (Catalonia, psicologia) → covers Barcelona
 *  - COPM (Madrid, psicologia) → Madrid + área metropolitana
 *  - COAM (Madrid, arquitectura) → Madrid + área metropolitana
 *
 * Next up: ICAM (abogados Madrid), ICAB (abogados BCN), CGCOM
 * (médicos nacional), CSCAE (arquitectos nacional). National colegios
 * fold many provincial colegios into a single scraper but require
 * search-form interaction (POST + JS) — defer until the simpler
 * autonomic ones are stable.
 */
export const COLEGIO_SOURCES: ScraperSource[] = [
  copcSource,
  copmSource,
  coamSource,
];
