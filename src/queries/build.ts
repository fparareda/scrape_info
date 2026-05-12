import type { CategoryKey } from "../prolio-types.js";
import { CATEGORY_SYNONYMS } from "./synonyms.js";
import { MADRID_BARRIOS } from "./madrid-barrios.js";
import { BARCELONA_BARRIOS } from "./barcelona-barrios.js";

/**
 * Build Google Places Text Search queries for a (category, city, locale)
 * triple. Madrid + Barcelona get a barrio × synonym fan-out (dense,
 * hits the 60-result pagination cap without it). Everywhere else gets
 * plain "<synonym> <connector> <city>" queries.
 *
 * Connector varies by locale — "en" in ES, "in" in EN, "à" in FR.
 * Query count per target:
 *   - Madrid / Barcelona: barrios × synonyms  (≈ 36)
 *   - Other cities:       synonyms            (≈ 3)
 */
export function buildQueries(
  categoryKey: CategoryKey,
  citySlug: string,
  cityName: string,
  queryLocale: "es" | "en" | "fr" = "es",
): string[] {
  const synonyms = CATEGORY_SYNONYMS[categoryKey]?.[queryLocale] ?? [];
  if (synonyms.length === 0) return [];
  const connector = CONNECTORS[queryLocale];
  const barrios = BARRIOS_BY_CITY[citySlug];

  if (barrios) {
    return barrios.flatMap((barrio) =>
      synonyms.map((syn) => `${syn} ${connector} ${barrio} ${cityName}`),
    );
  }
  return synonyms.map((syn) => `${syn} ${connector} ${cityName}`);
}

const CONNECTORS: Record<"es" | "en" | "fr", string> = {
  es: "en",
  en: "in",
  fr: "à",
};

const BARRIOS_BY_CITY: Record<string, readonly string[]> = {
  madrid: MADRID_BARRIOS,
  barcelona: BARCELONA_BARRIOS,
};
