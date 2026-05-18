import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";

/**
 * Statistics Canada — Canadian Business Counts (CBC, formerly
 * Canadian Business Patterns Data, "CBR" = Canadian Business
 * Register marketing alias).
 *
 * Catalog landing:
 *   https://www150.statcan.gc.ca/n1/en/type/data?MM=1
 *   https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=3310109701
 *
 * Bulk CSV (curl-verified 2026-05-18, HTTP/2 200, ~17 MB zip):
 *   https://www150.statcan.gc.ca/n1/tbl/csv/33101097-eng.zip
 *   (Table 33-10-1097: CBC with employees, CMA & CSD, December 2025)
 *   Sister tables: 33-10-1095/1096 (national, with/without employees).
 *
 * REALITY CHECK (2026-05-18) — why this ships as an honest STUB:
 *   The CBC tables are AGGREGATE COUNTS by
 *      (NAICS × CSD × employment-size-band).
 *   They do NOT contain establishment names, addresses, or any
 *   row-level identifier. The Business Register microdata (which
 *   does) is confidential under the Statistics Act and only
 *   accessible inside an RDC. A 1M-row CSV looks like:
 *
 *      "REF_DATE","GEO","DGUID","Employment size","NAICS","UOM",
 *      "VECTOR","VALUE", ...
 *      "2025-12","Toronto","2021S05033520005","Total, with employees",
 *      "Offices of physicians [6211]","Number","v...","4521", ...
 *
 *   Without a name/address per row we cannot synthesise prolio
 *   `ScrapedProfessional` entries. Per repo policy ("Don't fake"
 *   — honest stub when the endpoint is real but unusable for our
 *   shape), this file ships wired but inert, documenting the dead
 *   end so the next agent doesn't re-discover it.
 *
 *   The actual establishment-level Canadian data we DO land in this
 *   wave comes from `toronto-business-licenses` and
 *   `vancouver-business-licenses`. Provincial open-data portals
 *   (Calgary, Edmonton, Montreal, Halifax) are the natural next step.
 *
 * Env:
 *   PROLIO_RUN_STATCAN_CBR=true   enable
 *
 * Off by default.
 */

const SOURCE_NAME = "statcan-cbr" as ScrapeSource;

export const statcanCbrSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_STATCAN_CBR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runStatcanCbr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!statcanCbrSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  console.log(
    "[statcan-cbr] STUB — StatCan CBC bulk CSV is real and open " +
      "(33-10-1097, curl-verified 2026-05-18) but contains only " +
      "aggregate counts by NAICS×CSD×size-band; no establishment " +
      "names/addresses. Business Register microdata is confidential. " +
      "Wiring complete (env, runner, workflow). Useful as a coverage " +
      "ground-truth check, not as a row source.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
