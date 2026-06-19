import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * GLEIF — Global Legal Entity Identifier Foundation enrichment.
 *
 * Why this source exists
 * ----------------------
 * Every legal entity in the world that touches the regulated financial
 * system has a 20-character LEI. GLEIF runs the Global LEI System and
 * publishes the full file daily under CC-BY 4.0. For Prolio this is the
 * cleanest free replacement for OpenCorporates: a cross-jurisdictional
 * ID that proves a `professionals` row maps to a real legal entity
 * registered in the local jurisdiction's corporate registry.
 *
 * Pre-flight (2026-04-24)
 * -----------------------
 * robots.txt:
 *   - www.gleif.org      → Disallow: /*?  (only query strings)
 *   - api.gleif.org      → no robots.txt; the API is the documented
 *                          public access path, not an HTML scrape.
 * The /api/v1/lei-records endpoint is the official tool for filtered
 * pulls and is unaffected by the website's query-string disallow.
 *
 * API shape (probed live):
 *   GET https://api.gleif.org/api/v1/lei-records?
 *       filter[entity.legalAddress.country]=ES
 *       &page[size]=200&page[number]=N
 *   → JSON:API envelope. meta.pagination.total gives the count.
 *   → page[size] supports up to at least 200 (verified).
 *   → totals at probe time: ES=187,965 / US=349,129 / CA=57,101
 *     (≈594k combined; ~3,000 pages at 200/page).
 *
 * Why API instead of the bulk Concatenated File
 * ---------------------------------------------
 * The bulk Golden Copy is an 876MB JSON ZIP (or 458MB CSV ZIP) of
 * 3.29M records globally. We'd then filter to <600k. The repo has no
 * existing CSV/zip parser dependency and we're under a strict "no new
 * deps" constraint. Streaming a multi-hundred-MB zip without
 * `unzipper` / `yauzl` / `csv-parse` would cost ~300 lines of
 * byte-level code per format. The v1 API returns the same fields in
 * JSON:API and gives us free filtering by country at the wire — net
 * cost is ~3,000 GETs (≈10 minutes of cron time, well under the
 * 60-min CI budget) for full ES/US/CA coverage. We default-cap at
 * 10,000 records so the first run is observable; lift PROLIO_GLEIF_LIMIT
 * to 600000 for full coverage.
 *
 * Strategy
 * --------
 * Enrichment-only. The LEI envelope tells us nothing about a
 * profession/category, so we never insert new `professionals` rows
 * here — only update existing rows whose `cif` (Spain) or
 * `metadata.registration_number` (US/CA) matches GLEIF's
 * `attributes.entity.registeredAs`. For ES this is the canonical
 * NIF/CIF (e.g. "B22602403"), which is exactly what BORME and CCAA
 * registries already write. For US/CA the local registration number
 * is jurisdiction-specific (state corp #, federal corp #, etc.), so
 * matching is opportunistic.
 *
 * On a successful match we write:
 *   metadata.lei                    = "529900GEZGQZYNA9EM44"
 *   metadata.gleif_jurisdiction     = "ES"
 *   metadata.gleif_legal_form       = "DP3Q"      (ELF code)
 *   metadata.gleif_status           = "ACTIVE"
 *   metadata.gleif_registered_as    = "B22602403"
 *   metadata.gleif_parent_lei       = parent LEI or null
 *   metadata.gleif_ultimate_lei     = ultimate parent LEI or null
 *   metadata.gleif_publish_date     = the Golden Copy publish date
 *
 * If the row already had a `cif`, we preserve it (GLEIF agrees).
 * Otherwise (US/CA matched on registration_number) we leave `cif`
 * untouched; LEI lives in metadata only.
 *
 * Sister source (industry-ca) — KILLED
 * ------------------------------------
 * The Industry Canada JSON API documented in the source brief
 * (`/cc/lgcy/api/v2/corporations`) does not actually exist as of
 * pre-flight 2026-04-24 — every variant returns a WET-Drupal "Page
 * Not Found" 200. The only public path is the HTML search form
 * which would need a full Playwright session. Skipped to keep this
 * PR shipping the working source. Migration 0047 still registers
 * the `industry-ca` enum so a future Playwright adapter can land
 * without an extra migration.
 *
 * Off by default. Enable via PROLIO_RUN_GLEIF=true. Weekly schedule
 * + workflow_dispatch — see .github/workflows/scrape-gleif.yml.
 */

const GLEIF_API_BASE = "https://api.gleif.org/api/v1/lei-records";
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 200; // GLEIF v1 supports up to 200/page reliably.
const REQUEST_DELAY_MS = 250; // ~4 req/s — well below any documented limit.
const DEFAULT_LIMIT = 10_000;
const COUNTRIES: ReadonlyArray<"ES" | "US" | "CA" | "CO"> = ["ES", "US", "CA", "CO"];

// --- Types -----------------------------------------------------------------

interface GleifAddress {
  language?: string | null;
  addressLines?: string[] | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  postalCode?: string | null;
}

interface GleifRecord {
  type: "lei-records";
  id: string; // the LEI itself
  attributes: {
    lei: string;
    entity: {
      legalName?: { name?: string | null } | null;
      legalAddress?: GleifAddress | null;
      headquartersAddress?: GleifAddress | null;
      registeredAs?: string | null;
      jurisdiction?: string | null;
      legalForm?: { id?: string | null } | null;
      status?: string | null;
    };
    registration?: {
      status?: string | null;
      managingLou?: string | null;
    } | null;
  };
  relationships?: {
    "direct-parent"?: { data?: { id?: string | null } | null } | null;
    "ultimate-parent"?: { data?: { id?: string | null } | null } | null;
  } | null;
}

interface GleifResponse {
  meta?: {
    goldenCopy?: { publishDate?: string | null } | null;
    pagination?: {
      currentPage?: number;
      perPage?: number;
      total?: number;
      lastPage?: number;
    } | null;
  } | null;
  data?: GleifRecord[];
}

interface ProfessionalLite {
  id: string;
  cif: string | null;
  metadata: Record<string, unknown> | null;
}

// --- HTTP ------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function gleifFetch(country: string, page: number): Promise<GleifResponse | null> {
  const url =
    `${GLEIF_API_BASE}` +
    `?filter%5Bentity.legalAddress.country%5D=${country}` +
    `&page%5Bsize%5D=${PAGE_SIZE}` +
    `&page%5Bnumber%5D=${page}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "application/vnd.api+json,application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[gleif] ${country} page=${page} HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as GleifResponse;
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[gleif] ${country} page=${page} network error: ${(err as Error).message}`,
    );
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
 * Load every (id, cif, metadata) row that has a non-null cif, plus
 * every row whose metadata.registration_number is set. The match key
 * for ES is `cif`; for US/CA it's `metadata.registration_number`
 * which a future adapter will populate but is empty today (so US/CA
 * matching is a no-op until then — by design, we still scan for it
 * so the join logic is in place).
 *
 * Capped at 50k rows to defend against runaway memory: at our current
 * scale (~5k pros) this loads everything in two pages.
 */
async function loadCandidates(
  db: SupabaseClient,
): Promise<{
  byCif: Map<string, ProfessionalLite>;
  byRegNum: Map<string, ProfessionalLite>;
}> {
  const byCif = new Map<string, ProfessionalLite>();
  const byRegNum = new Map<string, ProfessionalLite>();
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await db
      .from("professionals")
      .select("id, cif, metadata")
      .range(from, from + 999);
    if (error) {
      console.warn(`[gleif] loadCandidates failed: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    for (const raw of data as Array<{
      id: string;
      cif: string | null;
      metadata: Record<string, unknown> | null;
    }>) {
      const lite: ProfessionalLite = {
        id: raw.id,
        cif: raw.cif,
        metadata: raw.metadata,
      };
      if (raw.cif) {
        byCif.set(raw.cif.toUpperCase().trim(), lite);
      }
      const regNum =
        raw.metadata && typeof raw.metadata === "object"
          ? (raw.metadata as Record<string, unknown>).registration_number
          : undefined;
      if (typeof regNum === "string" && regNum.length > 0) {
        byRegNum.set(regNum.toUpperCase().trim(), lite);
      }
    }
    if (data.length < 1000) break;
  }
  return { byCif, byRegNum };
}

interface UpdatePayload {
  id: string;
  metadata: Record<string, unknown>;
  cif?: string;
}

function buildUpdate(
  pro: ProfessionalLite,
  rec: GleifRecord,
  publishDate: string | null,
): UpdatePayload {
  const attrs = rec.attributes;
  const directParent = rec.relationships?.["direct-parent"]?.data?.id ?? null;
  const ultimateParent = rec.relationships?.["ultimate-parent"]?.data?.id ?? null;
  const baseMeta = (pro.metadata ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = {
    ...baseMeta,
    lei: attrs.lei,
    gleif_jurisdiction: attrs.entity.jurisdiction ?? null,
    gleif_legal_form: attrs.entity.legalForm?.id ?? null,
    gleif_status: attrs.entity.status ?? null,
    gleif_registration_status: attrs.registration?.status ?? null,
    gleif_registered_as: attrs.entity.registeredAs ?? null,
    gleif_parent_lei: directParent,
    gleif_ultimate_lei: ultimateParent,
    gleif_publish_date: publishDate,
    gleif_synced_at: new Date().toISOString(),
  };
  const out: UpdatePayload = { id: pro.id, metadata: next };
  // Only set cif if the row didn't have one — never overwrite manual
  // input with GLEIF-sourced data.
  if (!pro.cif && attrs.entity.registeredAs) {
    out.cif = attrs.entity.registeredAs;
  }
  return out;
}

async function flushUpdates(
  db: SupabaseClient,
  updates: UpdatePayload[],
): Promise<{ updated: number }> {
  let updated = 0;
  // No bulk-update with conditional per-row payloads in PostgREST;
  // the row count is small (matches only) so single-row updates are fine.
  for (const u of updates) {
    const patch: Record<string, unknown> = { metadata: u.metadata };
    if (u.cif) patch.cif = u.cif;
    const { error } = await db.from("professionals").update(patch).eq("id", u.id);
    if (error) {
      console.warn(`[gleif] update id=${u.id} failed: ${error.message}`);
      continue;
    }
    updated += 1;
  }
  return { updated };
}

// --- Public entrypoint -----------------------------------------------------

export function gleifEnabled(): boolean {
  return process.env.PROLIO_RUN_GLEIF === "true";
}

export interface GleifRunResult {
  fetched: number;
  matched: number;
  updated: number;
  countries: Record<string, { fetched: number; matched: number }>;
}

export async function runGleifEnrichment(): Promise<GleifRunResult> {
  const limitRaw = Number(process.env.PROLIO_GLEIF_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

  const db = getDb();
  if (!db) {
    console.warn(
      "[gleif] missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — skipping",
    );
    return { fetched: 0, matched: 0, updated: 0, countries: {} };
  }

  const { byCif, byRegNum } = await loadCandidates(db);
  console.log(
    `[gleif] loaded candidates byCif=${byCif.size} byRegNum=${byRegNum.size} ` +
      `limit=${limit}`,
  );
  if (byCif.size === 0 && byRegNum.size === 0) {
    console.log("[gleif] no candidates with CIF/regNum — nothing to enrich");
    return { fetched: 0, matched: 0, updated: 0, countries: {} };
  }

  const out: GleifRunResult = {
    fetched: 0,
    matched: 0,
    updated: 0,
    countries: {},
  };
  const matches: UpdatePayload[] = [];

  outer: for (const country of COUNTRIES) {
    if (out.fetched >= limit) break;
    out.countries[country] = { fetched: 0, matched: 0 };
    let page = 1;
    while (out.fetched < limit) {
      const resp = await gleifFetch(country, page);
      if (!resp || !Array.isArray(resp.data)) break;
      const total = resp.meta?.pagination?.total ?? 0;
      const publishDate = resp.meta?.goldenCopy?.publishDate ?? null;
      if (page === 1) {
        console.log(
          `[gleif] ${country} total=${total} pages=${
            resp.meta?.pagination?.lastPage ?? "?"
          } publishDate=${publishDate}`,
        );
      }
      for (const rec of resp.data) {
        out.fetched += 1;
        out.countries[country].fetched += 1;
        const regAs = rec.attributes.entity.registeredAs;
        if (!regAs) continue;
        const key = regAs.toUpperCase().trim();
        const hit = byCif.get(key) ?? byRegNum.get(key);
        if (!hit) continue;
        out.matched += 1;
        out.countries[country].matched += 1;
        matches.push(buildUpdate(hit, rec, publishDate));
        if (out.fetched >= limit) break;
      }
      const lastPage = resp.meta?.pagination?.lastPage ?? page;
      if (page >= lastPage) break;
      page += 1;
      await delay(REQUEST_DELAY_MS);
      if (out.fetched >= limit) break outer;
    }
  }

  if (matches.length > 0) {
    const { updated } = await flushUpdates(db, matches);
    out.updated = updated;
  }

  console.log(
    `[gleif] done — fetched=${out.fetched} matched=${out.matched} ` +
      `updated=${out.updated} ` +
      Object.entries(out.countries)
        .map(([c, v]) => `${c}=${v.fetched}/${v.matched}`)
        .join(" "),
  );
  return out;
}
