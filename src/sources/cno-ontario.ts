import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";

/**
 * CNO — College of Nurses of Ontario · "Find a Nurse" public register.
 *
 *   https://www.cno.org/en/learn-about-standards-guidelines/find-a-nurse/
 *
 * Universe: ~180,000 active RN / RPN / NP registrants — largest single
 * nursing register in Canada and the biggest lever for CA coverage in
 * this wave.
 *
 * Status at 2026-05-18: the public landing page is fronted by Cloudflare
 * (server returns 404/Cloudflare challenge depending on path). The real
 * search UI lives in the CNO portal's React app and posts to an internal
 * JSON service that requires:
 *
 *   1. GET on the search page to obtain `__RequestVerificationToken` +
 *      Cloudflare clearance cookie (`cf_clearance`).
 *   2. POST to `/Public/RegisterSearch` (or similar tenant-specific
 *      endpoint) with the token, `lastName` filter and pagination
 *      parameters. CF challenges any direct datacenter IP that doesn't
 *      carry `cf_clearance`.
 *
 * Per repo policy (no Playwright/headless; CF Turnstile → stub) and the
 * `comb-barcelona` precedent, this source ships as an honest STUB: all
 * wiring (types, env flag, runner registration, workflow) is in place so
 * a real adapter (or a Playwright-backed worker run from a residential
 * IP) can drop in later and immediately publish ~180k rows.
 *
 * Category: enfermeria. Province: ON. Authority: CNO.
 * Off by default — `PROLIO_RUN_CNO_ONTARIO=true`.
 * Limit env: `PROLIO_CNO_ONTARIO_LIMIT` (default 200_000).
 */

const SOURCE_NAME = "cno-ontario" as ScrapeSource;

export const cnoOntarioSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_CNO_ONTARIO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCnoOntario(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cnoOntarioSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  console.log(
    "[cno-ontario] STUB — CNO 'Find a Nurse' is gated by Cloudflare + " +
      "anti-bot challenge. Wiring complete (env, runner, workflow). " +
      "~180k registrants pending a residential-IP/Playwright worker.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
