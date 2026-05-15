import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchIn1touchRoster } from "./_in1touch-utils.js";

/**
 * SCPP — Saskatchewan College of Pharmacy Professionals.
 *
 * Public register of ~2k Saskatchewan pharmacists is hosted at
 *   https://saskpharm.ca/site/find-a-pharmacist
 * and powered by in1touch. The shell page exposes the search form whose
 * hidden inputs identify the pharmacist roster (`clientRosterId=484`,
 * `productIds=5345` for the "pharmacist" membership-class filter).
 *
 * We POST to `/client/roster/clientRosterView.html` page by page and
 * parse the rendered `registryBlock` rows. No structured detail page is
 * scraped — only name + membership class + effective/expiry dates are
 * exposed without burning a per-record HTTP request.
 *
 * Category: `medicina` (proxy — there is no dedicated `farmacia`
 * category at the moment and prolio surfaces pharmacy professionals
 * under the medical umbrella). Province SK, country CA.
 *
 * Off by default; `PROLIO_RUN_SCPP_SK_PHARMACISTS=true` to enable.
 */

const SEARCH_URL =
  process.env.PROLIO_SCPP_SK_SEARCH_URL ||
  "https://saskpharm.ca/client/roster/clientRosterView.html";
const CLIENT_ROSTER_ID = process.env.PROLIO_SCPP_SK_ROSTER_ID || "484";
const DEFAULT_LIMIT = 5_000;

// Hidden filter inputs lifted from the find-a-pharmacist shell page.
// `productIds=5345` = the pharmacist membership-class subscription;
// `notProductIds=5460` excludes the technician roster; `status=Active`
// hides retired/inactive members; `and=true` requires all filters.
const EXTRA_FIELDS = {
  "clientForm.subscriptionFilter.productIds": "5345",
  "_clientForm.subscriptionFilter.productIds": "on",
  "_clientForm.subscriptionFilter.status": "on",
  "clientForm.subscriptionFilter.status": "Active",
  "_clientForm.subscriptionFilter.invoiceStatus": "on",
  "clientForm.subscriptionFilter.notProductIds": "5460",
  "clientForm.subscriptionFilter.and": "true",
};

export const scppSkPharmacistsSource: ScraperSource = {
  name: "scpp-sk-pharmacists",
  enabled() {
    return process.env.PROLIO_RUN_SCPP_SK_PHARMACISTS === "true";
  },
  async fetch() {
    return [];
  },
};

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  let yielded = 0;
  try {
    for await (const rec of fetchIn1touchRoster(SEARCH_URL, CLIENT_ROSTER_ID, {
      limit,
      extraFields: EXTRA_FIELDS,
    })) {
      const sourceId = rec.clientId
        ? `scpp-sk:${rec.clientId}`
        : `scpp-sk:name:${rec.name.toLowerCase()}`;
      out.push(
        normalise({
          source: "scpp-sk-pharmacists",
          sourceId,
          name: toTitleCase(rec.name),
          categoryKey: "medicina",
          // Province-wide register; SCPP does not expose per-pharmacist city
          // in the public roster. Default to Saskatoon (the largest SK city)
          // as a proxy so the row satisfies the prolio citySlug contract.
          citySlug: "saskatoon",
          licenseNumber: rec.clientId,
          metadata: {
            country: "CA",
            province: "SK",
            authority: "SCPP",
            register: "pharmacist",
            membership_class: rec.status,
            effective: rec.effective,
            expires: rec.expires,
            verified_by_authority: true,
          },
        }),
      );
      yielded += 1;
    }
  } catch (error) {
    console.error(
      `[scpp-sk-pharmacists] iteration failed after ${yielded} rows:`,
      (error as Error).message,
    );
  }
  return out;
}

export async function runScppSkPharmacists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!scppSkPharmacistsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_SCPP_SK_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    console.warn(`[scpp-sk-pharmacists] fetched 0 records`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[scpp-sk-pharmacists] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
