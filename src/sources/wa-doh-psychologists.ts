/**
 * Washington State DOH — licensed psychologists.
 *
 * Dataset: data.wa.gov / qxh8-f4bd
 * (Health Care Provider Credential Data)
 *
 * Pre-flight (2026-06-16):
 *   robots.txt at data.wa.gov does not block /resource/. No auth required.
 *   7,666 active "Psychologist License" records confirmed via live API call.
 *   No city/address field available — records stored at province granularity
 *   (citySlug = "", metadata.province_slug = "wa").
 *
 * CategoryKey: psicologia (zero existing US coverage for this category).
 * Off by default. Enable via PROLIO_RUN_WA_DOH_PSYCHOLOGISTS=true.
 * Cap via PROLIO_WA_DOH_PSYCHOLOGISTS_LIMIT (default 10000).
 * Monthly cadence via .github/workflows/scrape-wa-doh-psychologists.yml.
 */

import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { fetchSocrataJson, socrataPick } from "./_socrata-utils.js";

const HOST = "data.wa.gov";
const VIEW_ID = "qxh8-f4bd";
const SOURCE_NAME = "wa-doh-psychologists" as const;
const DEFAULT_LIMIT = 10_000;

const WHERE =
  "CredentialType like 'Psychologist License%' AND Status = 'Active'";

function buildName(last: string, first: string, middle: string): string {
  return [first.trim(), middle.trim(), last.trim()]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());
}

export const waDohPsychologistsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_WA_DOH_PSYCHOLOGISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runWaDohPsychologists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
} | null> {
  if (!waDohPsychologistsSource.enabled()) return null;

  const rawLimit = Number(
    process.env.PROLIO_WA_DOH_PSYCHOLOGISTS_LIMIT ?? DEFAULT_LIMIT,
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
        ]) ?? "Psychologist License";
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
          sourceId: `wa-doh-psychologists:${credNum}`,
          name,
          categoryKey: "psicologia",
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
    console.log(`[wa-doh-psychologists] no records found`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[wa-doh-psychologists] done — fetched=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
