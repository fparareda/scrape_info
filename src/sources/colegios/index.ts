import type { ScraperSource } from "../../types.js";
import { copcSource } from "./copc.js";

/**
 * Registry of colegio-backed scrapers. Each module is a self-contained
 * ScraperSource: it decides which (categoryKey, citySlug) targets it can
 * serve, fetches publicly available colegiado data, and returns
 * normalised rows. Keep one file per colegio so we can extract the
 * scraper into its own worker or repo later without rewiring consumers.
 *
 * Currently wired:
 *  - COPC (Catalonia, psicologia) → covers Barcelona
 *
 * Next up: COPMadrid (psicologia → madrid), COPAO (Sevilla), and the
 * abogacía/fiscal equivalents (ICAM, AEDAF) when their endpoints are
 * mapped.
 */
export const COLEGIO_SOURCES: ScraperSource[] = [copcSource];
