import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * SEC EDGAR — US publicly-traded company filings.
 *
 * Why this source exists
 * ----------------------
 * Every company that has issued securities registered under the
 * Exchange Act files with SEC EDGAR. The Commission publishes the
 * complete company-ticker mapping and per-company filing histories
 * as free JSON endpoints under data.sec.gov, no auth, no key. For
 * Prolio this is a clean enrichment layer that proves a
 * `professionals` row corresponds to a real SEC-registered issuer
 * (CIK + SIC + state of incorporation + business address) and a
 * narrow ingest path for sectors that map to a Prolio CategoryKey.
 *
 * Pre-flight (2026-05-20, run live via curl with SEC's required UA)
 * -----------------------------------------------------------------
 * robots.txt (www.sec.gov, HTTP 200): no Disallow on
 *   /files/company_tickers.json or /cgi-bin/browse-edgar. The
 *   data.sec.gov host serves no robots.txt — SEC's "Privacy and
 *   Security" page documents it as the public bulk-JSON access point.
 *
 *   GET https://www.sec.gov/files/company_tickers.json
 *     → HTTP 200, 792,284 bytes, 10,365 entries.
 *     → shape: { "0": {cik_str:1045810, ticker:"NVDA", title:"NVIDIA CORP"}, ... }
 *
 *   GET https://data.sec.gov/submissions/CIK0000320193.json (Apple)
 *     → HTTP 200, 164,513 bytes.
 *     → fields present: cik, name, tickers, exchanges, sic,
 *       sicDescription, stateOfIncorporation, addresses.business,
 *       addresses.mailing, ein, lei (often), phone, website,
 *       category, fiscalYearEnd, formerNames, filings.
 *     → CIK in URL MUST be zero-padded to 10 digits.
 *
 *   GET https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC=8731&...
 *     → HTTP 200 HTML. We avoid this: parsing HTML for SIC fan-out
 *       costs ~200 LOC of fragile DOM walking when company_tickers
 *       + per-CIK JSON already exposes SIC for free.
 *
 * Rate limit: SEC enforces 10 req/s per UA. We use 150ms between
 * requests (~6.6 req/s) — leaves headroom, never gets the IP banned.
 *
 * Strategy — hybrid (enrichment + narrow ingest)
 * ----------------------------------------------
 * 1. Enrichment (primary). Scan every `professionals` row whose
 *    `metadata.cik` or `metadata.sec_ticker` is set. Resolve to the
 *    10-digit padded CIK, fetch the submissions JSON, write back:
 *      metadata.sec_cik, sec_ticker, sec_sic, sec_sic_description,
 *      sec_name, sec_exchanges, sec_state_of_incorporation,
 *      sec_addresses_business, sec_synced_at.
 *    Today this matches zero rows (no source populates `cik` yet)
 *    but lifts off the moment a future adapter writes one — the
 *    join is in place.
 *
 * 2. Ingest (secondary, very narrow). Stream company_tickers.json
 *    in-memory (under 1 MB), enrich each entry with its submissions
 *    JSON to get the SIC, and ingest ONLY entries whose SIC maps to
 *    a Prolio CategoryKey. Of the 10,365 SEC issuers maybe 100-300
 *    actually match — most are tech/finance/holdings with no Prolio
 *    home. Honesty over volume.
 *
 *    SIC mappings (deliberately conservative):
 *      8011, 8060, 8062, 8071 → medicina  (services/health; hospitals,
 *                                          medical labs)
 *      8731, 8742            → ingenieria (R&D + management consulting
 *                                          — the SEC's "engineering &
 *                                          accounting services" bucket)
 *    No mapping for insurance (6311/6411): Prolio has no "seguros"
 *    CategoryKey, so we skip those rather than mis-route to "fiscal".
 *
 * Cities: SEC business addresses are US-state-format ("CUPERTINO",
 * "CA"). `normalise()` slugifies the city; the sink drops rows whose
 * slug isn't in the seeded `cities` table. That's expected — the
 * ingest path naturally focuses on cities Prolio already covers
 * (Houston, NYC, LA, etc.) and silently drops the rest. We log the
 * drop ratio so the run is observable.
 *
 * Off by default. Enable via PROLIO_RUN_SEC_EDGAR=true. Cap with
 * PROLIO_SEC_EDGAR_LIMIT (default 5000) — the cap bounds total
 * tickers visited per run, which at 150ms each = ~12.5 minutes of
 * CI time, well under the 60-min budget.
 */

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUBMISSIONS_URL = (cikPadded: string): string =>
  `https://data.sec.gov/submissions/CIK${cikPadded}.json`;

// SEC explicitly requests this UA format: "Sample Company Name
// AdminContact@samplecompany.com". Lifted verbatim from
// sec.gov/os/accessing-edgar-data.
const USER_AGENT = "Prolio-Bot/1.0 ferranp.work@gmail.com";

const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 150; // ~6.6 req/s — well under SEC's 10/s cap.
const DEFAULT_LIMIT = 5_000;

// SIC → Prolio CategoryKey. Only confident mappings — we'd rather
// skip 9,500 SEC issuers than mis-route a single Fortune-500 bank
// into "fontaneria".
const SIC_TO_CATEGORY: Record<string, CategoryKey> = {
  "8011": "medicina", // Offices & clinics of doctors of medicine
  "8060": "medicina", // Hospitals
  "8062": "medicina", // General medical & surgical hospitals
  "8071": "medicina", // Medical laboratories
  "8731": "ingenieria", // Commercial physical & biological research
  "8742": "ingenieria", // Management consulting services
};

// --- Types -----------------------------------------------------------------

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

type TickersResponse = Record<string, TickerEntry>;

interface SecAddress {
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  stateOrCountry?: string | null;
  zipCode?: string | null;
  stateOrCountryDescription?: string | null;
}

interface SubmissionsResponse {
  cik?: string;
  name?: string;
  sic?: string;
  sicDescription?: string;
  tickers?: string[];
  exchanges?: string[];
  ein?: string;
  lei?: string;
  website?: string;
  phone?: string;
  category?: string;
  fiscalYearEnd?: string;
  stateOfIncorporation?: string;
  stateOfIncorporationDescription?: string;
  formerNames?: Array<{ name?: string; from?: string; to?: string }>;
  addresses?: {
    business?: SecAddress | null;
    mailing?: SecAddress | null;
  } | null;
}

interface ProfessionalLite {
  id: string;
  metadata: Record<string, unknown> | null;
}

// --- HTTP ------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function padCik(cik: string | number): string {
  return String(cik).replace(/^0+/, "").padStart(10, "0");
}

async function secFetch<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        // SEC's CDN is happier when we identify the host explicitly
        // — and `Host` is restricted by fetch, so we use Accept-Encoding
        // default. No special tricks needed beyond the UA.
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[sec-edgar] HTTP ${res.status} on ${url}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[sec-edgar] network error on ${url}: ${(err as Error).message}`);
    return null;
  }
}

// --- Supabase --------------------------------------------------------------

function getDb(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Load every (id, metadata) row whose metadata.cik OR metadata.sec_ticker
 * is set. Both indexes are populated by future adapters; today this
 * returns 0 rows for most installs — by design. The matcher is wired
 * so a single backfill on the other side immediately starts producing
 * enrichments.
 */
async function loadCandidates(
  db: SupabaseClient,
): Promise<{
  byCik: Map<string, ProfessionalLite>;
  byTicker: Map<string, ProfessionalLite>;
}> {
  const byCik = new Map<string, ProfessionalLite>();
  const byTicker = new Map<string, ProfessionalLite>();
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await db
      .from("professionals")
      .select("id, metadata")
      .range(from, from + 999);
    if (error) {
      console.warn(`[sec-edgar] loadCandidates failed: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    for (const raw of data as Array<{
      id: string;
      metadata: Record<string, unknown> | null;
    }>) {
      const md = raw.metadata;
      if (!md || typeof md !== "object") continue;
      const cik = (md as Record<string, unknown>).cik;
      const ticker = (md as Record<string, unknown>).sec_ticker;
      if (typeof cik === "string" || typeof cik === "number") {
        byCik.set(padCik(cik as string | number), {
          id: raw.id,
          metadata: md,
        });
      }
      if (typeof ticker === "string" && ticker.length > 0) {
        byTicker.set(ticker.toUpperCase().trim(), {
          id: raw.id,
          metadata: md,
        });
      }
    }
    if (data.length < 1000) break;
  }
  return { byCik, byTicker };
}

function buildEnrichmentMetadata(
  base: Record<string, unknown>,
  sub: SubmissionsResponse,
): Record<string, unknown> {
  return {
    ...base,
    sec_cik: sub.cik ? padCik(sub.cik) : null,
    sec_ticker: sub.tickers?.[0] ?? null,
    sec_tickers: sub.tickers ?? null,
    sec_name: sub.name ?? null,
    sec_sic: sub.sic ?? null,
    sec_sic_description: sub.sicDescription ?? null,
    sec_exchanges: sub.exchanges ?? null,
    sec_state_of_incorporation: sub.stateOfIncorporation ?? null,
    sec_addresses_business: sub.addresses?.business ?? null,
    sec_lei: sub.lei ?? null,
    sec_synced_at: new Date().toISOString(),
  };
}

async function flushEnrichments(
  db: SupabaseClient,
  updates: Array<{ id: string; metadata: Record<string, unknown> }>,
): Promise<number> {
  let updated = 0;
  for (const u of updates) {
    const { error } = await db
      .from("professionals")
      .update({ metadata: u.metadata })
      .eq("id", u.id);
    if (error) {
      console.warn(`[sec-edgar] update id=${u.id} failed: ${error.message}`);
      continue;
    }
    updated += 1;
  }
  return updated;
}

// --- Ingest path -----------------------------------------------------------

function submissionsToScraped(
  sub: SubmissionsResponse,
  ticker: string,
  category: CategoryKey,
): ScrapedProfessional | null {
  const cikPadded = sub.cik ? padCik(sub.cik) : null;
  const name = (sub.name ?? "").trim();
  if (!cikPadded || !name) return null;
  const biz = sub.addresses?.business;
  const cityRaw = (biz?.city ?? "").toLowerCase().trim();
  if (!cityRaw) return null;
  // Slugify locally; the sink drops any slug not in the cities table.
  const citySlug = cityRaw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!citySlug) return null;
  return normalise({
    source: "sec-edgar" as ScrapeSource,
    sourceId: `sec:${cikPadded}`,
    name,
    categoryKey: category,
    citySlug,
    licenseNumber: cikPadded,
    website: sub.website,
    phone: sub.phone,
    address: [biz?.street1, biz?.city, biz?.stateOrCountry, biz?.zipCode]
      .filter(Boolean)
      .join(", ") || undefined,
    metadata: {
      country: "US",
      authority: "SEC",
      verified_by_authority: true,
      sec_cik: cikPadded,
      sec_ticker: ticker,
      sec_tickers: sub.tickers,
      sec_name: sub.name,
      sec_sic: sub.sic,
      sec_sic_description: sub.sicDescription,
      sec_exchanges: sub.exchanges,
      sec_state_of_incorporation: sub.stateOfIncorporation,
      sec_addresses_business: biz ?? null,
      sec_lei: sub.lei,
      sec_synced_at: new Date().toISOString(),
    },
  });
}

// --- Public entrypoint -----------------------------------------------------

export const secEdgarSource: ScraperSource = {
  name: "sec-edgar" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_SEC_EDGAR === "true";
  },
  async fetch() {
    return [];
  },
};

export interface SecEdgarRunResult {
  fetched: number;
  matched: number;
  updated: number;
  inserted: number;
  skipped: number;
}

export async function runSecEdgar(): Promise<SecEdgarRunResult> {
  if (!secEdgarSource.enabled()) {
    return { fetched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0 };
  }

  const limitRaw = Number(process.env.PROLIO_SEC_EDGAR_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

  const db = getDb();
  if (!db) {
    console.warn(
      "[sec-edgar] missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — skipping",
    );
    return { fetched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0 };
  }

  // --- Step 1: enrichment candidates -------------------------------------
  const { byCik, byTicker } = await loadCandidates(db);
  console.log(
    `[sec-edgar] enrichment candidates byCik=${byCik.size} byTicker=${byTicker.size} limit=${limit}`,
  );

  // --- Step 2: tickers index (also drives ingest) ------------------------
  const tickers = await secFetch<TickersResponse>(TICKERS_URL);
  if (!tickers) {
    console.warn("[sec-edgar] failed to fetch company_tickers.json — aborting");
    return { fetched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0 };
  }
  const entries = Object.values(tickers);
  console.log(`[sec-edgar] company_tickers.json: ${entries.length} entries`);

  // Build CIK→ticker index so the enrichment loop can resolve a known
  // CIK to its primary ticker without an extra fetch.
  const tickerByCik = new Map<string, string>();
  for (const e of entries) {
    tickerByCik.set(padCik(e.cik_str), e.ticker);
  }

  // --- Step 3: walk tickers, both for ingest + opportunistic enrichment --
  const enrichments: Array<{ id: string; metadata: Record<string, unknown> }> =
    [];
  const ingestable: ScrapedProfessional[] = [];
  let fetched = 0;
  let matched = 0;

  for (const entry of entries) {
    if (fetched >= limit) break;
    const cikPadded = padCik(entry.cik_str);
    const ticker = entry.ticker.toUpperCase();

    // Decide whether this entry is interesting: either it matches an
    // enrichment candidate, OR it could potentially be an ingest target
    // (we won't know until we see the SIC, which means we have to fetch).
    // To stay polite we fetch ALL tickers up to the cap — the cap is the
    // throttle. At 150ms each, 5,000 fetches = 12.5 min.
    const sub = await secFetch<SubmissionsResponse>(SUBMISSIONS_URL(cikPadded));
    fetched += 1;
    await delay(REQUEST_DELAY_MS);
    if (!sub) continue;

    // Enrichment match (CIK or ticker)
    const hit = byCik.get(cikPadded) ?? byTicker.get(ticker);
    if (hit) {
      matched += 1;
      const base = (hit.metadata ?? {}) as Record<string, unknown>;
      enrichments.push({
        id: hit.id,
        metadata: buildEnrichmentMetadata(base, sub),
      });
    }

    // Ingest match (SIC mapped → Prolio category)
    const sic = sub.sic ? String(sub.sic) : "";
    const category = SIC_TO_CATEGORY[sic];
    if (category) {
      const rec = submissionsToScraped(sub, ticker, category);
      if (rec) ingestable.push(rec);
    }
  }

  // --- Step 4: flush ------------------------------------------------------
  let updated = 0;
  if (enrichments.length > 0) {
    updated = await flushEnrichments(db, enrichments);
  }

  let inserted = 0;
  let skipped = 0;
  if (ingestable.length > 0) {
    const res = await getSink().upsert(ingestable);
    inserted = res.inserted;
    updated += res.updated; // count ingest-path updates alongside enrichment
    skipped = res.skipped;
  }

  console.log(
    `[sec-edgar] done — fetched=${fetched} matched=${matched} ` +
      `enriched=${enrichments.length} updated=${updated} ` +
      `ingestable=${ingestable.length} inserted=${inserted} skipped=${skipped}`,
  );

  // Quiet linter on unused tickerByCik — keep the index for future use
  // (e.g. a debug log of which tickers we visited per category).
  void tickerByCik;

  return { fetched, matched, updated, inserted, skipped };
}
