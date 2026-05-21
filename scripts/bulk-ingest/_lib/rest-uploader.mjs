// Direct-to-Supabase REST uploader with the patterns we learned the hard way:
//
//   * stream-and-flush: caller pushes payloads, we hold at most MAX_INFLIGHT
//     batches in flight at once → bounded memory even on million-row imports.
//   * Halving on statement-timeout / 23505 conflicts: if a 500-row batch trips
//     the Postgres 57014 timeout or hits a 23505 unique-violation, we split it
//     down to 1-row attempts before logging-and-skipping. Avoids losing a whole
//     batch when one row is bad.
//   * Retries 503/504/408 with backoff (transient Cloudflare hiccups).
//   * Configurable concurrency (3 default; 6 is the upper bound before
//     Cloudflare starts rate-limiting and parallel processes stop helping).
//
// Throughput observed:
//   * Postgres-only (no sink lookups): ~800-1000 rows/sec @ concurrency 6
//   * With city lookups, etc.: ~200-500 rows/sec
//   * vs. GHA + supabase-js client: ~0.6 rows/sec (~500× speedup)
import { requireSupabase } from "./env.mjs";

const DEFAULTS = {
  batchSize: 500,
  concurrency: 3,
  table: "professionals",
  onConflict: "source,source_id",
  preferReturnMinimal: true,
};

export function createUploader(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const { SUPABASE_URL, SERVICE_KEY } = requireSupabase();
  const endpoint = `${SUPABASE_URL}/rest/v1/${cfg.table}?on_conflict=${encodeURIComponent(cfg.onConflict)}`;
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    Prefer: `resolution=ignore-duplicates,return=${cfg.preferReturnMinimal ? "minimal" : "representation"}`,
  };

  async function postBatch(rows, attempt = 0) {
    if (rows.length === 0) return 0;
    const r = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(rows),
    });
    if (r.ok) return rows.length;
    const txt = await r.text();
    // Transient: retry with exp backoff
    if (attempt < 3 && [503, 504, 408].includes(r.status)) {
      await new Promise(rs => setTimeout(rs, 2000 * (attempt + 1)));
      return postBatch(rows, attempt + 1);
    }
    // Statement timeout (57014) or unique-violation (23505) → halve and retry.
    const isTimeout = txt.includes('"57014"') || txt.toLowerCase().includes("timeout");
    const isConflict = r.status === 409 || txt.includes('"23505"');
    if ((isTimeout || isConflict) && rows.length > 1) {
      const mid = Math.floor(rows.length / 2);
      const a = await postBatch(rows.slice(0, mid));
      const b = await postBatch(rows.slice(mid));
      return a + b;
    }
    if (rows.length === 1) {
      // Last resort: skip + log. Doesn't crash the whole import.
      console.error(`  skip single row (HTTP ${r.status}): ${txt.slice(0, 160)}`);
      return 0;
    }
    throw new Error(`HTTP ${r.status}: ${txt.slice(0, 500)}`);
  }

  // Stream-and-flush state.
  const state = {
    buffer: [],
    pending: new Set(),
    kept: 0,
    inserted: 0,
    failed: 0,
    t0: Date.now(),
    lastLogKept: 0,
  };

  async function flush() {
    if (state.buffer.length === 0) return;
    const slice = state.buffer;
    state.buffer = [];
    while (state.pending.size >= cfg.concurrency) {
      await Promise.race(state.pending);
    }
    const p = postBatch(slice)
      .then(ok => { state.inserted += ok; })
      .catch(e => {
        state.failed += slice.length;
        console.error(`  batch failed: ${e.message.slice(0, 200)}`);
      })
      .finally(() => {
        state.pending.delete(p);
        if (state.kept - state.lastLogKept >= 10000) {
          state.lastLogKept = state.kept;
          const el = (Date.now() - state.t0) / 1000;
          const rate = (state.kept / el).toFixed(0);
          console.error(
            `  [kept=${state.kept.toLocaleString()}] inserted ~${state.inserted.toLocaleString()} failed ${state.failed} ${rate} r/s`,
          );
        }
      });
    state.pending.add(p);
  }

  async function push(row) {
    state.buffer.push(row);
    state.kept++;
    if (state.buffer.length >= cfg.batchSize) await flush();
  }

  async function done() {
    await flush();
    await Promise.all(state.pending);
    const elapsed = ((Date.now() - state.t0) / 1000).toFixed(0);
    console.error(
      `DONE in ${elapsed}s. kept=${state.kept.toLocaleString()} inserted~${state.inserted.toLocaleString()} failed=${state.failed}`,
    );
    return { ...state, elapsed: Number(elapsed) };
  }

  return { push, flush, done, postBatch, getState: () => ({ ...state }) };
}

/** Build a unique-ish slug from `name` + `citySlug` for the `professionals.slug` column. */
export function buildPersonSlug(name, citySlug) {
  const base = (name || "x")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `${base || "x"}-${citySlug || "x"}-${Math.random().toString(36).slice(2, 8)}`;
}
