import type { ScrapedProfessional, ScraperSource } from "../types.js";

/**
 * State Bars Bulk — US attorney rosters (CA + TX + NY).
 *
 * Goal:        ~1.3M attorneys (CA 250k, TX 110k, NY 180k + smaller bars).
 * Categoría:   abogado
 *
 * --- 2026-05-18 pre-flight probes (datacenter IP) ----------------------
 * California Bar
 *   GET https://apps.calbar.ca.gov/attorney/Members/AdvancedSearch
 *     → 200, Drupal/ASP.NET hybrid. Form posts redirect to
 *       /attorney/LicenseeSearch/QuickSearch which requires CSRF token +
 *       Drupal form_build_id + session cookie. Result pages are paginated
 *       HTML — no JSON endpoint, no bulk download (deprecated 2018).
 *   The MemberDataDownload.aspx endpoint returns 404 (retired).
 *
 * Texas Bar
 *   GET https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer
 *     → 302 → search form. POST returns 200 HTML but per-search is
 *       throttled (15 calls/IP/15min via ColdFusion server). No bulk
 *       downloadable roster — the Texas Office of Court Administration
 *       roster is sold via a paid feed (per 2024 OCA price sheet).
 *
 * New York (OCA Attorney Search)
 *   HEAD https://iapps.courts.state.ny.us/attorneyservices/search
 *     → 403 (Akamai bot manager; datacenter IPs blocked outright).
 *
 * --- Decision ---------------------------------------------------------
 * None of the three bars expose a bulk download from cloud egress
 * without buying the feed (TX) or solving CSRF + CAPTCHA + WAF (CA, NY).
 * Per CLAUDE.md "no Playwright, no fake data" → STUB.
 *
 * The slug is registered so a future adapter (residential proxy +
 * paid TX OCA feed) can land without touching the runner.
 *
 * Reactivate when:
 *   a) any state publishes a bulk CSV (track open-data portals),
 *   b) Prolio buys the TX OCA feed (then point
 *      `PROLIO_TX_OCA_ROSTER_CSV` at the file and generalise),
 *   c) a residential-proxy adapter exists.
 */

export const stateBarsBulkSource: ScraperSource = {
  name: "state-bars-bulk",
  enabled() {
    return process.env.PROLIO_RUN_STATE_BARS_BULK === "true";
  },
  async fetch(): Promise<ScrapedProfessional[]> {
    const txCsv = process.env.PROLIO_TX_OCA_ROSTER_CSV;
    if (txCsv) {
      console.warn(
        `[state-bars-bulk] PROLIO_TX_OCA_ROSTER_CSV=${txCsv} set but parser not implemented in this version. Drop the file into a future bulk loader.`,
      );
    }
    console.warn(
      "[state-bars-bulk] STUB — CA + TX + NY bars all blocked from " +
        "datacenter egress (probed 2026-05-18: CSRF, 302 throttle, 403). " +
        "Returning [].",
    );
    return [];
  },
};

export async function runStateBarsBulk(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!stateBarsBulkSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  console.warn(
    "[state-bars-bulk] enabled but pipeline is a stub — see source header.",
  );
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
