import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";

/**
 * LSO — Law Society of Ontario · lawyer & paralegal directory (lawyer
 * side).
 *
 *   https://lso.ca/public-resources/finding-a-lawyer-or-paralegal/lawyer-and-paralegal-directory
 *   https://lawyerdirectory.lso.ca/ (subdomain, sometimes resolves)
 *
 * Universe: ~55,000 licensed lawyers in Ontario (separate from the
 * ~10k paralegals already covered by `lso.ca-paralegals` adapter if
 * present — this slug targets the lawyer side specifically).
 *
 * Status at 2026-05-18: the directory landing page returns Cloudflare
 * "Just a moment…" challenge (HTTP 403 + cf-mitigated header) to any
 * datacenter IP. The search backend is a private REST endpoint at
 * `/find/api/v1/search` that requires `cf_clearance` + a JWT minted by
 * the page bootstrap. Without a real browser to solve the challenge
 * the call cannot be replayed.
 *
 * Per repo policy (CF Turnstile/JS challenge → stub) this ships as an
 * honest STUB. Wiring complete; real adapter requires residential proxy
 * + Playwright. Once landed it nearly triples Ontario abogado coverage.
 *
 * Category: abogado. Province: ON. Authority: LSO.
 * Off by default — `PROLIO_RUN_LSO_BAR_ONTARIO=true`.
 * Limit env: `PROLIO_LSO_BAR_ONTARIO_LIMIT` (default 70_000).
 */

const SOURCE_NAME = "lso-bar-ontario" as ScrapeSource;

export const lsoBarOntarioSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_LSO_BAR_ONTARIO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runLsoBarOntario(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!lsoBarOntarioSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  console.log(
    "[lso-bar-ontario] STUB — LSO lawyer directory is CF-challenged. " +
      "Wiring complete. ~55k lawyers pending.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
