import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeSource,
} from "../types.js";

/**
 * 411.ca — Canadian general-purpose business directory.  STUB.
 *
 *   https://411.ca/business/search?what=<term>&where=<city>&p=<N>
 *
 * Universe: ~3M Canadian businesses across schema.org-rendered cards.
 *
 * Status at 2026-05-27: **GHA-runner IPs are systematically blocked.**
 *
 *   - Pre-flight from a residential IP (my laptop, 2026-05-26): HTTP 200
 *     in ~1s, 25 cards rendered per page, all fields parseable. The
 *     v1 scraper landed on that basis (PR #99).
 *   - First GHA run (#26471784610) hit HTTP 403 on every URL despite
 *     identical request shape. We assumed Cloudflare was bot-UA-gated
 *     and switched to a Chrome UA in PR #105.
 *   - Second GHA run (#26522409627) still got HTTP 403 on every URL with
 *     the Chrome UA. The block is by **cloud-IP range**, not user-agent.
 *     411.ca's WAF treats GitHub Actions egress (Azure) as bot traffic
 *     and returns 403 regardless of headers.
 *
 * Restore options (none meet the repo's "no Playwright, no paid feeds"
 * rule today; documenting them for future work):
 *
 *   1. Residential-IP proxy (Bright Data / Oxylabs / smartproxy) — would
 *      route requests through real consumer ISPs. ~$200-500/mo.
 *   2. Self-hosted runner on a residential connection — moves the egress
 *      off Azure, but requires a machine on consumer ISP.
 *   3. Local bulk script (`tsx src/sources/411-ca.ts` run manually from
 *      a residential connection). The schema.org parsing in PR #99 still
 *      works from such a context; only the GHA runtime is blocked.
 *
 * The v1 implementation (city whitelist + 15-category enumeration +
 * schema.org card parser) lives in the git history at commit ada6f1a
 * and is ready to wire back when any of the above land.
 *
 * Category: generalist (per-row via slug keyword match).
 * Country: CA.
 * Off by default — `PROLIO_RUN_411_CA=true`.
 */

const SOURCE_NAME = "411-ca" as ScrapeSource;

export const fourElevenCaSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_411_CA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function run411Ca(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!fourElevenCaSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  console.log(
    "[411-ca] STUB — 411.ca returns HTTP 403 to all GitHub Actions egress " +
      "(cloud-IP block, not UA). v1 parser at commit ada6f1a; restore when " +
      "residential proxy or self-hosted runner lands.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
