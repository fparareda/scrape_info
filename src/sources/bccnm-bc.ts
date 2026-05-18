import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";

/**
 * BCCNM — BC College of Nurses and Midwives · public register.
 *
 *   https://www.bccnm.ca/Public/Pages/Default.aspx
 *
 * Universe: ~60,000 RN/RPN/LPN/RM registrants across British Columbia
 * (the unified register since 2020).
 *
 * Status at 2026-05-18: the SharePoint shell loads (HTTP 200, ~57 KB
 * of HTML) but the actual search is a SharePoint/SAP CRM widget that
 * POSTs to an internal `.svc` JSON endpoint. The widget injects a
 * MicrosoftAjax form-digest token (`__REQUESTDIGEST`) plus a session
 * cookie tied to the SharePoint farm. Reproducing the full token dance
 * deterministically without a headless browser is brittle (the digest
 * rotates).
 *
 * Per repo policy (no Playwright/headless) this ships as an honest STUB.
 * Wiring complete; real adapter is a 2-4h job once token rotation is
 * pinned (or trivially via Playwright).
 *
 * Category: enfermeria. Province: BC. Authority: BCCNM.
 * Off by default — `PROLIO_RUN_BCCNM_BC=true`.
 * Limit env: `PROLIO_BCCNM_BC_LIMIT` (default 80_000).
 */

const SOURCE_NAME = "bccnm-bc" as ScrapeSource;

export const bccnmBcSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_BCCNM_BC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runBccnmBc(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!bccnmBcSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  console.log(
    "[bccnm-bc] STUB — BCCNM public register is a SharePoint widget with " +
      "rotating __REQUESTDIGEST. Wiring complete. ~60k pending.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
