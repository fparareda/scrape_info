import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import {
  parseCsv,
  pick,
  normaliseNorthAmericanPhone,
} from "./_bulk-utils.js";

/**
 * IRS PTIN Preparer Directory — bi-annual FOIA bulk CSV.
 *
 * The IRS publishes a public FOIA extract of all active PTIN holders
 * (CPAs, enrolled agents, attorneys, unenrolled preparers). Per-state
 * plain CSV files at:
 *   https://www.irs.gov/pub/foia/foia-<state>-extract.csv
 *
 * Pre-flight (2026-05-14):
 *   - robots.txt: /pub/foia/ NOT in any Disallow rule → permitted
 *   - No auth / no CAPTCHA
 *   - 16-column CSV confirmed from live Alabama sample
 *   - Fields: LAST_NAME, First_NAME, MIDDLE_NAME, SUFFIX, DBA,
 *     BUS_ADDR_LINE1-3, BUS_ADDR_CITY, BUS_ST_CODE, BUS_ADDR_ZIP,
 *     BUS_CNTRY_CDE, WEBSITE, BUS_PHNE_NBR, PROFESSION, AFSP_Indicator
 *   - Update cadence: bi-annually (Feb 23, 2026 was most recent)
 *
 * This source fills the `fiscal` category gap — the only national US
 * source covering tax professionals in the taxonomy.
 *
 * Off by default. `PROLIO_RUN_IRS_PTIN=true` to enable.
 * Cap via `PROLIO_IRS_PTIN_LIMIT` (default 5000).
 * Override base URL via `PROLIO_IRS_PTIN_BASE_URL` if IRS rotates.
 */

const DEFAULT_BASE_URL = "https://www.irs.gov/pub/foia";
const DEFAULT_LIMIT = 5000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 120_000;

// All 50 states + DC in alphabetical order, matching IRS file naming.
const STATE_SLUGS = [
  "alabama", "alaska", "arizona", "arkansas", "california",
  "colorado", "connecticut", "delaware", "district-of-columbia", "florida",
  "georgia", "hawaii", "idaho", "illinois", "indiana",
  "iowa", "kansas", "kentucky", "louisiana", "maine",
  "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new-hampshire",
  "new-jersey", "new-mexico", "new-york", "north-carolina", "north-dakota",
  "ohio", "oklahoma", "oregon", "pennsylvania", "rhode-island",
  "south-carolina", "south-dakota", "tennessee", "texas", "utah",
  "vermont", "virginia", "washington", "west-virginia", "wisconsin",
  "wyoming",
];

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const baseUrl =
    process.env.PROLIO_IRS_PTIN_BASE_URL || DEFAULT_BASE_URL;

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCity = 0;
  let droppedNoName = 0;
  let droppedForeign = 0;

  for (const stateSlug of STATE_SLUGS) {
    if (out.length >= limit) break;

    const url = `${baseUrl}/foia-${stateSlug}-extract.csv`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      console.error(
        `[irs-ptin] network error on ${stateSlug}: ${(error as Error).message}`,
      );
      continue;
    }

    if (!response.ok) {
      console.error(`[irs-ptin] ${response.status} on ${url}`);
      continue;
    }

    const rows = parseCsv(await response.text());
    let stateAdded = 0;

    for (const row of rows) {
      if (out.length >= limit) break;

      // Skip non-US records
      const country = pick(row, ["bus_cntry_cde"]);
      if (country && country !== "US" && country !== "USA") {
        droppedForeign += 1;
        continue;
      }

      // Build display name: prefer DBA (firm name), then personal name
      const dba = pick(row, ["dba"]);
      const firstName = pick(row, ["first_name"]);
      const lastName = pick(row, ["last_name"]);
      const middleName = pick(row, ["middle_name"]);
      const suffix = pick(row, ["suffix"]);

      let name: string;
      if (dba) {
        name = dba;
      } else if (firstName || lastName) {
        name = [firstName, middleName, lastName, suffix]
          .filter(Boolean)
          .join(" ")
          .trim();
      } else {
        droppedNoName += 1;
        continue;
      }
      if (!name) {
        droppedNoName += 1;
        continue;
      }

      const city = pick(row, ["bus_addr_city"]);
      if (!city) {
        droppedNoCity += 1;
        continue;
      }
      const citySlug = slugify(city);
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      const stateCode = pick(row, ["bus_st_code"]);

      // Stable dedup key: name + city + state (no PTIN in FOIA extract)
      const dedupeKey = `${name.toLowerCase().replace(/\s+/g, " ")}:${citySlug}:${stateCode.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const line1 = pick(row, ["bus_addr_line1"]);
      const line2 = pick(row, ["bus_addr_line2"]);
      const line3 = pick(row, ["bus_addr_line3"]);
      const street = [line1, line2, line3].filter(Boolean).join(", ");
      const zip = pick(row, ["bus_addr_zip"]);
      const address = [street, city, stateCode, zip].filter(Boolean).join(", ");

      const profession = pick(row, ["profession"]);
      const afsp = pick(row, ["afsp_indicator"]);
      const website = pick(row, ["website"]) || undefined;
      const phone = normaliseNorthAmericanPhone(pick(row, ["bus_phne_nbr"]) || undefined);

      out.push(
        normalise({
          source: "irs-ptin",
          // No PTIN exposed in FOIA extract; use composite key
          sourceId: `irs-ptin:${citySlug}:${stateCode.toLowerCase()}:${name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`,
          name,
          categoryKey: "fiscal",
          citySlug,
          phone,
          website: website || undefined,
          address: address || undefined,
          metadata: {
            country: "US",
            state: stateCode || stateSlug.toUpperCase().slice(0, 2),
            authority: "IRS PTIN Directory",
            verified_by_authority: true,
            profession: profession || "unenrolled",
            afsp_holder: afsp === "Y",
          },
        }),
      );
      stateAdded += 1;
    }

    console.log(
      `[irs-ptin] ${stateSlug}: rows=${rows.length} added=${stateAdded} total=${out.length}`,
    );
  }

  console.log(
    `[irs-ptin] parsed=${out.length} droppedNoCity=${droppedNoCity} droppedNoName=${droppedNoName} droppedForeign=${droppedForeign}`,
  );
  return out;
}

export const irsPtinSource: ScraperSource = {
  name: "irs-ptin",
  enabled() {
    return process.env.PROLIO_RUN_IRS_PTIN === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runIrsPtin(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!irsPtinSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_IRS_PTIN_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[irs-ptin] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
