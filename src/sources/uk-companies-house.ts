import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * UK Companies House — corporate registry enrichment + narrow ingest.
 *
 * Why this source exists
 * ----------------------
 * Companies House is the UK's official corporate registry. Every limited
 * company, LLP, and registered overseas entity in the UK has a Company
 * Number assigned here. For Prolio it serves the same role GLEIF plays
 * cross-jurisdictionally: an authoritative ID that proves a row maps to
 * a real legal entity. Data is Crown Copyright under the OGL v3 licence
 * (compatible with commercial reuse with attribution).
 *
 * Pre-flight (2026-05-20)
 * -----------------------
 * robots.txt:
 *   - api.company-information.service.gov.uk → no robots.txt served (the
 *     API is the documented public access path, not an HTML scrape).
 *   - www.gov.uk → standard rules; only disallows /search/all* and admin
 *     paths. Not relevant — we hit the API host, not www.gov.uk.
 *
 * Auth (probed live 2026-05-20):
 *   - GET https://api.company-information.service.gov.uk/  → HTTP 401
 *     {"error":"Empty Authorization header","type":"ch:service"}
 *   - GET .../company/00000006              → HTTP 401 (same)
 *   - GET .../search/companies?q=tesco      → HTTP 401
 *   - GET .../advanced-search/companies?sic_codes=43220 → HTTP 401
 *   The whole API requires an API key supplied as HTTP Basic auth:
 *   `Authorization: Basic base64(<API_KEY>:)`  (key as username, empty
 *   password). Keys are free at https://developer.company-information.
 *   service.gov.uk/ but personal — they must not be committed. We read
 *   COMPANIES_HOUSE_API_KEY at runtime; without it the source logs and
 *   skips. Rate limit is 600 requests per 5 minutes per key.
 *
 * Endpoint shape:
 *   GET /company/{number}                — single-company profile (the
 *     enrichment workhorse). Returns status, sic_codes[], type,
 *     date_of_creation, jurisdiction, registered_office_address.
 *   GET /search/companies?q={text}       — name search, paginated
 *     (start_index, items_per_page max 100), max 5,000 results total.
 *   GET /advanced-search/companies       — supports sic_codes, status,
 *     incorporated_from/to, registered_office_address filters; same
 *     hard 5,000-result window. Useful for SIC-targeted enumeration
 *     only when the count is below that cap.
 *
 * Bulk product:
 *   http://download.companieshouse.gov.uk/en_output.html (301 → https)
 *   exists and offers a monthly snapshot of ~5.4M live companies as a
 *   ~500MB CSV ZIP plus 5 split files. Rejected for the same reason as
 *   the GLEIF Golden Copy: the repo has no zip/csv parser dep and the
 *   "no new deps" constraint stands. The authenticated /company/{n}
 *   endpoint at 600 req/5min gives us ~172k profiles/day per key — more
 *   than enough for enrichment cadence.
 *
 * Strategy — hybrid (per source brief 2026-05-20)
 * -----------------------------------------------
 * Enrichment (primary): load every `professionals` row whose
 *   metadata.uk_company_number is set, OR whose metadata.registration_
 *   number looks like a UK company number. UK numbers are 8-character
 *   strings: either 8 digits ("00000006") or a 2-letter prefix + 6
 *   digits (e.g. "SC", "NI", "OC", "LP"). Anything else is skipped to
 *   avoid wasting the rate budget on non-UK regnums.
 *   For each candidate: GET /company/{number} and patch metadata:
 *     companies_house_status, companies_house_sic_codes,
 *     companies_house_incorporated_on, companies_house_company_type,
 *     companies_house_jurisdiction, companies_house_registered_address,
 *     companies_house_synced_at.
 *
 * Ingest (secondary, narrow): DISABLED in this initial drop.
 *   Rationale:
 *     1. The cities table is seeded ES/MX/FR/CA/US only (see
 *        sink.ts ~line 87) so the sink will drop every UK row until
 *        UK cities are seeded — ingest would produce 0 inserts today.
 *     2. The advanced-search endpoint caps at 5,000 results per query.
 *        For broad UK SIC codes (e.g. 43220 plumbing, 86210 GP medical
 *        practices) the live UK counts exceed this, so reliable
 *        SIC-wide ingest needs the bulk CSV (out of scope here) or a
 *        fan-out by registered_office postcode area, which assumes UK
 *        city seeding anyway.
 *   When UK city seeding lands, the SIC→CategoryKey map below and the
 *   `ingestBySic()` skeleton can be flipped on by setting
 *   PROLIO_UK_CH_INGEST=true; left in place so the migration is small.
 *
 * Off by default. Enable via PROLIO_RUN_UK_COMPANIES_HOUSE=true and
 * COMPANIES_HOUSE_API_KEY=<key>. Weekly schedule + workflow_dispatch.
 */

const API_BASE = "https://api.company-information.service.gov.uk";
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
// 600 req / 5 min = 2 req/s. 500ms keeps a margin for retries and CI jitter.
const REQUEST_DELAY_MS = 500;
const DEFAULT_LIMIT = 5_000;
const UK_NUMBER_RE = /^([A-Z]{2})?\d{6,8}$/;

// UK SIC 2007 → Prolio CategoryKey. Conservative — only mappings with
// a confident match. Used only when ingest is enabled (see header).
const SIC_TO_CATEGORY: Record<string, CategoryKey> = {
  "43220": "fontaneria", // Plumbing, heat and air-conditioning installation
  "43210": "electricidad", // Electrical installation
  "45200": "mecanica", // Maintenance and repair of motor vehicles
  "71111": "arquitecto", // Architectural activities
  "71112": "arquitecto", // Urban planning and landscape architectural activities
  "71121": "ingenieria", // Engineering design activities for industrial process
  "71122": "ingenieria", // Engineering related scientific and technical consulting
  "69201": "fiscal", // Accounting and auditing activities
  "69202": "fiscal", // Bookkeeping activities
  "69203": "fiscal", // Tax consultancy
  "69101": "abogado", // Barristers at law
  "69102": "abogado", // Solicitors
  "69109": "abogado", // Activities of patent and copyright agents; other legal
  "86210": "medicina", // General medical practice activities
  "86230": "dentista", // Dental practice activities
  "86900": "fisioterapia", // Other human health activities (broad — leave off in ingest)
  "75000": "veterinario", // Veterinary activities
};

// --- Types -----------------------------------------------------------------

interface CompanyAddress {
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
  premises?: string;
}

interface CompanyProfile {
  company_number: string;
  company_name?: string;
  company_status?: string;
  company_status_detail?: string;
  type?: string;
  jurisdiction?: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  sic_codes?: string[];
  registered_office_address?: CompanyAddress;
  has_been_liquidated?: boolean;
  has_insolvency_history?: boolean;
}

interface ProfessionalLite {
  id: string;
  metadata: Record<string, unknown> | null;
}

// --- HTTP ------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function authHeader(apiKey: string): string {
  // Basic auth, key as username, empty password. Node 18+ has Buffer
  // globally; we avoid `btoa` for non-ASCII safety even though the
  // CH key alphabet is ASCII.
  const token = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function chFetch(
  path: string,
  apiKey: string,
): Promise<{ status: number; body: unknown } | null> {
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Authorization: authHeader(apiKey),
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    // 404 is a normal "company number unknown" — surface it to the
    // caller without warning spam.
    if (res.status === 404) return { status: 404, body: null };
    if (res.status === 429) {
      // Rate-limited. The API sends X-Ratelimit-Reset (epoch s) but
      // many wrappers don't expose it cleanly; back off a fixed 30s.
      console.warn("[uk-ch] 429 rate-limited, backing off 30s");
      await delay(30_000);
      return { status: 429, body: null };
    }
    if (!res.ok) {
      console.warn(`[uk-ch] ${path} HTTP ${res.status}`);
      return { status: res.status, body: null };
    }
    return { status: res.status, body: await res.json() };
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[uk-ch] ${path} network error: ${(err as Error).message}`);
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

function looksLikeUkCompanyNumber(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const norm = raw.trim().toUpperCase();
  if (!norm) return null;
  // Companies House stores numbers zero-padded to 8 chars. Accept 6-8
  // digit forms (with optional 2-letter prefix) and pad as needed.
  if (!UK_NUMBER_RE.test(norm)) return null;
  const prefix = norm.match(/^[A-Z]{2}/)?.[0] ?? "";
  const digits = norm.slice(prefix.length);
  if (digits.length > 8) return null;
  const padded = prefix
    ? prefix + digits.padStart(8 - prefix.length, "0")
    : digits.padStart(8, "0");
  return padded;
}

/**
 * Load (id, metadata) for every professional whose metadata carries a
 * UK company number. Two paths:
 *   1. metadata.uk_company_number — explicit, written by future UK
 *      ingest adapters.
 *   2. metadata.registration_number — generic; we filter to those that
 *      look like UK company numbers (see UK_NUMBER_RE).
 * Cap at 50k rows — same defence as GLEIF.
 */
async function loadCandidates(
  db: SupabaseClient,
): Promise<Map<string, ProfessionalLite>> {
  const out = new Map<string, ProfessionalLite>();
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await db
      .from("professionals")
      .select("id, metadata")
      .range(from, from + 999);
    if (error) {
      console.warn(`[uk-ch] loadCandidates failed: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    for (const raw of data as Array<{
      id: string;
      metadata: Record<string, unknown> | null;
    }>) {
      const meta = raw.metadata ?? {};
      const explicit = meta.uk_company_number;
      const generic = meta.registration_number;
      const number =
        looksLikeUkCompanyNumber(explicit) ??
        looksLikeUkCompanyNumber(generic);
      if (!number) continue;
      // First writer wins if a number maps to multiple rows (rare).
      if (!out.has(number)) {
        out.set(number, { id: raw.id, metadata: raw.metadata });
      }
    }
    if (data.length < 1000) break;
  }
  return out;
}

function formatAddress(addr: CompanyAddress | undefined): string | null {
  if (!addr) return null;
  const parts = [
    addr.premises,
    addr.address_line_1,
    addr.address_line_2,
    addr.locality,
    addr.region,
    addr.postal_code,
    addr.country,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

function buildEnrichmentPatch(
  pro: ProfessionalLite,
  profile: CompanyProfile,
): Record<string, unknown> {
  const base = (pro.metadata ?? {}) as Record<string, unknown>;
  return {
    ...base,
    uk_company_number: profile.company_number,
    companies_house_status: profile.company_status ?? null,
    companies_house_status_detail: profile.company_status_detail ?? null,
    companies_house_company_type: profile.type ?? null,
    companies_house_jurisdiction: profile.jurisdiction ?? null,
    companies_house_incorporated_on: profile.date_of_creation ?? null,
    companies_house_ceased_on: profile.date_of_cessation ?? null,
    companies_house_sic_codes: profile.sic_codes ?? [],
    companies_house_registered_address: formatAddress(
      profile.registered_office_address,
    ),
    companies_house_has_been_liquidated: profile.has_been_liquidated ?? false,
    companies_house_synced_at: new Date().toISOString(),
  };
}

async function runEnrichment(
  db: SupabaseClient,
  apiKey: string,
  limit: number,
): Promise<{ fetched: number; matched: number; updated: number }> {
  const candidates = await loadCandidates(db);
  console.log(`[uk-ch] loaded candidates=${candidates.size} limit=${limit}`);
  if (candidates.size === 0) {
    return { fetched: 0, matched: 0, updated: 0 };
  }

  let fetched = 0;
  let matched = 0;
  let updated = 0;

  for (const [number, pro] of candidates) {
    if (fetched >= limit) break;
    fetched += 1;
    const resp = await chFetch(`/company/${encodeURIComponent(number)}`, apiKey);
    await delay(REQUEST_DELAY_MS);
    if (!resp || resp.status !== 200 || !resp.body) {
      if (resp?.status === 404) {
        // Quietly skipped — number unknown to CH.
        continue;
      }
      continue;
    }
    const profile = resp.body as CompanyProfile;
    if (!profile.company_number) continue;
    matched += 1;
    const patch = buildEnrichmentPatch(pro, profile);
    const { error } = await db
      .from("professionals")
      .update({ metadata: patch })
      .eq("id", pro.id);
    if (error) {
      console.warn(`[uk-ch] update id=${pro.id} failed: ${error.message}`);
      continue;
    }
    updated += 1;
  }

  return { fetched, matched, updated };
}

// --- Ingest (disabled by default — see header for rationale) ---------------

/**
 * SIC-targeted ingest skeleton. Left intentionally minimal: the
 * advanced-search endpoint caps at 5,000 hits per query, the cities
 * table has no UK seeds, and the user brief asked us to be explicit
 * about disabling rather than fabricate behaviour. To enable:
 *   1. Seed UK cities in the cities table.
 *   2. Set PROLIO_UK_CH_INGEST=true.
 *   3. Optionally narrow SIC_TO_CATEGORY further.
 * The function below is a stub returning 0s — wire it up in a follow-up.
 */
async function runIngest(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  void SIC_TO_CATEGORY; // referenced for future use; silence unused warning
  void normalise;
  void getSink;
  console.log(
    "[uk-ch] ingest path is disabled (cities table has no UK seeds; " +
      "advanced-search caps at 5k results per SIC). See file header.",
  );
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}

// Satisfy lint when ingest types are referenced elsewhere.
void runIngest;

// --- Public entrypoint -----------------------------------------------------

export function ukCompaniesHouseEnabled(): boolean {
  return process.env.PROLIO_RUN_UK_COMPANIES_HOUSE === "true";
}

export interface UkCompaniesHouseRunResult {
  fetched: number;
  matched: number;
  updated: number;
  inserted: number;
  skipped: number;
}

export async function runUkCompaniesHouse(): Promise<UkCompaniesHouseRunResult> {
  if (!ukCompaniesHouseEnabled()) {
    return { fetched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0 };
  }

  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    console.warn(
      "[uk-ch] missing COMPANIES_HOUSE_API_KEY — Companies House API " +
        "requires a free key (Basic auth). Skipping.",
    );
    return { fetched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0 };
  }

  const db = getDb();
  if (!db) {
    console.warn(
      "[uk-ch] missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — skipping",
    );
    return { fetched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0 };
  }

  const limitRaw = Number(process.env.PROLIO_UK_CH_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

  const enr = await runEnrichment(db, apiKey, limit);

  let ingested = { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  if (process.env.PROLIO_UK_CH_INGEST === "true") {
    ingested = await runIngest();
  }

  const out: UkCompaniesHouseRunResult = {
    fetched: enr.fetched + ingested.fetched,
    matched: enr.matched,
    updated: enr.updated + ingested.updated,
    inserted: ingested.inserted,
    skipped: ingested.skipped,
  };

  console.log(
    `[uk-ch] done — fetched=${out.fetched} matched=${out.matched} ` +
      `updated=${out.updated} inserted=${out.inserted} skipped=${out.skipped}`,
  );
  return out;
}

// ScraperSource shape so the coordinator can register us in the union.
// The fetch() entrypoint is a no-op: this source is driven by
// runUkCompaniesHouse() (enrichment), not by per-target fan-out.
export const ukCompaniesHouseSource: ScraperSource = {
  name: "uk-companies-house" as ScrapeSource,
  enabled: ukCompaniesHouseEnabled,
  async fetch(): Promise<ScrapedProfessional[]> {
    return [];
  },
};
