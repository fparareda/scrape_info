import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, pick, toTitleCase } from "./_bulk-utils.js";

/**
 * IRS Enrolled Agent FOIA Bulk CSV — national directory of active
 * Enrolled Agents (EAs), published bi-annually under FOIA.
 *
 * URL:
 *   https://www.irs.gov/pub/foia/active-ea-foia-listing-march-2026.csv
 *   (filename rotates each cycle; override via PROLIO_IRS_EA_FOIA_CSV)
 *
 * Pre-flight 2026-05-24 (datacenter IP):
 *   GET https://www.irs.gov/pub/foia/active-ea-foia-listing-march-2026.csv
 *     → HTTP 200, content-type: text/csv, last-modified: 2026-04-01
 *   robots.txt: `/pub/foia/` NOT in any Disallow rule → permitted
 *   Auth / CAPTCHA: none
 *   Total records: 154,375 (69,144 US + 85,231 international)
 *   Fields: First Name, Middle Name, Last Name,
 *            Address Line 1, Address Line 2, Address Line 3,
 *            City, State, Zip, Country
 *
 * Enrolled Agents hold a federal credential (IRS-issued license) that
 * authorises them to represent taxpayers in all IRS matters. This is
 * distinct from the IRS PTIN FOIA per-state extracts (which cover all
 * PTIN holders — CPAs, attorneys, unenrolled preparers, and EAs — via
 * 51 state-slug files). The EA FOIA is a single national file with a
 * different schema (no PTIN, no phone, no website) and specifically
 * identifies the Enrolled Agent credential.
 *
 * Category: `fiscal`. Country: US (rows where Country = "United States").
 * Off by default — `PROLIO_RUN_IRS_EA_FOIA=true` to enable.
 * Cap via `PROLIO_IRS_EA_FOIA_LIMIT` (default 10 000).
 * Override CSV URL via `PROLIO_IRS_EA_FOIA_CSV`.
 */

const DEFAULT_CSV_URL =
  "https://www.irs.gov/pub/foia/active-ea-foia-listing-march-2026.csv";
const DEFAULT_LIMIT = 10_000;
const CATEGORY: CategoryKey = "fiscal";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 120_000;

export const irsEaFoiaSource: ScraperSource = {
  name: "irs-ea-foia" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_IRS_EA_FOIA === "true";
  },
  async fetch() {
    return [];
  },
};

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_IRS_EA_FOIA_CSV ?? DEFAULT_CSV_URL;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`[irs-ea-foia] network error: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[irs-ea-foia] HTTP ${response.status} on ${url}`);
    return [];
  }

  const text = await response.text();
  const rows = parseCsv(text);

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  let droppedForeign = 0;
  let droppedNoCity = 0;
  let droppedNoName = 0;

  for (const row of rows) {
    if (out.length >= limit) break;

    // Keep US records only
    const country = pick(row, ["country"]);
    if (country && country.toLowerCase() !== "united states") {
      droppedForeign += 1;
      continue;
    }

    // Build name: First [Middle] Last
    const firstName = pick(row, ["first name"]);
    const middleName = pick(row, ["middle name"]);
    const lastName = pick(row, ["last name"]);

    // Some records have lastName = "." (placeholder) — skip those
    const lastClean = lastName && lastName !== "." ? lastName : "";
    const raw = [firstName, middleName, lastClean]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!raw) {
      droppedNoName += 1;
      continue;
    }
    const name = toTitleCase(raw);
    if (!name) {
      droppedNoName += 1;
      continue;
    }

    const city = pick(row, ["city"]);
    if (!city) {
      droppedNoCity += 1;
      continue;
    }
    const citySlug = slugify(city);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }

    // Deduplicate on name + city + zip
    const zip = pick(row, ["zip"]);
    const key = `${name.toLowerCase()}|${citySlug}|${zip ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const stateCode = pick(row, ["state"]) ?? "";
    const addr1 = pick(row, ["address line 1"]);
    const addr2 = pick(row, ["address line 2"]);
    const addr3 = pick(row, ["address line 3"]);
    const addrParts = [addr1, addr2, addr3, city, stateCode, zip].filter(Boolean);
    const address = addrParts.join(", ") || undefined;

    out.push(
      normalise({
        source: "irs-ea-foia" as ScrapeSource,
        country: "US",
        sourceId: `irs-ea-foia:${key}`,
        name,
        categoryKey: CATEGORY,
        citySlug,
        address,
        metadata: {
          country: "US",
          state: stateCode || null,
          authority: "IRS — Enrolled Agent Program",
          verified_by_authority: true,
          credential: "Enrolled Agent",
          zip: zip || null,
        },
      }),
    );
  }

  console.log(
    `[irs-ea-foia] parsed=${out.length} ` +
      `droppedForeign=${droppedForeign} droppedNoCity=${droppedNoCity} ` +
      `droppedNoName=${droppedNoName}`,
  );
  return out;
}

export async function runIrsEaFoia(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!irsEaFoiaSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_IRS_EA_FOIA_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(cap);

  if (records.length === 0) {
    console.warn("[irs-ea-foia] 0 records fetched — endpoint may be down");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[irs-ea-foia] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
