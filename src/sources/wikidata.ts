/**
 * Wikidata SPARQL enrichment.
 *
 * Pulls authority entities (hospitales, colegios oficiales, universidades,
 * organismos) from Wikidata and inserts them as Prolio pros with
 * `source='wikidata'`. Completely free (CC0, no key), unlimited with a
 * courteous rate limit.
 *
 * Query pattern (SPARQL):
 *   SELECT ?item ?itemLabel ?coord ?website ?phone ?address ?city WHERE {
 *     ?item wdt:P31/wdt:P279* wd:Q16917.  # instance of hospital
 *     ?item wdt:P17 wd:Q29.                # country = Spain
 *     OPTIONAL { ?item wdt:P625 ?coord. }
 *     OPTIONAL { ?item wdt:P856 ?website. }
 *     OPTIONAL { ?item wdt:P1329 ?phone. }
 *     OPTIONAL { ?item wdt:P131 ?city. }
 *     SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". }
 *   }
 *
 * Endpoint: https://query.wikidata.org/sparql (returns JSON).
 *
 * Enabled via PROLIO_SCRAPE_WIKIDATA=true.
 */

import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional } from "../types.js";
import { normalise, slugify } from "../normalise.js";

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "Prolio/0.1 (https://prolio.co; ferranp.work@gmail.com)";

/**
 * Wikidata classes we care about, mapped to our categories.
 * Q16917 = hospital, Q7075 = library (skipped), Q16560 = university.
 * Prolio only covers a few of the Wikidata taxonomy branches; more
 * can be added as we launch verticals (e.g. farmacia, dental).
 */
const WIKIDATA_QUERIES: Array<{ category: CategoryKey; entity: string }> = [
  { category: "medicina", entity: "wd:Q16917" }, // hospital
  { category: "medicina", entity: "wd:Q1774898" }, // private hospital
  { category: "medicina", entity: "wd:Q4287745" }, // medical clinic
];

interface SparqlRow {
  item?: { value: string };
  itemLabel?: { value: string };
  coord?: { value: string }; // "Point(lng lat)"
  website?: { value: string };
  phone?: { value: string };
  cityLabel?: { value: string };
  addressLine?: { value: string };
}

interface SparqlResponse {
  results?: { bindings?: SparqlRow[] };
}

function parseCoord(v?: string): { lat?: number; lng?: number } {
  if (!v) return {};
  const m = v.match(/^Point\(([-0-9.]+) ([-0-9.]+)\)$/);
  if (!m) return {};
  return { lng: Number(m[1]), lat: Number(m[2]) };
}

async function runQuery(entity: string): Promise<SparqlRow[]> {
  const sparql = `
    SELECT DISTINCT ?item ?itemLabel ?coord ?website ?phone ?cityLabel ?addressLine WHERE {
      ?item wdt:P31/wdt:P279* ${entity}.
      ?item wdt:P17 wd:Q29.
      OPTIONAL { ?item wdt:P625 ?coord. }
      OPTIONAL { ?item wdt:P856 ?website. }
      OPTIONAL { ?item wdt:P1329 ?phone. }
      OPTIONAL { ?item wdt:P131 ?city. }
      OPTIONAL { ?item wdt:P6375 ?addressLine. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". }
    }
    LIMIT 2000
  `;
  const url = `${ENDPOINT}?query=${encodeURIComponent(sparql)}&format=json`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
  });
  if (!response.ok) {
    console.error(
      `[wikidata] ${response.status} on ${entity}: ${(await response.text()).slice(0, 160)}`,
    );
    return [];
  }
  const data = (await response.json()) as SparqlResponse;
  return data.results?.bindings ?? [];
}

export async function runWikidataEnrichment(): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  for (const q of WIKIDATA_QUERIES) {
    const rows = await runQuery(q.entity);
    console.log(
      `[wikidata] ${q.entity} (${q.category}): ${rows.length} rows`,
    );
    for (const r of rows) {
      const qid = r.item?.value.match(/Q\d+$/)?.[0];
      const name = r.itemLabel?.value;
      const citySlug = r.cityLabel ? slugify(r.cityLabel.value) : "";
      if (!qid || !name || !citySlug) continue;
      const { lat, lng } = parseCoord(r.coord?.value);
      out.push(
        normalise({
          source: "wikidata",
          sourceId: qid,
          name,
          categoryKey: q.category,
          citySlug,
          website: r.website?.value,
          phone: r.phone?.value,
          address: r.addressLine?.value,
          lat,
          lng,
          metadata: { wikidata_qid: qid, wikidata_class: q.entity },
        }),
      );
    }
    // SPARQL endpoint is generous but we still space queries politely.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return out;
}

export function wikidataEnabled(): boolean {
  return process.env.PROLIO_SCRAPE_WIKIDATA === "true";
}
