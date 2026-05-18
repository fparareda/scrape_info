import type { ScrapedProfessional, ScraperSource } from "../types.js";

/**
 * ADA Find-a-Dentist — American Dental Association consumer directory.
 *
 * URL:        https://findadentist.ada.org/
 * Categoría:  dentista (US, ~200k members)
 *
 * --- 2026-05-18 pre-flight probe (datacenter IP) ----------------------
 *   GET  https://findadentist.ada.org/         → HTTP/2 403
 *     content-type: text/plain
 *     "Access Unavailable. We're sorry, but this service is currently
 *      unavailable. Please try again later or contact support if you
 *      believe this is an error."
 *   POST https://findadentist.ada.org/api/search → 403 (same body)
 *
 * The site sits behind a WAF (Akamai/Bot Manager) that refuses any
 * datacenter / cloud egress. Browser + residential IP get through (the
 * site itself is a SPA that calls a JSON API), but every GH Actions
 * runner egress is blocked. No bulk download / public API exists.
 *
 * Per CLAUDE.md "no Playwright, no fake data" rule → STUB.
 *
 * Off by default. Honest empty source. Reactivate when one of:
 *   a) ADA exposes a public bulk endpoint (track:
 *      https://www.ada.org/about/ada-product-catalog),
 *   b) we ship a residential-proxy adapter
 *      (see PROLIO_SCRAPE_PROXY infrastructure — not in scope here),
 *   c) ADA whitelists Prolio's egress IP.
 *
 * Until then this file just registers the slug so the workflow + types
 * land without dummy rows.
 */

export const adaFindADentistSource: ScraperSource = {
  name: "ada-find-a-dentist",
  enabled() {
    return process.env.PROLIO_RUN_ADA_FIND_A_DENTIST === "true";
  },
  async fetch(): Promise<ScrapedProfessional[]> {
    console.warn(
      "[ada-find-a-dentist] STUB — datacenter IPs receive HTTP 403 " +
        "(WAF block, probed 2026-05-18). No public bulk endpoint. " +
        "Returning [].",
    );
    return [];
  },
};

export async function runAdaFindADentist(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!adaFindADentistSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  console.warn(
    "[ada-find-a-dentist] enabled but pipeline is a stub — see source header.",
  );
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
