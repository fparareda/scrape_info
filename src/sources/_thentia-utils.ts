/**
 * Thentia Cloud public-register helper.
 *
 * Thentia (thentiacloud.net) hosts public registers for several
 * Canadian regulators (AMVIC dealers, ACPM, etc).
 *
 * The HTML page is a thin SPA powered by `helsbydrake.register.all.min.js`.
 * Live data is fetched from REST endpoints at the **tenant root** (not
 * under /webs/<tenant>/). Verified shapes seen in the minified bundle:
 *
 *   GET https://<tenant>.thentiacloud.net/rest/public/facility/search/
 *   GET https://<tenant>.thentiacloud.net/rest/public/sales/search/
 *   GET https://<tenant>.thentiacloud.net/rest/public/profile/search/
 *
 * Query params: `?keyword=&skip=0&take=100&lang=en`.
 *
 * Response shape (confirmed on amvic.ca):
 *   {
 *     errorCode: "0",
 *     resultCount: <total>,
 *     result: [ { id, name, street1, city, state, zip, telephone, ... } ]
 *   }
 *
 * Different tenants expose different subsets. We try a small list of
 * known endpoints; first non-empty JSON wins.
 *
 * Failure mode: yields nothing and logs once. Callers wrap in
 * withScrapeRun so the workflow keeps going.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120 Safari/537.36 Prolio-Bot/1.0 (+contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 200;
const DEFAULT_PAGE_SIZE = 100;

export interface ThentiaRecord {
  name: string;
  city?: string;
  province?: string;
  licenseNumber?: string;
  status?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  raw: Record<string, unknown>;
}

export interface FetchThentiaOpts {
  limit?: number;
  pageSize?: number;
  /** Override REST path (relative to tenant root, e.g. "rest/public/facility/search/"). */
  path?: string;
  /** Additional querystring params. */
  query?: Record<string, string>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) lower.set(k.toLowerCase(), v);
  for (const k of keys) {
    const v = lower.get(k.toLowerCase());
    if (typeof v === "string" && v.trim().length > 0 && v.trim() !== "N/A") {
      return v.trim();
    }
  }
  return undefined;
}

function toThentiaRecord(row: Record<string, unknown>): ThentiaRecord | null {
  const name =
    pickString(row, [
      "name",
      "fullName",
      "businessName",
      "legalName",
      "displayName",
      "tradeName",
    ]) ?? combinedName(row);
  if (!name) return null;
  const street1 = pickString(row, ["street1", "address", "addressLine1", "businessAddress"]);
  const street2 = pickString(row, ["street2", "addressLine2"]);
  const address = [street1, street2].filter(Boolean).join(", ") || undefined;
  return {
    name,
    city: pickString(row, ["city", "businessCity", "town"]),
    province: pickString(row, ["province", "provinceCode", "state"]),
    licenseNumber: pickString(row, [
      "registrationNumber",
      "licenseNumber",
      "licenceNumber",
      "memberNumber",
      "number",
    ]),
    status: pickString(row, ["facilityStatus", "status", "licenseStatus", "licenceStatus"]),
    address,
    phone: pickString(row, ["telephone", "phone", "phoneNumber", "businessPhone"]),
    email: pickString(row, ["emailAddress", "email", "businessEmail"]),
    website: pickString(row, ["website", "url", "webSite"]),
    raw: row,
  };
}

function combinedName(row: Record<string, unknown>): string | undefined {
  const first = pickString(row, ["firstName", "givenName"]);
  const last = pickString(row, ["lastName", "surname"]);
  if (first && last) return `${first} ${last}`;
  return last ?? first;
}

interface ThentiaResponse {
  rows: Array<Record<string, unknown>>;
  total?: number;
}

function extractRows(payload: unknown): ThentiaResponse | null {
  if (Array.isArray(payload)) {
    return { rows: payload as Array<Record<string, unknown>> };
  }
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  // Thentia confirmed shape: { result: [...], resultCount: N }
  for (const k of ["result", "data", "results", "items", "rows", "records"]) {
    const v = obj[k];
    if (Array.isArray(v)) {
      const total = readTotal(obj);
      return { rows: v as Array<Record<string, unknown>>, total };
    }
  }
  return null;
}

function readTotal(obj: Record<string, unknown>): number | undefined {
  for (const k of ["resultCount", "total", "count", "recordsTotal", "totalCount"]) {
    const v = obj[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  }
  return undefined;
}

async function tryGet(url: string): Promise<ThentiaResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json,*/*",
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) return null;
    return extractRows(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Known Thentia REST endpoints at tenant root. Order matters: we stop
 * at the first one that returns JSON with rows.
 */
const CANDIDATE_PATHS = [
  "rest/public/facility/search/",
  "rest/public/profile/search/",
  "rest/public/register/search/",
  "rest/public/sales/search/",
  "api/public/search/",
] as const;

export async function* fetchThentiaDirectory(
  tenant: string,
  opts: FetchThentiaOpts = {},
): AsyncIterableIterator<ThentiaRecord> {
  const limit = opts.limit ?? 5000;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const base = `https://${tenant}.thentiacloud.net/`;
  const extraQuery = new URLSearchParams(opts.query ?? {});

  let yielded = 0;
  let workingPath: string | null = opts.path ?? null;

  for (let skip = 0; skip < limit + pageSize; skip += pageSize) {
    if (yielded >= limit) return;
    const candidatePaths = workingPath
      ? [workingPath]
      : [...CANDIDATE_PATHS];
    let response: ThentiaResponse | null = null;
    for (const path of candidatePaths) {
      const qs = new URLSearchParams({
        keyword: "",
        skip: String(skip),
        take: String(pageSize),
        lang: "en",
      });
      for (const [k, v] of extraQuery) qs.set(k, v);
      const url = `${base}${path}${path.includes("?") ? "&" : "?"}${qs.toString()}`;
      response = await tryGet(url);
      if (response && response.rows.length > 0) {
        workingPath = path;
        break;
      }
    }
    if (!response || response.rows.length === 0) {
      if (skip === 0) {
        console.warn(
          `[thentia] tenant=${tenant} no JSON endpoint responded with rows — register may have moved or require auth`,
        );
      }
      return;
    }
    for (const row of response.rows) {
      if (yielded >= limit) return;
      const rec = toThentiaRecord(row);
      if (!rec) continue;
      yielded += 1;
      yield rec;
    }
    if (response.rows.length < pageSize) return;
    await delay(PAGE_DELAY_MS);
  }
}
