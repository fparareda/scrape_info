import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";

/**
 * OCP — Ontario College of Pharmacists · TCPR public register.
 *
 *   https://members.ocpinfo.com/                — landing (HTTP 200)
 *   https://members.ocpinfo.com/tcpr/public/pr/en/   — TCPR search shell
 *
 * Universe: ~17,000 pharmacists + ~4,500 pharmacies (technicians +
 * facilities) registered in Ontario.
 *
 * Status at 2026-05-18: the landing page returns 200 but the TCPR
 * application (Transparency Council on Public Registry) is a JSF /
 * PrimeFaces app with a ViewState token (`javax.faces.ViewState`) and a
 * `jsessionid` URL-segment. Submitting the search requires:
 *
 *   1. GET `/tcpr/public/pr/en/` → capture jsessionid cookie + viewState.
 *   2. POST `/tcpr/public/pr/en/` with `javax.faces.partial.ajax=true`
 *      + form fields (including a per-form ViewState). Server responds
 *      with `<partial-response>` XML containing an updated ViewState
 *      and a results fragment.
 *   3. Repeat for each pagination block.
 *
 * Plumbing is achievable without a browser but the JSF/PrimeFaces dance
 * is fragile (viewstate is stateful, single-use, sessionid timeouts).
 * Per repo policy (any uncertain stateful protocol → stub first to land
 * wiring, drop in real adapter later), this ships as an honest STUB.
 *
 * Category: farmacia. Province: ON. Authority: OCP.
 * Off by default — `PROLIO_RUN_OCP_PHARMACY=true`.
 * Limit env: `PROLIO_OCP_PHARMACY_LIMIT` (default 25_000).
 */

const SOURCE_NAME = "ocp-pharmacy" as ScrapeSource;

export const ocpPharmacySource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_OCP_PHARMACY === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOcpPharmacy(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!ocpPharmacySource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  console.log(
    "[ocp-pharmacy] STUB — TCPR JSF/PrimeFaces flow with stateful " +
      "ViewState. Wiring complete. ~17k pharmacists + 4.5k pharmacies pending.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
