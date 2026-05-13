/**
 * Alinity public-directory helper.
 *
 * Alinity (alinityapp.com) is a SaaS used by many Canadian colleges
 * (medical, psychology, physiotherapy, law society) to expose a public
 * member register. Every tenant exposes the same endpoints under
 *   https://<tenant>.alinityapp.com/Client/PublicDirectory/
 * The HTML page is a thin shell; the actual data is loaded via XHR
 * against a JSON action that returns paginated rows. Tenants vary in
 * exact path and parameter names so we try a small set of well-known
 * shapes and use the first that responds with JSON. Callers can
 * override paths via env vars.
 *
 * Endpoints attempted (in order):
 *   1. POST  Client/PublicDirectory/Search
 *   2. POST  client/publicdirectory/Search
 *   3. POST  Client/PublicDirectorySearch/Index
 *   4. GET   Client/PublicDirectory/Search?page=N&pageSize=M
 *
 * Where verified by the calling source, the caller may pass `path`
 * explicitly to short-circuit detection.
 *
 * Rate limit: 200 ms between page requests (Alinity is shared infra;
 * we don't want to be the noisy neighbour). 5s timeout.
 *
 * Failure mode: yields nothing and logs once. The runner records the
 * empty result; the workflow keeps going (no source-internal throw).
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 200;
const DEFAULT_PAGE_SIZE = 100;

export interface AlinityRecord {
  /** Full name as displayed in the directory (e.g. "Dr. Jane Doe MD"). */
  name: string;
  /** Practice/registered city if exposed. */
  city?: string;
  /** Two-letter province code if exposed (e.g. "AB"). */
  province?: string;
  /** Registrant / licence / registration number. Stable per tenant. */
  registrationNumber?: string;
  /** Current registration status (e.g. "Active", "Practising"). */
  status?: string;
  /** ISO date of registration if exposed. */
  registrationDate?: string;
  /** Raw JSON record so callers can extract niche fields. */
  raw: Record<string, unknown>;
}

export interface FetchAlinityOpts {
  /** Total hard cap. */
  limit?: number;
  /** Rows per page (most tenants accept 25..200). */
  pageSize?: number;
  /** Override path; e.g. `client/publicdirectory/Search`. */
  path?: string;
  /** Extra JSON body fields to send on POST. */
  extraBody?: Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  // Case-insensitive secondary pass.
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) lower.set(k.toLowerCase(), v);
  for (const k of keys) {
    const v = lower.get(k.toLowerCase());
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function toAlinityRecord(row: Record<string, unknown>): AlinityRecord | null {
  const name =
    pickString(row, [
      "FullName",
      "Name",
      "DisplayName",
      "RegistrantName",
      "MemberName",
      "FullLegalName",
    ]) ?? buildFromParts(row);
  if (!name) return null;
  return {
    name,
    city: pickString(row, ["City", "PracticeCity", "WorkCity", "Town"]),
    province: pickString(row, [
      "Province",
      "ProvinceCode",
      "State",
      "ProvinceShort",
    ]),
    registrationNumber: pickString(row, [
      "RegistrationNumber",
      "RegistrantNumber",
      "LicenseNumber",
      "LicenceNumber",
      "MemberNumber",
      "Number",
    ]),
    status: pickString(row, [
      "RegistrationStatus",
      "Status",
      "MembershipStatus",
      "LicenceStatus",
      "LicenseStatus",
    ]),
    registrationDate: pickString(row, [
      "RegistrationDate",
      "InitialRegistrationDate",
      "RegisteredOn",
    ]),
    raw: row,
  };
}

function buildFromParts(row: Record<string, unknown>): string | undefined {
  const first = pickString(row, ["FirstName", "GivenName", "First"]);
  const last = pickString(row, ["LastName", "Surname", "Last", "FamilyName"]);
  if (first && last) return `${first} ${last}`;
  if (last) return last;
  if (first) return first;
  return undefined;
}

interface AlinityResponse {
  rows: Array<Record<string, unknown>>;
  total?: number;
}

function extractRowsFromPayload(payload: unknown): AlinityResponse | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  // Common shapes: { data: [], recordsTotal }, { rows: [] }, { Items: [] },
  // { Result: { Items: [] } }, [ ... ]
  if (Array.isArray(payload)) {
    return { rows: payload as Array<Record<string, unknown>> };
  }
  const candidates = ["data", "rows", "Items", "items", "Records", "records", "Results", "results"];
  for (const k of candidates) {
    const v = obj[k];
    if (Array.isArray(v)) {
      const total = readTotal(obj);
      return { rows: v as Array<Record<string, unknown>>, total };
    }
  }
  // Nested wrappers.
  const inner = obj.Result ?? obj.result ?? obj.Data ?? obj.data;
  if (inner && typeof inner === "object") {
    return extractRowsFromPayload(inner);
  }
  return null;
}

function readTotal(obj: Record<string, unknown>): number | undefined {
  for (const k of ["recordsTotal", "RecordsTotal", "Total", "total", "Count", "count"]) {
    const v = obj[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  }
  return undefined;
}

async function tryFetch(
  url: string,
  init: RequestInit,
): Promise<AlinityResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) return null;
    const json = await response.json();
    return extractRowsFromPayload(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const CANDIDATE_PATHS = [
  "Client/PublicDirectory/Search",
  "client/publicdirectory/Search",
  "Client/PublicDirectorySearch/Index",
] as const;

export async function* fetchAlinityDirectory(
  tenant: string,
  opts: FetchAlinityOpts = {},
): AsyncIterableIterator<AlinityRecord> {
  const limit = opts.limit ?? 5000;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const base = `https://${tenant}.alinityapp.com/`;
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/json,text/plain,*/*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };

  let yielded = 0;
  const paths = opts.path ? [opts.path] : [...CANDIDATE_PATHS];

  for (let page = 1; page <= Math.ceil(limit / pageSize) + 5; page += 1) {
    if (yielded >= limit) return;
    let payload: AlinityResponse | null = null;
    for (const path of paths) {
      const url = `${base}${path}`;
      const body = JSON.stringify({
        page,
        pageSize,
        start: (page - 1) * pageSize,
        length: pageSize,
        draw: page,
        ...(opts.extraBody ?? {}),
      });
      payload = await tryFetch(url, { method: "POST", headers, body });
      if (payload) break;
      // GET fallback
      const getUrl = `${url}?page=${page}&pageSize=${pageSize}`;
      payload = await tryFetch(getUrl, { method: "GET", headers });
      if (payload) break;
    }
    if (!payload || payload.rows.length === 0) {
      if (page === 1) {
        console.warn(
          `[alinity] tenant=${tenant} no JSON endpoint responded — directory may require browser/auth`,
        );
      }
      return;
    }
    for (const row of payload.rows) {
      if (yielded >= limit) return;
      const rec = toAlinityRecord(row);
      if (!rec) continue;
      yielded += 1;
      yield rec;
    }
    if (payload.rows.length < pageSize) return;
    await delay(PAGE_DELAY_MS);
  }
}
