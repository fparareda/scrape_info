import type { ScrapedProfessional, ScraperSource } from "../types.js";

/**
 * Florida DBPR — Department of Business and Professional Regulation.
 *
 * STATUS (2026-05-14 pre-flight): BLOCKED — kept as honest stub.
 *
 * The previously documented CSV bulk path (`www2.myfloridalicense.com/
 * datadownload/`) returns the WordPress marketing site, not a download
 * portal. No `.csv` / `.zip` / `.xlsx` artefacts are linked anywhere
 * under that subdomain. The earlier hard-coded
 * `cilb_certified.csv` URL was speculative and yielded 0 rows.
 *
 * The two real public surfaces are both gated:
 *
 *   1. `https://www.myfloridalicense.com/wl11.asp` — classic ASP form
 *      (POST). Probe 2026-05-14:
 *        - HTTP 200 OK on GET (29 kB form).
 *        - All result tables driven by an opaque server-side session
 *          state (hidden `hSID` field + Cookie). POSTing a City search
 *          without a SID re-renders the empty form (no error message,
 *          just the same shell). Replaying a fresh SID requires
 *          executing the JS that pre-populates Division → Board →
 *          LicenseType cascades.
 *        - There is no documented JSON/REST shim; the dropdowns are
 *          populated via ASPSESSIONID-bound XHRs.
 *      Implementable only with Playwright. Not worth the runtime in
 *      this iteration vs. yield from NPI/state boards we already have.
 *
 *   2. MQA "Public Data Portal"
 *      (`https://data-download.mqa.flhealthsource.gov/`) — Azure B2C
 *      sign-up wall (`mqab2c.onmicrosoft.com/B2C_1_susi_dd`). Requires
 *      account creation + email verification before any download. Not
 *      automatable inside GitHub Actions without a managed identity.
 *
 * What ships instead:
 *   - `fl-doh-mqa` covers ALL FL healthcare licensees (~1M+ active)
 *     via the public CSV export on the MQA license-verification form,
 *     which is fully open (no auth, no captcha, no session).
 *   - The DBPR construction/electrical/architecture/cosmetology side
 *     stays uncovered for now. Reactivation path:
 *       a) Playwright adapter that drives wl11.asp through Division →
 *          Board → LicenseType → County, harvests each result page.
 *       b) Or a public-records FOIA request for the weekly DBPR
 *          extract (Florida Sunshine Law guarantees it; turnaround is
 *          typically 5–10 business days).
 *
 * Source literal `florida-dbpr` is preserved so legacy telemetry rows
 * keep their FK; flag `PROLIO_RUN_FLORIDA_DBPR` is also preserved.
 * Both the per-target `fetch()` and the bulk `runFloridaDbpr()` are
 * intentional no-ops that log the block reason so /admin shows a
 * skipped (not crashed) row.
 */

const BLOCK_REASON =
  "FL DBPR: session-bound ASP form (wl11.asp) + Azure-B2C-gated MQA portal — no public CSV";

export const floridaDbprSource = {
  name: "florida-dbpr",
  enabled() {
    return process.env.PROLIO_RUN_FLORIDA_DBPR === "true";
  },
  async fetch(): Promise<ScrapedProfessional[]> {
    return [];
  },
} satisfies ScraperSource as ScraperSource;

export async function runFloridaDbpr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!floridaDbprSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  console.warn(`[florida-dbpr] skipped — ${BLOCK_REASON}`);
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
