import type { ScrapeSource, ScraperSource } from "../types.js";

/**
 * Indiana Professional Licensing Agency (PLA) — Architect & Engineer registry.
 *
 * Pre-flight 2026-05-19:
 *
 * The Indiana PLA oversees 60+ licensed professions including Architects and
 * Engineers (~3–5k architects, ~10k+ engineers in Indiana). Two access paths
 * were evaluated:
 *
 *   1. MuleSoft REST API (publicly documented, requires free credential
 *      registration via email to madoades@pla.in.gov):
 *        GET https://mulesoft.in.gov/pla-everification-api-v1-p/api/
 *            PLALicenseInformation   → profession catalog
 *        GET .../search?profession=Architects&licStatus=Active → licensees
 *      robots.txt on in.gov has no Disallow rules for this path.
 *      BLOCKED: free credentials required — obtain via email to PLA.
 *
 *   2. eVerification web UI (https://mylicense.in.gov/everification/Search.aspx):
 *      Publicly accessible server-rendered HTML, no login required.
 *      BLOCKED: ASP.NET WebForms with stateful __VIEWSTATE postbacks —
 *      follows the same pattern flagged for AILA (see competitor-us-bar-
 *      associations.ts) requiring Playwright for reliable page interaction.
 *
 * This source ships as an HONEST STUB: all wiring (ScrapeSource type, env
 * flag, runner registration, cron workflow) is in place. When either (a)
 * API credentials are obtained (add PROLIO_INDIANA_PLA_API_KEY to GitHub
 * secrets) or (b) a Playwright adapter is available, the full implementation
 * can replace this stub and immediately publish arquitecto + ingenieria rows
 * for an uncovered US state.
 *
 * Categories: arquitecto, ingenieria (both currently absent from US coverage).
 * State: Indiana (IN). Authority: Indiana PLA.
 * Off by default — PROLIO_RUN_INDIANA_PLA=true.
 */

const SOURCE_NAME = "indiana-pla" as ScrapeSource;

export const indianaPlaSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_INDIANA_PLA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runIndianaPla(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!indianaPlaSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const apiKey = process.env.PROLIO_INDIANA_PLA_API_KEY;
  if (!apiKey) {
    console.warn(
      "[indiana-pla] STUB — MuleSoft API requires PROLIO_INDIANA_PLA_API_KEY. " +
        "Request free credentials from Indiana PLA (madoades@pla.in.gov). " +
        "Web UI fallback (mylicense.in.gov/everification/Search.aspx) requires " +
        "Playwright for reliable __VIEWSTATE interaction. " +
        "All wiring is in place; replace this log with the adapter when ready.",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  // Full implementation placeholder — activate once API key is available.
  // Endpoint structure (publicly documented):
  //   GET https://mulesoft.in.gov/pla-everification-api-v1-p/api/PLALicenseInformation
  //     Headers: { client_id: apiKey, client_secret: <secret> }
  //     → JSON array of { Code, Description } (profession catalog)
  //
  //   GET .../search?profession=Architects&licStatus=Active&page=1&pageSize=1000
  //     → JSON array of { Full_Name, License_Number, Profession, License_Status,
  //                       City, State, ZIP, County, Issuance_Date, Expiration_Date }
  //
  // Map: Profession contains "Architect" → categoryKey "arquitecto"
  //      Profession contains "Engineer"  → categoryKey "ingenieria"
  // city slug: slugify(City) — cross-reference seeded US cities.

  console.warn("[indiana-pla] STUB — API key present but adapter not yet implemented.");
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
