import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";

/**
 * CRNA — College of Registered Nurses of Alberta · public register
 * search.
 *
 *   https://search.nurses.ab.ca/
 *   (legacy CRNA, now part of CRPNA / Alberta Nurses umbrella)
 *
 * Universe: ~40,000 RN registrants in Alberta.
 *
 * Status at 2026-05-18: the `search.nurses.ab.ca` host does not resolve
 * from this network slice (TLS connect = 0). It's a single-page React
 * app that talks to a private GraphQL/REST API behind Akamai bot mitig.
 * Even when reachable, the front door enforces a `_abck` cookie + sensor
 * data POST that requires a real browser to mint.
 *
 * Per repo policy (no Playwright; Akamai BMP → stub) this ships as an
 * honest STUB. Wiring complete; real adapter needs residential IP and
 * either Playwright or a captured `_abck` cookie refreshed periodically.
 *
 * Category: enfermeria. Province: AB. Authority: CRNA.
 * Off by default — `PROLIO_RUN_ALBERTA_CRNA=true`.
 * Limit env: `PROLIO_ALBERTA_CRNA_LIMIT` (default 50_000).
 */

const SOURCE_NAME = "alberta-crna" as ScrapeSource;

export const albertaCrnaSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_ALBERTA_CRNA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runAlbertaCrna(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!albertaCrnaSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  console.log(
    "[alberta-crna] STUB — search.nurses.ab.ca unreachable from datacenter " +
      "IPs (Akamai BMP). Wiring complete. ~40k pending.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
