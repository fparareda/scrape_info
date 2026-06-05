import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, pick } from "./_bulk-utils.js";

/**
 * Texas Behavioral Health Executive Council (BHEC) — Psychologists.
 *
 * BHEC publishes daily-refreshed CSV bulk drops for each licensed
 * profession it regulates. PSY.csv contains the full Texas psychologist
 * roster (~10k active licensees as of 2026-06).
 *
 * Pre-flight (2026-06-05):
 *   URL: https://www.bhec.texas.gov/csv/PSY.csv
 *   robots.txt: /csv/ is NOT restricted (only /wp-admin/ and
 *     /wp-content/uploads/wpforms/ are disallowed — confirmed live).
 *   HTTP 200, text/csv, ~500 KB, updated daily.
 *   No login, no CAPTCHA, no Cloudflare.
 *
 * CSV columns (header after normaliseHeaderKey):
 *   lic_type  — 5202 (numeric code for psychologist)
 *   rank      — LSP = Licensed Specialist in Psychology
 *   lic_nbr   — licence number (stable sourceId key)
 *   entity_nbr
 *   last_nme, first_nme, middle_nme, sfx_nme
 *   lic_status   — "Active" / "Inactive" / "Expired" / …
 *   lic_expr_dte, rank_efct_dte
 *   discpl_actn  — "No" / "Yes"
 *
 * No address or city field — all rows are state-level TX.
 * citySlug = "" and metadata.province_slug = "TX" per the province-level
 * pattern used by other state-bulk sources (CMS-PECOS, HIFLD-US).
 * Sink writes city_slug = NULL; downstream enrichment can resolve city
 * once address data becomes available via a Public Information Act request.
 *
 * Maps to `psicologia` — first dedicated US psychology state-board source.
 * Off by default; enable via PROLIO_RUN_TEXAS_BHEC_PSY=true.
 * Monthly cadence (scrape-texas-bhec-psy.yml) — annual licence renewals.
 */

const CSV_URL =
  process.env.PROLIO_TEXAS_BHEC_PSY_CSV ??
  "https://www.bhec.texas.gov/csv/PSY.csv";
const DEFAULT_LIMIT = 20_000;
const REQUEST_TIMEOUT_MS = 120_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

async function fetchCsv(): Promise<string | null> {
  try {
    const response = await fetch(CSV_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[texas-bhec-psy] HTTP ${response.status} on ${CSV_URL}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    console.error(
      `[texas-bhec-psy] fetch error: ${(error as Error).message}`,
    );
    return null;
  }
}

function toTitleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildName(row: Record<string, string>): string {
  const first = toTitleCase(pick(row, ["first_nme"]));
  const middle = toTitleCase(pick(row, ["middle_nme"]));
  const last = toTitleCase(pick(row, ["last_nme"]));
  const suffix = pick(row, ["sfx_nme"]).trim();
  const parts = [first, middle, last].filter(Boolean);
  const name = parts.join(" ").trim();
  return suffix ? `${name}, ${suffix}` : name;
}

export const texasBhecPsySource: ScraperSource = {
  name: "texas-bhec-psy" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_TEXAS_BHEC_PSY === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runTexasBhecPsy(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!texasBhecPsySource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_TEXAS_BHEC_PSY_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const raw = await fetchCsv();
  if (!raw) {
    console.warn("[texas-bhec-psy] CSV fetch failed — skipping");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rows = parseCsv(raw);
  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedInactive = 0;
  let droppedNoLicence = 0;
  let droppedNoName = 0;

  for (const row of rows) {
    if (records.length >= cap) break;

    const licNbr = pick(row, ["lic_nbr"]);
    if (!licNbr) {
      droppedNoLicence += 1;
      continue;
    }

    const status = pick(row, ["lic_status"]).trim();
    if (!/^active$/i.test(status)) {
      droppedInactive += 1;
      continue;
    }

    const sourceId = `texas-bhec-psy:${licNbr}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const name = buildName(row);
    if (!name) {
      droppedNoName += 1;
      continue;
    }

    const rank = pick(row, ["rank"]);
    const expiryDate = pick(row, ["lic_expr_dte"]);
    const rankEffectiveDate = pick(row, ["rank_efct_dte"]);
    const discplAction = pick(row, ["discpl_actn"]);

    records.push(
      normalise({
        source: "texas-bhec-psy" as ScrapeSource,
        country: "US",
        sourceId,
        name,
        categoryKey: "psicologia",
        citySlug: "",
        licenseNumber: licNbr,
        metadata: {
          country: "US",
          state: "TX",
          province_slug: "TX",
          authority: "Texas BHEC",
          verified_by_authority: true,
          rank: rank || undefined,
          expiry_date: expiryDate || undefined,
          rank_effective_date: rankEffectiveDate || undefined,
          disciplinary_action: /^yes$/i.test(discplAction),
          license_status: status,
        },
      }),
    );
  }

  console.log(
    `[texas-bhec-psy] parsed=${records.length} ` +
      `droppedInactive=${droppedInactive} droppedNoLicence=${droppedNoLicence} ` +
      `droppedNoName=${droppedNoName}`,
  );

  if (records.length === 0) {
    console.log(
      "[texas-bhec-psy] no records — CSV may be empty or all inactive",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[texas-bhec-psy] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
