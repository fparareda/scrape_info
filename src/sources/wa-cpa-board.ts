import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { fetchSocrataJson, socrataPick } from "./_socrata-utils.js";

/**
 * Washington State Board of Accountancy — CPA licensee dataset.
 *
 * Pre-flight 2026-06-09 (datacenter IP):
 *   Host: data.wa.gov (Socrata)
 *   View: 6du3-3h9e
 *   URL:  https://data.wa.gov/Consumer-Protection/Washington-State-Certified-Public-Accountants/6du3-3h9e
 *   HTTP 200, JSON API, no auth, no captcha, robots.txt allows.
 *   50,775 total rows (nightly refresh); active subset ~25–30k.
 *   Fields: firstname, lastname, city, country, number, status, originalissue, expires.
 *
 * First source for the `fiscal` CategoryKey in US. Maps to CPAs
 * (Certified Public Accountants), the US regulated profession closest
 * to "asesor fiscal" in the taxonomy. License issued by WA Board of
 * Accountancy; licensees may reside anywhere in the US.
 *
 * Off by default. Enable via PROLIO_RUN_WA_CPA_BOARD=true.
 * Cap via PROLIO_WA_CPA_BOARD_LIMIT (default 30000 — covers full active set).
 */

const HOST = "data.wa.gov";
const VIEW_ID = "6du3-3h9e";
const CATEGORY: CategoryKey = "fiscal";
const SOURCE_NAME = "wa-cpa-board" as const;
const DEFAULT_LIMIT = 30_000;

function isActive(status: string | undefined): boolean {
  if (!status) return false;
  return /^active$/i.test(status.trim());
}

function toTitleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchAll(maxRows: number): Promise<ScrapedProfessional[]> {
  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedInactive = 0;
  let droppedNoName = 0;
  let droppedNoCity = 0;
  let droppedNoLicense = 0;

  // Fetch all ~50k rows (dataset is small enough); filter active client-side.
  const FETCH_CAP = 60_000;

  for await (const page of fetchSocrataJson({
    host: HOST,
    viewId: VIEW_ID,
    pageSize: 1000,
    maxRows: FETCH_CAP,
  })) {
    for (const row of page) {
      const status = socrataPick(row, ["status"]);
      if (!isActive(status)) {
        droppedInactive += 1;
        continue;
      }

      const licenseNo = socrataPick(row, ["number", "license_number"]);
      if (!licenseNo) {
        droppedNoLicense += 1;
        continue;
      }

      const firstName = socrataPick(row, ["firstname", "first_name"]) ?? "";
      const lastName = socrataPick(row, ["lastname", "last_name"]) ?? "";
      const name = toTitleCase([firstName, lastName].filter(Boolean).join(" ")).trim();
      if (!name) {
        droppedNoName += 1;
        continue;
      }

      const cityRaw = socrataPick(row, ["city"]);
      const citySlug = cityRaw ? slugify(cityRaw) : undefined;
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      const sourceId = `wa-cpa-board:${licenseNo}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      records.push(
        normalise({
          source: SOURCE_NAME,
          country: "US",
          sourceId,
          name,
          categoryKey: CATEGORY,
          citySlug,
          licenseNumber: licenseNo,
          metadata: {
            country: "US",
            state: "WA",
            authority: "Washington State Board of Accountancy",
            license_status: status,
            original_issue: socrataPick(row, ["originalissue"]),
            expires: socrataPick(row, ["expires"]),
            verified_by_authority: true,
          },
        }),
      );

      if (records.length >= maxRows) break;
    }
    if (records.length >= maxRows) break;
  }

  console.log(
    `[wa-cpa-board] parsed=${records.length} ` +
      `droppedInactive=${droppedInactive} droppedNoName=${droppedNoName} ` +
      `droppedNoCity=${droppedNoCity} droppedNoLicense=${droppedNoLicense}`,
  );
  return records;
}

export const waCpaBoardSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_WA_CPA_BOARD === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runWaCpaBoard(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!waCpaBoardSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_WA_CPA_BOARD_LIMIT ?? DEFAULT_LIMIT);
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(maxRows);
  if (records.length === 0) {
    console.warn("[wa-cpa-board] no records fetched — endpoint may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[wa-cpa-board] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
