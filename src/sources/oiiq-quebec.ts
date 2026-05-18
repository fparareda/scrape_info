import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";

/**
 * OIIQ — Ordre des infirmières et infirmiers du Québec · "Trouvez une
 * infirmière" public register.
 *
 *   https://www.oiiq.org/en/trouvez-une-infirmiere
 *
 * Universe: ~80,000 registered nurses (infirmières et infirmiers) in
 * Québec.
 *
 * Status at 2026-05-18: the canonical URL redirects to /error404 from
 * datacenter IPs and the host is fronted by Cloudflare. The actual
 * search form is rendered client-side by Sitecore + a custom JSON
 * endpoint under `/_layouts/15/OIIQ.Tableau/`. Reaching it requires
 * `cf_clearance` + an anti-CSRF token; reproducing the flow without a
 * real browser is not stable.
 *
 * Per repo policy (no Playwright/headless; CF → stub), this ships as an
 * honest STUB. Wiring complete; real adapter is a 2-3h job with a
 * residential proxy + Playwright.
 *
 * Category: enfermeria. Province: QC. Authority: OIIQ.
 * Off by default — `PROLIO_RUN_OIIQ_QUEBEC=true`.
 * Limit env: `PROLIO_OIIQ_QUEBEC_LIMIT` (default 100_000).
 */

const SOURCE_NAME = "oiiq-quebec" as ScrapeSource;

export const oiiqQuebecSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_OIIQ_QUEBEC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOiiqQuebec(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!oiiqQuebecSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  console.log(
    "[oiiq-quebec] STUB — OIIQ 'Trouvez une infirmière' is CF-protected; " +
      "real flow needs residential IP + Playwright. ~80k pending.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
