import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * Ordre des Architectes — French national architect register.
 *
 * Source: https://annuaire.architectes.org/  (POST form, no captcha,
 * no auth). Verified 2026-05-07 via Chrome MCP.
 *
 * Form contract:
 *   POST /  Content-Type: application/x-www-form-urlencoded
 *   body=type=tableau&posted=1&nom=&prenom=&cp=<CP>&ville=&code_region=&submit=Rechercher
 *
 * Result row markup (per probe):
 *   <div class="summary" rel="/architecte/A24563/">
 *     <span class="id">A24563</span>
 *     <span class="nom">JEANNEAU FRANCOIS</span>
 *     <span class="cp">PAYS-DE-LA-LOIRE</span>
 *   </div>
 *
 * Result limit: querying just by `ville=Paris` returns "Nombre trop
 * important de résultats" — the site caps at ~250 rows. We iterate by
 * postal code (CP) instead. Paris alone has ~120 CPs (75001-75020 +
 * arrondissements arriving the 75116/75XXX special codes), and the
 * top-20 metros cover the bulk of registered architects.
 *
 * Off by default. `PROLIO_RUN_ARCHITECTES_FR=true`. Cap with
 * `PROLIO_ARCHITECTES_FR_LIMIT` (default 2000). Cron is weekly so
 * iterating ~50 CPs per run keeps each run under 90 seconds.
 */

const ENDPOINT = "https://annuaire.architectes.org/";
const DEFAULT_LIMIT = 2000;
const REQUEST_DELAY_MS = 1500;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

/**
 * Major French metro postal codes. Ordered by population — the iter
 * stops once `limit` is reached so big metros come first. Only Paris,
 * Lyon, Marseille, Toulouse, Nice, Nantes, Strasbourg, Bordeaux for v1.
 */
const TARGET_POSTAL_CODES = [
  // Paris arrondissements
  "75001","75002","75003","75004","75005","75006","75007","75008",
  "75009","75010","75011","75012","75013","75014","75015","75016",
  "75017","75018","75019","75020",
  // Lyon
  "69001","69002","69003","69004","69005","69006","69007","69008","69009",
  // Marseille
  "13001","13002","13003","13004","13005","13006","13007","13008",
  "13009","13010","13011","13012","13013","13014","13015","13016",
  // Toulouse
  "31000","31100","31200","31300","31400","31500",
  // Nice
  "06000","06100","06200","06300",
  // Nantes
  "44000","44100","44200","44300",
  // Strasbourg
  "67000","67100","67200",
  // Bordeaux
  "33000","33100","33200","33300","33800",
];

/**
 * Maps the region-name string the form returns (e.g. "PAYS-DE-LA-LOIRE")
 * to a default Prolio city slug. The annuaire's `<span class="cp">`
 * carries the region label, NOT the postal code, so we use the
 * QUERY postal code to derive the city slug instead.
 */
const CP_TO_CITY: Record<string, string> = {};
for (const cp of TARGET_POSTAL_CODES) {
  if (cp.startsWith("75")) CP_TO_CITY[cp] = "paris";
  else if (cp.startsWith("69")) CP_TO_CITY[cp] = "lyon";
  else if (cp.startsWith("13") && cp >= "13001" && cp <= "13016") CP_TO_CITY[cp] = "marseille";
  else if (cp.startsWith("31")) CP_TO_CITY[cp] = "toulouse";
  else if (cp.startsWith("06")) CP_TO_CITY[cp] = "nice";
  else if (cp.startsWith("44")) CP_TO_CITY[cp] = "nantes";
  else if (cp.startsWith("67")) CP_TO_CITY[cp] = "strasbourg";
  else if (cp.startsWith("33")) CP_TO_CITY[cp] = "bordeaux";
}

const ROW_RE =
  /<div class="summary"\s+rel="\/architecte\/([^"]+)\/">[\s\S]*?<span class="id">([^<]+)<\/span>\s*<span class="nom">\s*([\s\S]*?)<\/span>\s*<span class="cp">([^<]*)<\/span>/g;

interface Architect {
  matricule: string;
  name: string;
  region: string;
}

async function fetchByPostalCode(cp: string): Promise<Architect[]> {
  const body = new URLSearchParams({
    type: "tableau",
    posted: "1",
    nom: "",
    prenom: "",
    cp,
    ville: "",
    code_region: "",
    submit: "Rechercher",
  }).toString();
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    console.error(`[architectes-fr] cp=${cp} network: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[architectes-fr] cp=${cp} ${response.status}`);
    return [];
  }
  const html = await response.text();
  if (/trop important/i.test(html)) {
    console.warn(`[architectes-fr] cp=${cp} returned too-many-results — needs finer filter`);
    return [];
  }
  const out: Architect[] = [];
  const seen = new Set<string>();
  ROW_RE.lastIndex = 0;
  for (const match of html.matchAll(ROW_RE)) {
    const [, , id, name, region] = match;
    if (id && name && !seen.has(id)) {
      seen.add(id);
      out.push({ matricule: id, name: name.trim(), region: region.trim() });
    }
  }
  return out;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const globalSeen = new Set<string>();

  for (const cp of TARGET_POSTAL_CODES) {
    if (out.length >= limit) break;
    const citySlug = CP_TO_CITY[cp];
    if (!citySlug) continue;

    const rows = await fetchByPostalCode(cp);
    for (const row of rows) {
      if (out.length >= limit) break;
      if (globalSeen.has(row.matricule)) continue;
      globalSeen.add(row.matricule);
      out.push(
        normalise({
          source: "architectes-fr",
          sourceId: `architectes-fr:${row.matricule}`,
          name: toTitleCase(row.name),
          categoryKey: "arquitecto",
          citySlug,
          licenseNumber: row.matricule,
          metadata: {
            country: "FR",
            authority: "Ordre des Architectes",
            verified_by_authority: true,
            postal_code: cp,
            region: row.region,
          },
        }),
      );
    }
    console.log(`[architectes-fr] cp=${cp} → ${rows.length} rows`);
    await delay(REQUEST_DELAY_MS);
  }
  console.log(`[architectes-fr] total parsed=${out.length}`);
  return out;
}

export const architectesFrSource: ScraperSource = {
  name: "architectes-fr",
  enabled() {
    return process.env.PROLIO_RUN_ARCHITECTES_FR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runArchitectesFr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!architectesFrSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_ARCHITECTES_FR_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[architectes-fr] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
