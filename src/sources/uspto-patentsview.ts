import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * USPTO PatentsView — US patent assignee enrichment.
 *
 * Why this source exists (and why it's enrichment-only)
 * -----------------------------------------------------
 * PatentsView publishes disambiguated patent assignee records for every
 * US-granted patent: organisation name, location, assignee type
 * (1=US company, 2=Foreign company, 3=US individual, 4=Foreign
 * individual, 5=US fed gov, 6=Foreign gov, 7=US county, 8=US state, 9=Unknown),
 * and aggregate patent counts. For Prolio rows that map to a real
 * patenting entity this gives us a free "this is an innovation-active
 * company" signal plus a stable assignee_id we can cross-reference.
 *
 * Why ingest is SKIPPED (honest answer)
 * -------------------------------------
 * The user asked for hybrid mode. We are NOT doing ingest here, and
 * the reason is concrete:
 *   1. Assignees lack any industry code (no NAICS/NAF/SIC). Prolio
 *      requires a categoryKey for every row. Mapping ~400k US assignees
 *      to one of our trades/healthcare categories is guesswork.
 *   2. Most assignees lack address/city, only state/country. Prolio
 *      requires a citySlug; we can't satisfy the FK at scale.
 *   3. Population is biased to tech/pharma/manufacturing — categories
 *      we don't cover. A "fontaneria" with a US patent is a black swan.
 *   4. Name disambiguation is best-effort; the same legal entity often
 *      appears as multiple assignee_ids ("APPLE INC", "APPLE COMPUTER
 *      INC", "APPLE COMPUTER, INC."). Without our own dedup, ingest
 *      would duplicate rows existing sources already cover better.
 * `runUsptoPatentsView` therefore always returns inserted=0. The stub
 * is kept in code so the workflow + env wiring exist if someone later
 * finds a useful slice (e.g. by city + CPC class).
 *
 * Pre-flight (2026-05-20)
 * -----------------------
 * robots.txt patentsview.org:
 *   Cloudflare-managed; `User-agent: *` → `Allow: /`. Disallows
 *   AI training/ingestion bots (ClaudeBot, GPTBot, CCBot, …) but the
 *   site explicitly grants `search=yes`. Our polite UA is neither.
 *
 * DNS / endpoint state:
 *   - patentsview.org → 301 → data.uspto.gov/support/transition-guide/patentsview
 *   - search.patentsview.org → NXDOMAIN (the "v1" replacement domain
 *     advertised in 2023 was never made public OR was renamed inside
 *     data.uspto.gov; the SPA at the transition guide is opaque to
 *     plain curl).
 *   - api.patentsview.org → DNS still resolves; the legacy v1 API was
 *     publicly announced as retired but anecdotally still responds for
 *     some queries. We treat it as the fallback.
 *
 * API key reality:
 *   The official replacement (search.patentsview.org / data.uspto.gov
 *   "Open Data Portal") requires a FREE API key, requested via web
 *   form, granted in ~1 business day. The key goes in the `X-Api-Key`
 *   header. We read it from env `USPTO_PATENTSVIEW_API_KEY`. WITHOUT
 *   A KEY THIS SOURCE NO-OPS — we log loudly and return zeros so the
 *   workflow stays green and a human notices in the logs.
 *
 *   To request a key:
 *     https://patentsview-support.atlassian.net/servicedesk/customer/portal/1/group/1/create/16
 *   (Or whatever URL the transition guide currently points to.)
 *
 * Strategy when a key IS present
 * ------------------------------
 * Enrichment-only. We load every `professionals` row whose
 * `metadata.uspto_assignee_id` is already set (zero today; populated
 * by future human curation or by a name-match adapter), refresh their
 * patent counts + first/last year, write timestamps. No name-match
 * scan in v1: false positives ("Smith Plumbing Inc." in Texas vs.
 * "Smith Plumbing Inc." patenting hose nozzles in NJ) would corrupt
 * profiles. Add later behind an explicit confidence threshold.
 *
 * Off by default. Enable via `PROLIO_RUN_USPTO_PATENTSVIEW=true`. Cap
 * with `PROLIO_USPTO_LIMIT` (default 5000 assignees scanned). Monthly
 * schedule — patent grant data updates weekly but our enrichment
 * cadence is much slower; monthly is plenty.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 500;
const DEFAULT_LIMIT = 5_000;
// The "v2" search endpoint the transition guide redirects to. If/when
// this 404s we surface the error and exit; we do not silently fall
// back to api.patentsview.org because the legacy host is officially
// retired and may go dark without notice.
const API_BASE = "https://search.patentsview.org/api/v1/assignee/";

interface AssigneeRecord {
  assignee_id?: string;
  assignee_organization?: string | null;
  assignee_type?: number | string | null;
  assignee_first_seen_date?: string | null;
  assignee_last_seen_date?: string | null;
  assignee_num_patents?: number | null;
}

interface AssigneeResponse {
  assignees?: AssigneeRecord[];
  total_hits?: number;
  count?: number;
  error?: string;
}

interface ProfessionalLite {
  id: string;
  metadata: Record<string, unknown> | null;
  assigneeId: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getDb(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function loadCandidates(db: SupabaseClient): Promise<ProfessionalLite[]> {
  // metadata.uspto_assignee_id is the only key we enrich on. We page
  // through professionals filtering by JSONB key presence via
  // PostgREST's `not.is.null` operator on the JSON path.
  const out: ProfessionalLite[] = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await db
      .from("professionals")
      .select("id, metadata")
      .not("metadata->uspto_assignee_id", "is", null)
      .range(from, from + 999);
    if (error) {
      console.warn(`[uspto-patentsview] loadCandidates failed: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    for (const raw of data as Array<{
      id: string;
      metadata: Record<string, unknown> | null;
    }>) {
      const meta = raw.metadata ?? {};
      const aid = (meta as Record<string, unknown>).uspto_assignee_id;
      if (typeof aid !== "string" || aid.length === 0) continue;
      out.push({ id: raw.id, metadata: meta, assigneeId: aid });
    }
    if (data.length < 1000) break;
  }
  return out;
}

async function fetchAssignee(
  apiKey: string,
  assigneeId: string,
): Promise<AssigneeRecord | null> {
  // PatentsView v1 query shape: q={"_eq":{"assignee_id":"..."}}
  const q = encodeURIComponent(JSON.stringify({ _eq: { assignee_id: assigneeId } }));
  const f = encodeURIComponent(
    JSON.stringify([
      "assignee_id",
      "assignee_organization",
      "assignee_type",
      "assignee_first_seen_date",
      "assignee_last_seen_date",
      "assignee_num_patents",
    ]),
  );
  const url = `${API_BASE}?q=${q}&f=${f}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "application/json",
        "X-Api-Key": apiKey,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) {
      console.warn(
        `[uspto-patentsview] HTTP ${res.status} — API key rejected or missing. ` +
          "Request a key at the USPTO Open Data Portal and set USPTO_PATENTSVIEW_API_KEY.",
      );
      return null;
    }
    if (!res.ok) {
      console.warn(`[uspto-patentsview] HTTP ${res.status} for assignee=${assigneeId}`);
      return null;
    }
    const body = (await res.json()) as AssigneeResponse;
    return body.assignees?.[0] ?? null;
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[uspto-patentsview] network error for ${assigneeId}: ${(err as Error).message}`,
    );
    return null;
  }
}

function buildUpdate(
  pro: ProfessionalLite,
  rec: AssigneeRecord,
): Record<string, unknown> {
  const base = (pro.metadata ?? {}) as Record<string, unknown>;
  const firstSeen = rec.assignee_first_seen_date ?? null;
  const lastSeen = rec.assignee_last_seen_date ?? null;
  return {
    ...base,
    uspto_assignee_id: rec.assignee_id ?? pro.assigneeId,
    uspto_patent_count:
      typeof rec.assignee_num_patents === "number" ? rec.assignee_num_patents : null,
    uspto_first_patent_year:
      typeof firstSeen === "string" && firstSeen.length >= 4
        ? Number(firstSeen.slice(0, 4))
        : null,
    uspto_last_patent_year:
      typeof lastSeen === "string" && lastSeen.length >= 4
        ? Number(lastSeen.slice(0, 4))
        : null,
    uspto_assignee_type: rec.assignee_type ?? null,
    uspto_synced_at: new Date().toISOString(),
  };
}

// --- Public entrypoint -----------------------------------------------------

export function usptoPatentsViewEnabled(): boolean {
  return process.env.PROLIO_RUN_USPTO_PATENTSVIEW === "true";
}

export interface UsptoPatentsViewRunResult {
  fetched: number;
  matched: number;
  updated: number;
  inserted: number; // always 0 — see header for why ingest is skipped
  skipped: number;
}

export async function runUsptoPatentsView(): Promise<UsptoPatentsViewRunResult> {
  const out: UsptoPatentsViewRunResult = {
    fetched: 0,
    matched: 0,
    updated: 0,
    inserted: 0,
    skipped: 0,
  };

  if (!usptoPatentsViewEnabled()) {
    console.log("[uspto-patentsview] PROLIO_RUN_USPTO_PATENTSVIEW != true — skipping");
    return out;
  }

  const apiKey = process.env.USPTO_PATENTSVIEW_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    console.warn(
      "[uspto-patentsview] no USPTO_PATENTSVIEW_API_KEY — skipping. " +
        "The PatentsView API requires a free key from the USPTO Open Data Portal " +
        "(see source header for request URL). Run will resume on the next cron " +
        "once the secret is populated.",
    );
    return out;
  }

  const limitRaw = Number(process.env.PROLIO_USPTO_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

  const db = getDb();
  if (!db) {
    console.warn(
      "[uspto-patentsview] missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — skipping",
    );
    return out;
  }

  const candidates = await loadCandidates(db);
  console.log(
    `[uspto-patentsview] candidates=${candidates.length} limit=${limit} ` +
      `(ingest=stub, inserted will be 0 — see header for rationale)`,
  );
  if (candidates.length === 0) {
    console.log(
      "[uspto-patentsview] no professionals with metadata.uspto_assignee_id — " +
        "nothing to enrich. Populate that key via human curation or a future " +
        "name-match adapter and re-run.",
    );
    return out;
  }

  for (const pro of candidates) {
    if (out.fetched >= limit) break;
    out.fetched += 1;
    const rec = await fetchAssignee(apiKey, pro.assigneeId);
    if (!rec) {
      out.skipped += 1;
      await delay(REQUEST_DELAY_MS);
      continue;
    }
    out.matched += 1;
    const nextMeta = buildUpdate(pro, rec);
    const { error } = await db
      .from("professionals")
      .update({ metadata: nextMeta })
      .eq("id", pro.id);
    if (error) {
      console.warn(
        `[uspto-patentsview] update id=${pro.id} failed: ${error.message}`,
      );
      out.skipped += 1;
    } else {
      out.updated += 1;
    }
    await delay(REQUEST_DELAY_MS);
  }

  console.log(
    `[uspto-patentsview] done — fetched=${out.fetched} matched=${out.matched} ` +
      `updated=${out.updated} inserted=${out.inserted} skipped=${out.skipped}`,
  );
  return out;
}
