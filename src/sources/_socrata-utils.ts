/**
 * Shared helpers for Socrata-backed open-data portals.
 *
 * Most US state/municipal datasets indexed in catalog.data.gov live on
 * Socrata hosts (data.wa.gov, data.ny.gov, data.cityofchicago.org,
 * data.montgomerycountymd.gov, …). All expose:
 *   - Bulk CSV:  https://<host>/api/views/<view-id>/rows.csv?accessType=DOWNLOAD
 *   - Paged JSON: https://<host>/resource/<view-id>.json?$offset=...&$limit=...
 *
 * The JSON endpoint is more robust for our use case: predictable schema
 * (snake_case keys), no CSV-escaping surprises, supports SoQL filtering
 * with `$where=...` to push category filters server-side. The bulk CSV
 * is preferred only when row counts are very large (>500k) because the
 * JSON paging cap is 50k rows per page on most hosts.
 *
 * Usage:
 *
 *   for await (const page of fetchSocrataJson({
 *     host: "data.montgomerycountymd.gov",
 *     viewId: "v8mn-6i2r",
 *     pageSize: 1000,
 *   })) {
 *     for (const row of page) { ... }
 *   }
 */

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const DEFAULT_TIMEOUT_MS = 90_000;

export interface SocrataPageOptions {
  host: string;
  viewId: string;
  /** Server-side SoQL filter, e.g. "license_type='HVAC Contractor'". */
  where?: string;
  /** Rows per page. Default 1000. Socrata caps at 50_000 for most hosts. */
  pageSize?: number;
  /**
   * SoQL `$order` column for deterministic offset pagination. Without a
   * stable sort, Socrata may shuffle rows between pages → duplicated or
   * skipped rows on large result sets. Defaults to `:id` (the universal
   * Socrata system field), which is always present and unique.
   */
  order?: string;
  /** Hard cap on total rows yielded (for dry runs). */
  maxRows?: number;
  /** Optional Socrata app token (lifts rate-limit; not required for low volume). */
  appToken?: string;
  /** Resume from this $offset instead of 0 (for checkpointed bulk runs). */
  startOffset?: number;
}

export interface SocrataRow {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Async generator yielding pages of rows from a Socrata JSON endpoint.
 * Stops when a page returns fewer than `pageSize` rows or `maxRows` is
 * reached.
 */
export async function* fetchSocrataJson(
  opts: SocrataPageOptions,
): AsyncGenerator<SocrataRow[], void, undefined> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  let offset = opts.startOffset ?? 0;
  let yielded = 0;
  for (;;) {
    if (yielded >= maxRows) return;
    const remaining = maxRows - yielded;
    const limit = Math.min(pageSize, remaining);
    const url = new URL(`https://${opts.host}/resource/${opts.viewId}.json`);
    url.searchParams.set("$limit", String(limit));
    url.searchParams.set("$offset", String(offset));
    // Stable sort so $offset paging can't duplicate/skip rows.
    url.searchParams.set("$order", opts.order ?? ":id");
    if (opts.where) url.searchParams.set("$where", opts.where);

    const headers: Record<string, string> = {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: "application/json",
    };
    if (opts.appToken) headers["X-App-Token"] = opts.appToken;

    // Retry transient network failures (fetch failed, ECONNRESET,
    // timeouts) AND transient HTTP statuses (429 rate-limit, 408, 5xx).
    // Socrata anonymous traffic gets throttled and intermittently returns
    // 500s on long streams; a single one used to crash the whole bulk run
    // mid-pagination (observed killing SECOP at offset ~20k). We back off
    // exponentially. Non-retryable 4xx (e.g. 400 bad SoQL, 404) still throw.
    const MAX_ATTEMPTS = 6;
    const isRetryableStatus = (s: number): boolean =>
      s === 429 || s === 408 || s >= 500;
    let res: Response | null = null;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const r = await fetch(url.toString(), {
          headers,
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        if (!r.ok && isRetryableStatus(r.status) && attempt < MAX_ATTEMPTS) {
          const body = await r.text().catch(() => "");
          lastErr = new Error(
            `[socrata] ${r.status} ${opts.host}/${opts.viewId}: ${body.slice(0, 160)}`,
          );
          const wait = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
          console.warn(
            `[socrata] HTTP ${r.status} (attempt ${attempt}/${MAX_ATTEMPTS}) ` +
              `${opts.host}/${opts.viewId} offset=${offset}; retrying in ${wait}ms`,
          );
          await new Promise((r2) => setTimeout(r2, wait));
          continue;
        }
        res = r;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err as Error;
        if (attempt === MAX_ATTEMPTS) break;
        const wait = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
        console.warn(
          `[socrata] fetch failed (attempt ${attempt}/${MAX_ATTEMPTS}) ` +
            `${opts.host}/${opts.viewId} offset=${offset}: ${lastErr.message}; retrying in ${wait}ms`,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (!res) {
      throw new Error(
        `[socrata] fetch failed after ${MAX_ATTEMPTS} attempts ${opts.host}/${opts.viewId} offset=${offset}: ${lastErr?.message ?? "unknown"}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `[socrata] ${res.status} ${opts.host}/${opts.viewId}: ${body.slice(0, 200)}`,
      );
    }
    const rows = (await res.json()) as SocrataRow[];
    if (!Array.isArray(rows) || rows.length === 0) return;
    yield rows;
    yielded += rows.length;
    offset += rows.length;
    if (rows.length < limit) return;
  }
}

/**
 * Read a single value off a Socrata row, tolerant to case/whitespace
 * variants in column names. Returns `undefined` if missing or empty.
 */
export function socrataPick(
  row: SocrataRow,
  candidates: readonly string[],
): string | undefined {
  for (const key of candidates) {
    const v = row[key];
    if (v == null) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  // Fallback: case-insensitive match.
  const lower = new Map<string, string>();
  for (const k of Object.keys(row)) lower.set(k.toLowerCase(), k);
  for (const key of candidates) {
    const real = lower.get(key.toLowerCase());
    if (!real) continue;
    const v = row[real];
    if (v == null) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  return undefined;
}
