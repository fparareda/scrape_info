/**
 * Washington State DOH — licensed dentists.
 *
 * Dataset: data.wa.gov / qxh8-f4bd
 * (Health Care Provider Credential Data — same view as wa-doh-psychologists)
 *
 * Pre-flight (2026-06-22):
 *   robots.txt at data.wa.gov does not block /resource/. No auth required.
 *   Confirmed via live API call: filtering CredentialType = 'Dentist License'
 *   AND Status = 'Active' returns ~6,800 active WA dentist records.
 *   No city/address field — records stored at province granularity
 *   (citySlug = "", metadata.province_slug = "wa").
 *   Same Socrata SODA pattern used by wa-doh-psychologists — zero new
 *   infrastructure needed.
 *
 * CategoryKey: dentista (fills WA gap in US dentista coverage).
 * Off by default. Enable via PROLIO_RUN_WA_DOH_DENTISTS=true.
 * Cap via PROLIO_WA_DOH_DENTISTS_LIMIT (default 10000).
 * Monthly cadence via .github/workflows/scrape-wa-doh-dentists.yml.
 */

import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { fetchSocrataJson, socrataPick } from "./_socrata-utils.js";

const HOST = "data.wa.gov";
const VIEW_ID = "qxh8-f4bd";
const SOURCE_NAME = "wa-doh-dentists" as const;
const DEFAULT_LIMIT = 10_000;

const WHERE = "CredentialType = 'Dentist License' AND Status = 'Active'";

function buildName(last: string, first: string, middle: string): string {
  return [first.trim(), middle.trim(), last.trim()]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());
}

export const waDohDentistsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_WA_DOH_DENTISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runWaDohDentists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
} | null> {
  if (!waDohDentistsSource.enabled()) return null;

  const rawLimit = Number(
    process.env.PROLIO_WA_DOH_DENTISTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for await (const page of fetchSocrataJson({
    host: HOST,
    viewId: VIEW_ID,
    where: WHERE,
    maxRows: limit,
  })) {
    for (const row of page) {
      const credNum = socrataPick(row, [
        "CredentialNumber",
        "credentialnumber",
        "credential_number",
      ]);
      if (!credNum) continue;
      if (seen.has(credNum)) continue;
      seen.add(credNum);

      const last =
        socrataPick(row, ["LastName", "lastname", "last_name"]) ?? "";
      const first =
        socrataPick(row, ["FirstName", "firstname", "first_name"]) ?? "";
      const middle =
        socrataPick(row, ["MiddleName", "middlename", "middle_name"]) ?? "";
      const name = buildName(last, first, middle);
      if (!name) continue;

      const credType =
        socrataPick(row, [
          "CredentialType",
          "credentialtype",
          "credential_type",
        ]) ?? "Dentist License";
      const status = socrataPick(row, ["Status", "status"]) ?? "";
      const expDate = socrataPick(row, [
        "ExpirationDate",
        "expirationdate",
        "expiration_date",
      ]);
      const issueDate = socrataPick(row, [
        "FirstIssueDate",
        "firstissuedate",
        "first_issue_date",
      ]);

      records.push(
        normalise({
          source: SOURCE_NAME,
          country: "US",
          sourceId: `wa-doh-dentists:${credNum}`,
          name,
          categoryKey: "dentista",
          citySlug: "",
          licenseNumber: credNum,
          metadata: {
            province_slug: "wa",
            state: "WA",
            country: "US",
            authority: "Washington State DOH",
            verified_by_authority: true,
            credential_type: credType,
            credential_status: status,
            expiration_date: expDate,
            first_issue_date: issueDate,
          },
        }),
      );
    }
  }

  if (records.length === 0) {
    console.log(`[wa-doh-dentists] no records found`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[wa-doh-dentists] done — fetched=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
