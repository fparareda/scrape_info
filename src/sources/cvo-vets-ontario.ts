import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";

/**
 * CVO — College of Veterinarians of Ontario · public member search.
 *
 *   https://members.cvo.org/cvomembersearch
 *
 * Universe: ~5,000 licensed veterinarians in Ontario.
 *
 * Status at 2026-05-18: `members.cvo.org` does not resolve / connect
 * from this network slice (curl TLS = 0). The application is iMIS 20+
 * (`/cvomembersearch` is the iMIS shortcut to an iqA-driven query).
 * Reaching it requires:
 *
 *   1. GET landing → capture ASP.NET session cookie + RequestVerification
 *      token.
 *   2. POST to `/iCore/Contacts/Search` with the iqA query GUID + filter
 *      JSON. The iMIS pattern is already covered by `_imis-utils.ts` and
 *      reused by `engineers-ns`, `nsbs-ns`, `pegnl-nl`, `lsnb-bar`.
 *
 * Once DNS reaches the host, a real adapter is ~1h work reusing the
 * iMIS helper. For now this ships as an honest STUB with wiring in
 * place.
 *
 * Category: veterinario. Province: ON. Authority: CVO.
 * Off by default — `PROLIO_RUN_CVO_VETS_ONTARIO=true`.
 * Limit env: `PROLIO_CVO_VETS_ONTARIO_LIMIT` (default 8_000).
 */

const SOURCE_NAME = "cvo-vets-ontario" as ScrapeSource;

export const cvoVetsOntarioSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_CVO_VETS_ONTARIO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCvoVetsOntario(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cvoVetsOntarioSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  console.log(
    "[cvo-vets-ontario] STUB — members.cvo.org unreachable from current " +
      "network slice; iMIS-hosted, reusable via _imis-utils. ~5k pending.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
