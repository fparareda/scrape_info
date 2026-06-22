/**
 * Scraper telemetry → `public.scrape_runs`.
 *
 * One row per source execution. Read exclusively by `/admin` (service-
 * role client). No public RLS policies on the table — see migration
 * 0038_scrape_runs.sql.
 *
 * Why here and not inside each source adapter? We want telemetry to be
 * mandatory and uniform (started_at, finished_at, status, counts), but
 * we do NOT want every adapter to reach for a Supabase client. The
 * orchestrator wraps each source with `withScrapeRun(...)`, which:
 *
 *   1. Inserts a row with status='running' before the source runs.
 *   2. Runs the source.
 *   3. Updates the row with status='ok' + counts on success, or
 *      status='error' + error_note on a thrown error.
 *
 * Failures writing to `scrape_runs` are logged and swallowed — a
 * telemetry outage must never mask or abort the actual scrape.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface ScrapeRunCounts {
  rowsFetched?: number;
  rowsUpserted?: number;
  rowsSkipped?: number;
  metadata?: Record<string, unknown>;
}

let client: SupabaseClient | null | undefined;
function getClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    client = null;
    return null;
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

async function insertRunning(source: string): Promise<string | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("scrape_runs")
      .insert({ source, status: "running" })
      .select("id")
      .single();
    if (error) {
      console.warn(`[telemetry] insert running failed: ${error.message}`);
      return null;
    }
    return (data?.id as string) ?? null;
  } catch (err) {
    console.warn(`[telemetry] insert running crashed: ${(err as Error).message}`);
    return null;
  }
}

async function finishRun(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (sb.from("scrape_runs") as any)
      .update(patch)
      .eq("id", id);
    if (error) {
      console.warn(`[telemetry] finish run failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[telemetry] finish run crashed: ${(err as Error).message}`);
  }
}

/**
 * Low-level handle for orchestrators that need to open a row upfront
 * (before a multi-target loop) and close it once totals are known.
 * Prefer `withScrapeRun` for single-shot sources.
 */
export interface ScrapeRunHandle {
  ok(counts: ScrapeRunCounts): Promise<void>;
  error(err: unknown): Promise<void>;
  /** Persist partial counts WITHOUT finishing the row (see ScrapeRunReporter).
   *  Lets a long bulk run reflect progress even if later killed. */
  heartbeat(counts: ScrapeRunCounts): Promise<void>;
}

export async function beginScrapeRun(source: string): Promise<ScrapeRunHandle> {
  const id = await insertRunning(source);
  return {
    async heartbeat(counts) {
      if (!id) return;
      await finishRun(id, {
        rows_fetched: counts.rowsFetched ?? 0,
        rows_upserted: counts.rowsUpserted ?? 0,
        rows_skipped: counts.rowsSkipped ?? 0,
      });
    },
    async ok(counts) {
      if (!id) return;
      await finishRun(id, {
        finished_at: new Date().toISOString(),
        status: "ok",
        rows_fetched: counts.rowsFetched ?? 0,
        rows_upserted: counts.rowsUpserted ?? 0,
        rows_skipped: counts.rowsSkipped ?? 0,
        metadata: counts.metadata ?? {},
      });
    },
    async error(err) {
      if (!id) return;
      await finishRun(id, {
        finished_at: new Date().toISOString(),
        status: "error",
        error_note: ((err as Error)?.message ?? String(err)).slice(0, 2000),
      });
    },
  };
}

/**
 * Heartbeat reporter handed to the `withScrapeRun` callback. Calling it
 * persists partial counts to the still-`running` row WITHOUT finishing it.
 * Long bulk backfills (RUES/SECOP) use it so a run later killed by the CI
 * timeout/OOM still reflects the rows it wrote, instead of the misleading
 * rows_upserted=0 the finalizer never got to write. Optional — sources that
 * ignore it behave exactly as before.
 */
export type ScrapeRunReporter = (counts: ScrapeRunCounts) => Promise<void>;

/**
 * Wrap a source execution in a scrape_runs row. The callback may accept a
 * `report` heartbeat (see ScrapeRunReporter) and must return `ScrapeRunCounts`
 * on success (all fields optional; defaults to 0). If it throws, the row is
 * marked 'error' and the exception is re-thrown so the orchestrator's normal
 * error paths still fire.
 */
export async function withScrapeRun<T extends ScrapeRunCounts | void>(
  source: string,
  fn: (report: ScrapeRunReporter) => Promise<T>,
): Promise<T> {
  const id = await insertRunning(source);
  const report: ScrapeRunReporter = async (counts) => {
    if (!id) return;
    await finishRun(id, {
      rows_fetched: counts.rowsFetched ?? 0,
      rows_upserted: counts.rowsUpserted ?? 0,
      rows_skipped: counts.rowsSkipped ?? 0,
    });
  };
  try {
    const result = await fn(report);
    if (id) {
      const counts = (result ?? {}) as ScrapeRunCounts;
      const upserted = counts.rowsUpserted ?? 0;
      const fetched = counts.rowsFetched ?? 0;
      // Silent-breakage guard: a source that finishes "ok" with 0 rows
      // upserted is almost always broken (markup/endpoint/parser change,
      // anti-bot, or a slug/category filter dropping everything) — it just
      // doesn't throw. Surface it loudly so it stops reporting a false
      // success, and tag the row so it's queryable.
      const zeroRows = upserted === 0;
      if (zeroRows) {
        console.warn(
          `[scrape-run] ${source} produced 0 rows (fetched=${fetched}, skipped=${counts.rowsSkipped ?? 0}) — possible silent breakage`,
        );
      }
      await finishRun(id, {
        finished_at: new Date().toISOString(),
        status: "ok",
        rows_fetched: fetched,
        rows_upserted: upserted,
        rows_skipped: counts.rowsSkipped ?? 0,
        metadata: { ...(counts.metadata ?? {}), ...(zeroRows ? { zero_rows: true } : {}) },
      });
    }
    return result;
  } catch (error) {
    if (id) {
      await finishRun(id, {
        finished_at: new Date().toISOString(),
        status: "error",
        error_note: ((error as Error).message ?? String(error)).slice(0, 2000),
      });
    }
    throw error;
  }
}
