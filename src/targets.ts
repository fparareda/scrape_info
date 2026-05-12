import type { CategoryKey } from "./prolio-types.js";
import type { ScrapeTarget } from "./types.js";
import { getCities, type CountryCode } from "./cities.js";

const CATEGORIES_ALL: CategoryKey[] = [
  "fiscal",
  "extranjeria",
  "psicologia",
  "medicina",
  "carpinteria",
  "fontaneria",
  "electricidad",
  "mecanica",
  "itv",
];

/**
 * CEO decision (22 Apr 2026): Prolio focuses on abogados de extranjería
 * Madrid + Barcelona as the only wedge. To conserve scraping budget and
 * avoid bloating inventory we don't monetise, enable `PROLIO_WEDGE_ONLY`
 * to restrict scraping to `{extranjeria, fiscal}`. The other 7
 * categories keep their SEO pages live — we just stop refreshing their
 * inventory.
 *
 * Flip this off manually (`PROLIO_WEDGE_ONLY=false`) if the wedge
 * pivots or we expand a second vertical.
 */
const WEDGE_CATEGORIES: CategoryKey[] = ["extranjeria", "fiscal"];

function wedgeOnly(): boolean {
  // Default changed 2026-04-23: dual-wedge strategy = abogados/fiscal
  // (knowledge work, short-term revenue) PLUS trades/mecánica (AI-proof,
  // long-term moat). Trades have ~100× the TAM, lower ticket (€29 vs €49),
  // and can't be replaced by LLMs. We scrape ALL 9 categories by default;
  // flip this env to `true` only if Google Places credit drops critically
  // and we need to conserve.
  return process.env.PROLIO_WEDGE_ONLY === "true";
}

/**
 * ITV (Spanish state-licenced vehicle inspection concession) doesn't
 * map cleanly to Canada or the USA — Canadian provinces run "safety
 * inspection garages" that are closer to a regular mechanic, and most
 * US states fold inspection into DMV or into independent shops. Skip
 * the itv category for non-ES targets.
 */
function categoriesFor(country: CountryCode): CategoryKey[] {
  const base = country !== "ES"
    ? CATEGORIES_ALL.filter((c) => c !== "itv")
    : CATEGORIES_ALL;
  if (wedgeOnly()) {
    return base.filter((c) => WEDGE_CATEGORIES.includes(c));
  }
  return base;
}

const TOP10_NON_CAPITAL_ES = new Set([
  "valencia",
  "sevilla",
  "zaragoza",
  "malaga",
  "murcia",
  "palma",
  "las-palmas",
  "bilbao",
  "alicante",
  "cordoba",
]);

/**
 * Scrape targets = (category, city) pairs. CI splits the list across
 * parallel jobs via PROLIO_SCRAPE_SHARD so each shard fits inside the
 * 45-minute free-tier timeout.
 *
 * Shard filters take both slug AND country so we don't need to materialise
 * a SLUGS-by-country Set just to check membership. Country comes straight
 * from the DB row.
 */
type ShardFilter = (slug: string, country: CountryCode) => boolean;

const SHARDS: Record<string, ShardFilter> = {
  madrid:    (slug) => slug === "madrid",
  barcelona: (slug) => slug === "barcelona",
  top10:     (slug, country) => country === "ES" && TOP10_NON_CAPITAL_ES.has(slug),
  rest:      (slug, country) =>
    country === "ES" &&
    slug !== "madrid" &&
    slug !== "barcelona" &&
    !TOP10_NON_CAPITAL_ES.has(slug),
  canada:    (_slug, country) => country === "CA",
  usa:       (_slug, country) => country === "US",
  all:       () => true,
};

export async function listTargets(): Promise<ScrapeTarget[]> {
  const shardKey = (process.env.PROLIO_SCRAPE_SHARD ?? "all").toLowerCase();
  const shardFilter = SHARDS[shardKey] ?? SHARDS.all;
  const cities = await getCities({ country: "all" });
  const targets: ScrapeTarget[] = [];
  for (const city of cities) {
    if (!shardFilter(city.slug, city.country)) continue;
    for (const categoryKey of categoriesFor(city.country)) {
      targets.push({
        categoryKey,
        citySlug: city.slug,
        cityName: city.name,
        country: city.country,
        queryLocale: city.queryLocale,
      });
    }
  }
  return targets;
}
