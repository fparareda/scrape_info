/**
 * Alinity public-directory helper.
 *
 * Alinity (alinityapp.com) is a SaaS used by many Canadian colleges
 * (medical, psychology, physiotherapy, law society) to expose a public
 * member register. Every tenant exposes the same shell page at
 *   https://<tenant>.alinityapp.com/client/publicdirectory
 * The page is rendered server-side and contains:
 *   - `<input id="querySID" value="<N>">` — opaque query ID required to
 *     call the search endpoint.
 *   - A `_plugin.initializeForm({...})` JSON literal describing the
 *     filter form fields. Tenants typically expose:
 *       TextOptionA = first name
 *       TextOptionB = last name (the field we search on)
 *       (other tenant-specific filters)
 *
 * Search endpoint:
 *   POST https://<tenant>.alinityapp.com/client/PublicDirectory/Registrants
 *   Content-Type: application/x-www-form-urlencoded
 *   body:
 *     querySID=<N>
 *     queryParameters={"Parameter":[{"ID":"TextOptionB","Value":"sm","ValueLabel":"sm"}]}
 *   reply:
 *     { EnableCaptcha: false, SearchCriteria: [...], Records: [
 *         { rg, rn, fn, ln, mcn, reg, hc, c, ... }, ...
 *     ] }
 *
 * The server applies a substring match. Many tenants reject 1-character
 * queries (return Records:[]). Some tenants (e.g. cap, AB psychologists)
 * cap each response at 25 rows with no pagination, so we recursively
 * drill down — when a 2-letter prefix saturates we try its 3-letter
 * children, etc. Other tenants return everything (we observed 1196 rows
 * on cpspei for prefix "a"). Recursion is bounded by MAX_PREFIX_LEN.
 *
 * Rate limit: 250 ms between requests. 30s timeout. Failures on a
 * specific prefix are logged once and skipped — they don't abort the
 * whole iteration.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Prolio-Bot/1.0 (+contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 250;
const MAX_PREFIX_LEN = 4;
const SATURATED_THRESHOLD = 25; // most tenants either return >25 or cap at 25

export interface AlinityRecord {
  /** Tenant-stable GUID identifying the registrant. */
  registrantGuid?: string;
  /** Registration / licence number. */
  registrationNumber?: string;
  /** Full display name "First Last". */
  name: string;
  /** First name (`fn`). */
  firstName?: string;
  /** Last name (`ln`). */
  lastName?: string;
  /** Practice city (`mcn` / `oc`). */
  city?: string;
  /** Practice register / status (`reg`). */
  status?: string;
  /** Registration date — not exposed by Alinity public directory. Always undefined. */
  registrationDate?: string;
  /** Raw JSON record so callers can extract niche fields. */
  raw: Record<string, unknown>;
}

export interface FetchAlinityOpts {
  /** Total hard cap. */
  limit?: number;
  /** Override the discovered querySID. */
  querySID?: string;
  /** Field ID to filter on (default `TextOptionB` = last name). */
  searchFieldId?: string;
  /** Max prefix length to drill to (default 4). */
  maxPrefixLen?: number;
  /** Alphabet used to enumerate prefixes (default a..z). */
  alphabet?: string;
  /** Override per-request delay in ms. Default REQUEST_DELAY_MS (250).
   *  Bump for tenants that rate-limit aggressively (e.g. MVMA Manitoba
   *  starts 403'ing after ~15 quick requests; use 2500ms there). */
  requestDelayMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AlinityRawRow {
  rg?: string;
  rn?: string;
  fn?: string;
  ln?: string;
  rl?: string; // "Last, First (rn)" in some tenants
  mcn?: string;
  oc?: string;
  reg?: string;
  hc?: string;
  c?: string;
  [k: string]: unknown;
}

interface AlinitySearchResponse {
  EnableCaptcha?: boolean;
  SearchCriteria?: string[];
  Records?: AlinityRawRow[];
}

function toAlinityRecord(row: AlinityRawRow): AlinityRecord | null {
  let first = typeof row.fn === "string" ? row.fn.trim() : undefined;
  let last = typeof row.ln === "string" ? row.ln.trim() : undefined;
  // Some tenants (e.g. cpspei) only expose `rl` as "Last, First (rn)".
  if (!first && !last && typeof row.rl === "string") {
    const m = row.rl.match(/^([^,]+),\s*([^()]+?)(?:\s*\(([^)]+)\))?\s*$/);
    if (m) {
      last = m[1].trim();
      first = m[2].trim();
      if (!row.rn && m[3]) row.rn = m[3].trim();
    } else {
      last = row.rl.trim();
    }
  }
  const name = [first, last].filter(Boolean).join(" ").trim();
  if (!name) return null;
  return {
    registrantGuid: typeof row.rg === "string" ? row.rg : undefined,
    registrationNumber: typeof row.rn === "string" ? row.rn : undefined,
    name,
    firstName: first,
    lastName: last,
    city: typeof row.mcn === "string" ? row.mcn : typeof row.oc === "string" ? row.oc : undefined,
    status: typeof row.reg === "string" ? row.reg : undefined,
    raw: row,
  };
}

async function fetchPublicDirectoryShell(
  tenant: string,
): Promise<{ querySID: string } | null> {
  const url = `https://${tenant}.alinityapp.com/client/publicdirectory`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const html = await response.text();
    const m = html.match(/id="querySID"[^>]*value="(\d+)"/);
    if (!m) return null;
    return { querySID: m[1] };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchPrefix(
  tenant: string,
  querySID: string,
  fieldId: string,
  prefix: string,
): Promise<AlinityRawRow[] | null> {
  const url = `https://${tenant}.alinityapp.com/client/PublicDirectory/Registrants`;
  const queryParameters = JSON.stringify({
    Parameter: [{ ID: fieldId, Value: prefix, ValueLabel: prefix }],
  });
  const body =
    `querySID=${encodeURIComponent(querySID)}` +
    `&queryParameters=${encodeURIComponent(queryParameters)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json,text/plain,*/*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const ct = response.headers.get("content-type") || "";
    if (!ct.includes("json")) return null;
    const json = (await response.json()) as AlinitySearchResponse;
    return json.Records ?? [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function* fetchAlinityDirectory(
  tenant: string,
  opts: FetchAlinityOpts = {},
): AsyncIterableIterator<AlinityRecord> {
  const limit = opts.limit ?? 50_000;
  const maxPrefixLen = opts.maxPrefixLen ?? MAX_PREFIX_LEN;
  const requestDelayMs = opts.requestDelayMs ?? REQUEST_DELAY_MS;
  const alphabet = opts.alphabet ?? "abcdefghijklmnopqrstuvwxyz";
  const fieldId = opts.searchFieldId ?? "TextOptionB";

  let querySID = opts.querySID;
  if (!querySID) {
    const shell = await fetchPublicDirectoryShell(tenant);
    if (!shell) {
      console.warn(
        `[alinity] tenant=${tenant} could not load directory shell (DNS or 4xx) — skipping`,
      );
      return;
    }
    querySID = shell.querySID;
  }

  // Seed queue with all 2-letter prefixes (single-letter rejected by many tenants).
  const queue: string[] = [];
  for (const a of alphabet) {
    for (const b of alphabet) queue.push(a + b);
  }

  const seen = new Set<string>();
  let yielded = 0;
  let firstHitObserved = false;

  while (queue.length > 0 && yielded < limit) {
    const prefix = queue.shift() as string;
    const rows = await searchPrefix(tenant, querySID, fieldId, prefix);
    await delay(requestDelayMs);
    if (rows === null) {
      // transient failure - log only once
      if (!firstHitObserved) {
        console.warn(
          `[alinity] tenant=${tenant} prefix="${prefix}" non-JSON or HTTP error — continuing`,
        );
      }
      continue;
    }
    if (rows.length > 0) firstHitObserved = true;

    // If saturated and we can drill further, expand prefix.
    if (rows.length >= SATURATED_THRESHOLD && prefix.length < maxPrefixLen) {
      for (const c of alphabet) queue.push(prefix + c);
    }

    for (const row of rows) {
      if (yielded >= limit) return;
      const rec = toAlinityRecord(row);
      if (!rec) continue;
      const key = rec.registrantGuid ?? rec.registrationNumber ?? `${rec.name}|${rec.city ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      yielded += 1;
      yield rec;
    }
  }

  if (!firstHitObserved) {
    console.warn(
      `[alinity] tenant=${tenant} yielded 0 rows across ${alphabet.length ** 2} prefixes — schema may have changed`,
    );
  }
}

// Back-compat alias for callers that still use the old field name.
export type { AlinityRecord as _Reexport };
