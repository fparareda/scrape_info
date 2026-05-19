import { inflateRawSync } from "node:zlib";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * CSLB — Contractors State License Board (California, USA).
 *
 * California's official licensing body for ALL contractors: general
 * (A/B), electrical (C-10), plumbing (C-36), HVAC (C-20), cabinet
 * and finish carpentry (C-6), plus ~40 specialty classifications.
 * Free, public, ~280k active licensees state-wide.
 *
 * Pre-flight (2026-04-24):
 *   robots.txt — host returns 404 (no rules). Falls open per the
 *     parent-domain rule (cslb.ca.gov publishes no Disallow).
 *   Endpoint  — /Onlineservices/DataPortal/ListByClassification.
 *     ASP.NET WebForms page with a `<select multiple>` of every
 *     classification code. POSTing __VIEWSTATE +
 *     `ctl00$MainContent$lbClassification=<C-XX>` +
 *     `ctl00$MainContent$btnSearch=Search` returns a .xlsx file
 *     directly (Content-Type: application/vnd.openxmlformats-…).
 *   Status   — every row in the export carries Status='CLEAR'
 *     (the page server-side filters to Active licensees). No need
 *     to drop expired/revoked rows; CSLB does it for us.
 *   CAPTCHA  — none. No login. No rate-limit headers observed.
 *   Yields   — C-10: 27,939 · C-36: 17,321 · C-20: 11,576 · C-6:
 *     4,277. Probed 2026-04-24.
 *
 * Scope: only the four classifications that map cleanly to our
 * trade taxonomy. Anything else (general contractor A/B, roofing,
 * landscaping, etc.) is dropped — we have no taxonomy slot for it.
 *
 *   C-10 (Electrical)             → electricidad
 *   C-36 (Plumbing)               → fontaneria
 *   C-20 (Warm-Air Heating, A/C)  → electricidad   (HVAC bucket)
 *   C-6  (Cabinet, Millwork,
 *         Finish Carpentry)       → carpinteria
 *
 * Off by default. Enable via `PROLIO_RUN_CSLB=true`. Cap via
 * `PROLIO_CSLB_LIMIT` (default 2000, applied across all four
 * classifications combined).
 *
 * The .xlsx is parsed with a tiny in-process ZIP+sharedStrings
 * reader — we deliberately avoid pulling in a new dep
 * (xlsx/exceljs/jszip) for one well-shaped file format.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LIMIT = 2000;

const FORM_URL =
  "https://www.cslb.ca.gov/Onlineservices/DataPortal/ListByClassification";

// --- Category mapping --------------------------------------------------

const CATEGORY_ELECTRICIAN: CategoryKey = "electricidad";
const CATEGORY_PLUMBER: CategoryKey = "fontaneria";
const CATEGORY_CARPENTER: CategoryKey = "carpinteria";

interface ClassMap {
  code: string;
  category: CategoryKey;
  /** Description for telemetry/logs only. */
  description: string;
}

/**
 * The four classifications we ingest. The export's Classification
 * column may carry combined codes (e.g. " A | C10"); we match by
 * substring against `code` rather than exact equality so a row with
 * multiple licences still routes to the correct trade.
 *
 * Note CSLB renders the code as `C10` (no hyphen) inside the export
 * even though the form value is `C-10`. Both forms are checked.
 */
const TARGET_CLASSIFICATIONS: ClassMap[] = [
  { code: "C-10", category: CATEGORY_ELECTRICIAN, description: "Electrical" },
  { code: "C-36", category: CATEGORY_PLUMBER, description: "Plumbing" },
  { code: "C-20", category: CATEGORY_ELECTRICIAN, description: "HVAC" },
  { code: "C-6", category: CATEGORY_CARPENTER, description: "Carpentry" },
];

// --- City mapping ------------------------------------------------------

/**
 * Map a raw CSLB city string (uppercase, e.g. "SAN LEANDRO") to a
 * seeded city_slug under country='US'. Keys are the lowercase
 * normalised CSLB city names; values are `cities.slug` from the US
 * seed (migration 0034 + 0045). Anything not in this table is
 * dropped — the sink would reject it anyway because the FK targets
 * `cities.slug`. Pre-filtering keeps batches small.
 *
 * California metros only — we don't have non-CA US-state cities
 * mapped here because every CSLB licensee is California (the
 * Mailing Address State column for these four classes is virtually
 * always CA; the few out-of-state rows we drop quietly).
 *
 * Slugs with `-us-ca` suffix (e.g. `los-angeles-us-ca`) disambiguate
 * from same-named cities in other states; bare slugs (e.g.
 * `sacramento`, `oakland`) are unique enough to not need the suffix.
 */
const CSLB_CITY_ALIAS: Record<string, string> = {
  // Top-tier metros
  "los angeles": "los-angeles-us-ca",
  "san diego": "san-diego-us-ca",
  "san jose": "san-jose-us-ca",
  "san francisco": "san-francisco-us-ca",
  // Single-occurrence US slugs
  fresno: "fresno",
  sacramento: "sacramento",
  "long beach": "long-beach",
  oakland: "oakland",
  bakersfield: "bakersfield",
  anaheim: "anaheim",
  stockton: "stockton",
  riverside: "riverside",
  "santa ana": "santa-ana",
  irvine: "irvine",
  "chula vista": "chula-vista",
  fremont: "fremont",
  "santa clarita": "santa-clarita",
  "san bernardino": "san-bernardino",
  modesto: "modesto",
  "moreno valley": "moreno-valley",
  fontana: "fontana",
  oxnard: "oxnard",
  "huntington beach": "huntington-beach",
  // CA Glendale (NOT AZ Glendale). CSLB never lists AZ pros.
  glendale: "glendale-us-ca",
  "santa rosa": "santa-rosa",
  "elk grove": "elk-grove",
  ontario: "ontario",
  "rancho cucamonga": "rancho-cucamonga",
  oceanside: "oceanside",
  lancaster: "lancaster",
  "garden grove": "garden-grove",
  palmdale: "palmdale",
  salinas: "salinas",
  hayward: "hayward",
  corona: "corona",
  sunnyvale: "sunnyvale",
  // CA Pasadena (NOT TX Pasadena). CSLB never lists TX pros.
  pasadena: "pasadena-us-ca",
  pomona: "pomona",
  escondido: "escondido",
  roseville: "roseville",
  torrance: "torrance",
  fullerton: "fullerton",
  visalia: "visalia",
  orange: "orange",
  victorville: "victorville",
  "santa clara": "santa-clara",
  "thousand oaks": "thousand-oaks",
  "simi valley": "simi-valley",
  vallejo: "vallejo",
  concord: "concord",
  berkeley: "berkeley",
  clovis: "clovis",
  fairfield: "fairfield",
  // CA Richmond (NOT VA Richmond). CSLB never lists VA pros.
  richmond: "richmond-us-ca",
  antioch: "antioch",
  carlsbad: "carlsbad",
  downey: "downey",
  "costa mesa": "costa-mesa",
  murrieta: "murrieta",
  ventura: "ventura",
  temecula: "temecula",
};

function mapCslbCity(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  return CSLB_CITY_ALIAS[key];
}

// --- HTTP helpers ------------------------------------------------------

interface FetchResult {
  status: number;
  bodyBuf: Buffer | null;
  setCookie: string[];
  text: string | null;
}

/**
 * Fetch with a Prolio UA first; on 403/503 retry once with a Chrome
 * UA. Returns the raw body buffer (xlsx is binary) plus any Set-Cookie
 * headers so callers can carry the AntiXsrf cookie across requests.
 */
async function politeFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  wantBinary = false,
): Promise<FetchResult | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          "User-Agent": ua,
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          ...(init.headers ?? {}),
        },
        body: init.body,
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[cslb] ${new URL(url).host} blocked polite UA (${response.status}); retrying with Chrome UA`,
          );
          continue;
        }
        return { status: response.status, bodyBuf: null, setCookie: [], text: null };
      }
      // Collect Set-Cookie headers. fetch() collapses duplicates in
      // headers.get(); use getSetCookie() when available.
      let setCookie: string[] = [];
      // node>=20 fetch supports getSetCookie
      const headersAny = response.headers as Headers & {
        getSetCookie?: () => string[];
      };
      if (typeof headersAny.getSetCookie === "function") {
        setCookie = headersAny.getSetCookie();
      } else {
        const single = response.headers.get("set-cookie");
        if (single) setCookie = [single];
      }
      if (wantBinary) {
        const ab = await response.arrayBuffer();
        return {
          status: response.status,
          bodyBuf: Buffer.from(ab),
          setCookie,
          text: null,
        };
      }
      const text = await response.text();
      return { status: response.status, bodyBuf: null, setCookie, text };
    } catch (error) {
      clearTimeout(timer);
      const message = (error as Error).message ?? String(error);
      console.warn(`[cslb] network error on ${url}: ${message}`);
      return null;
    }
  }
  return null;
}

/**
 * Reduce a Set-Cookie list to a Cookie request header. We only care
 * about name=value (drop attributes). Idempotent across repeats —
 * the latest assignment of a given name wins.
 */
function buildCookieHeader(setCookies: string[], existing = ""): string {
  const jar = new Map<string, string>();
  if (existing) {
    for (const part of existing.split(";")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name) jar.set(name, value);
    }
  }
  for (const sc of setCookies) {
    const first = sc.split(";")[0];
    if (!first) continue;
    const idx = first.indexOf("=");
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (name) jar.set(name, value);
  }
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Minimal robots.txt gate. Same shape as competitor-ca-licensing.ts.
 * cslb.ca.gov returns 404 for /robots.txt — falls open.
 */
async function isRobotsBlocked(url: string): Promise<boolean> {
  const { host, pathname } = new URL(url);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`https://${host}/robots.txt`, {
      headers: { "User-Agent": POLITE_UA },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return false;
    const text = await response.text();
    return pathMatchesDisallow(pathname, text);
  } catch {
    return false;
  }
}

function pathMatchesDisallow(pathname: string, robotsTxt: string): boolean {
  const lines = robotsTxt.split(/\r?\n/);
  let inStar = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [key, ...valueParts] = line.split(":");
    if (!key) continue;
    const value = valueParts.join(":").trim();
    const k = key.toLowerCase();
    if (k === "user-agent") {
      inStar = value === "*";
    } else if (k === "disallow" && inStar && value) {
      if (value === "/") return true;
      if (pathname.startsWith(value)) return true;
    }
  }
  return false;
}

// --- ASP.NET WebForms helpers -----------------------------------------

interface ViewStateFields {
  __VIEWSTATE: string;
  __VIEWSTATEGENERATOR: string;
  __EVENTVALIDATION: string;
}

function extractHidden(html: string, name: string): string {
  const re = new RegExp(
    `name="${name}"\\s+id="${name}"\\s+value="([^"]*)"`,
  );
  const m = html.match(re);
  return m ? m[1] : "";
}

function extractViewState(html: string): ViewStateFields {
  return {
    __VIEWSTATE: extractHidden(html, "__VIEWSTATE"),
    __VIEWSTATEGENERATOR: extractHidden(html, "__VIEWSTATEGENERATOR"),
    __EVENTVALIDATION: extractHidden(html, "__EVENTVALIDATION"),
  };
}

// --- Pure-Node xlsx reader --------------------------------------------

/**
 * Parse a ZIP archive enough to extract two named entries
 * (`xl/sharedStrings.xml`, `xl/worksheets/sheet1.xml` — though CSLB's
 * export uses `sheet.xml`). We walk the local-file headers from the
 * front rather than the central directory at the back; both are valid
 * for these flat archives, and walking forward avoids needing to
 * read the EOCD record + chase central-dir offsets.
 *
 * Supports stored (method 0) and deflate (method 8). CSLB always uses
 * deflate.
 */
function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const SIG = 0x04034b50;
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== SIG) break;
    const method = buf.readUInt16LE(off + 8);
    const compressedSize = buf.readUInt32LE(off + 18);
    const uncompressedSize = buf.readUInt32LE(off + 22);
    const fileNameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const fileName = buf.slice(off + 30, off + 30 + fileNameLen).toString("utf8");
    const dataStart = off + 30 + fileNameLen + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (fileName === name) {
      const slice = buf.slice(dataStart, dataEnd);
      if (method === 0) return slice;
      if (method === 8) {
        try {
          const out = inflateRawSync(slice);
          // Sanity: uncompressed size matches when present.
          void uncompressedSize;
          return out;
        } catch (e) {
          console.warn(`[cslb] inflate failed for ${name}: ${(e as Error).message}`);
          return null;
        }
      }
      console.warn(`[cslb] unsupported zip method ${method} for ${name}`);
      return null;
    }
    off = dataEnd;
  }
  return null;
}

/**
 * Parse the sharedStrings.xml document into a flat array indexed by
 * the `<x:c t="s">` cells in sheet.xml. Each `<x:si>` element holds
 * one `<x:t>` (occasionally split across runs, but CSLB's export
 * never uses runs in our four target classifications). We accept
 * both `<x:t>...</x:t>` and `<x:t xml:space="preserve">...</x:t>`.
 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<x:si>(?:<x:t(?:\s+xml:space="preserve")?>([\s\S]*?)<\/x:t>|<x:r>([\s\S]*?)<\/x:r>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const direct = m[1];
    if (direct !== undefined) {
      out.push(unescapeXml(direct));
    } else {
      // Run-based si: concatenate every <x:t> inside the <x:r>.
      const inner = m[2] ?? "";
      const tre = /<x:t(?:\s+xml:space="preserve")?>([\s\S]*?)<\/x:t>/g;
      let parts = "";
      let tm: RegExpExecArray | null;
      while ((tm = tre.exec(inner)) !== null) parts += unescapeXml(tm[1]);
      out.push(parts);
    }
  }
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

interface ParsedRow {
  licenseNumber: string;
  lastUpdated: string;
  businessType: string;
  businessName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  county: string;
  phoneNumber: string;
  issueDate: string;
  expirationDate: string;
  classification: string;
  status: string;
}

/**
 * Walk sheet.xml row-by-row. Column letters A..N map to the headers
 * we saw in the export (LicenseNumber, LastUpdated, …, Status).
 * `t="s"` cells point into sharedStrings; everything else is a raw
 * inline value (rare in CSLB's export — the LicenseNumber column is
 * inline numeric). Row 1 is the header; we skip it.
 */
function parseSheet(xml: string, ss: string[]): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const rowRe = /<x:row\s+r="(\d+)"[^>]*>([\s\S]*?)<\/x:row>/g;
  const cellRe =
    /<x:c\s+r="([A-Z]+)(\d+)"(?:\s+s="\d+")?(?:\s+t="([a-z]+)")?\s*(?:\/>|><x:v>([\s\S]*?)<\/x:v><\/x:c>|>([\s\S]*?)<\/x:c>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowIdx = Number(rm[1]);
    if (rowIdx === 1) continue; // header
    const inner = rm[2];
    const cells: Record<string, string> = {};
    let cm: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(inner)) !== null) {
      const colLetters = cm[1];
      const t = cm[3];
      const v = cm[4] ?? cm[5] ?? "";
      let value: string;
      if (t === "s") {
        const idx = Number(v);
        value = Number.isFinite(idx) && idx >= 0 && idx < ss.length ? ss[idx] : "";
      } else if (t === "inlineStr") {
        const m2 = v.match(/<x:t[^>]*>([\s\S]*?)<\/x:t>/);
        value = m2 ? unescapeXml(m2[1]) : "";
      } else {
        value = unescapeXml(v);
      }
      cells[colLetters] = value;
    }
    rows.push({
      licenseNumber: (cells.A ?? "").trim(),
      lastUpdated: (cells.B ?? "").trim(),
      businessType: (cells.C ?? "").trim(),
      businessName: (cells.D ?? "").trim(),
      address: (cells.E ?? "").trim(),
      city: (cells.F ?? "").trim(),
      state: (cells.G ?? "").trim(),
      zip: (cells.H ?? "").trim(),
      county: (cells.I ?? "").trim(),
      phoneNumber: (cells.J ?? "").trim(),
      issueDate: (cells.K ?? "").trim(),
      expirationDate: (cells.L ?? "").trim(),
      classification: (cells.M ?? "").trim(),
      status: (cells.N ?? "").trim(),
    });
  }
  return rows;
}

// --- Field helpers -----------------------------------------------------

function normaliseUsPhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

/**
 * Convert CSLB's MM/DD/YYYY date string to ISO YYYY-MM-DD. Returns
 * undefined for empty / unparseable values.
 */
function isoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const month = m[1].padStart(2, "0");
  const day = m[2].padStart(2, "0");
  const year = m[3];
  return `${year}-${month}-${day}`;
}

/**
 * The Classification column may carry ` A | C10` (multiple licences)
 * or a single ` C10`. We compare against both `C-10` and `C10` —
 * CSLB's form value uses the hyphen, the export drops it.
 */
function classificationMatches(rawCol: string, code: string): boolean {
  if (!rawCol) return false;
  const compact = code.replace("-", "");
  const tokens = rawCol
    .toUpperCase()
    .split(/[|,\s/]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.includes(code) || tokens.includes(compact);
}

// --- Adapter -----------------------------------------------------------

interface ClassificationResult {
  code: string;
  rowsRaw: number;
  rowsKept: number;
}

/**
 * Hit the form once to seed __VIEWSTATE + AntiXsrf cookie, then POST
 * for the requested classification. The endpoint streams a .xlsx
 * binary directly. Returns the parsed rows (may include rows whose
 * classification token list doesn't match `code` exactly, e.g. a
 * row primarily classified A but holding C10 too — `classificationMatches`
 * filters those at the upsert step).
 */
async function fetchClassification(code: string): Promise<{
  rows: ParsedRow[];
  buf: Buffer | null;
}> {
  const blocked = await isRobotsBlocked(FORM_URL);
  if (blocked) {
    console.warn(`[cslb] ${FORM_URL} blocked by robots.txt — skipping`);
    return { rows: [], buf: null };
  }

  // 1. GET to seed cookies + viewstate.
  const seed = await politeFetch(FORM_URL);
  if (!seed || !seed.text || seed.status !== 200) {
    console.warn(
      `[cslb] seed GET failed (status=${seed?.status ?? "network"})`,
    );
    return { rows: [], buf: null };
  }
  const cookieHeader = buildCookieHeader(seed.setCookie);
  const vs = extractViewState(seed.text);
  if (!vs.__VIEWSTATE) {
    console.warn(`[cslb] could not extract __VIEWSTATE from seed`);
    return { rows: [], buf: null };
  }

  // 2. POST classification + Search button.
  const form = new URLSearchParams();
  form.set("__EVENTTARGET", "");
  form.set("__EVENTARGUMENT", "");
  form.set("__VIEWSTATE", vs.__VIEWSTATE);
  form.set("__VIEWSTATEGENERATOR", vs.__VIEWSTATEGENERATOR);
  form.set("__EVENTVALIDATION", vs.__EVENTVALIDATION);
  form.set("ctl00$MainContent$lbClassification", code);
  form.set("ctl00$MainContent$btnSearch", "Search");

  const post = await politeFetch(
    FORM_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: FORM_URL,
        Cookie: cookieHeader,
      },
      body: form.toString(),
    },
    /* wantBinary */ true,
  );
  if (!post || !post.bodyBuf || post.status !== 200) {
    console.warn(
      `[cslb] POST ${code} failed (status=${post?.status ?? "network"})`,
    );
    return { rows: [], buf: null };
  }

  // 3. Validate it's actually an xlsx (PK\x03\x04 signature) — if
  //    CSLB ever returns the form HTML with errors, we want to know.
  const buf = post.bodyBuf;
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    console.warn(
      `[cslb] POST ${code} returned non-zip body (${buf.length} bytes); ` +
        `first bytes: ${buf.slice(0, 16).toString("hex")}`,
    );
    return { rows: [], buf: null };
  }

  const ssXml = readZipEntry(buf, "xl/sharedStrings.xml");
  const sheetXml =
    readZipEntry(buf, "xl/worksheets/sheet.xml") ??
    readZipEntry(buf, "xl/worksheets/sheet1.xml");
  if (!ssXml || !sheetXml) {
    console.warn(
      `[cslb] POST ${code} xlsx missing sharedStrings.xml or sheet.xml`,
    );
    return { rows: [], buf };
  }
  const ss = parseSharedStrings(ssXml.toString("utf8"));
  const rows = parseSheet(sheetXml.toString("utf8"), ss);
  return { rows, buf };
}

/**
 * Fetch all four target classifications. Returns one ScrapedProfessional
 * per unique licence number, mapped to the trade category for the
 * classification we found it under. If a licensee carries both C-10
 * and C-36 (rare — combo licences exist) the first match wins; we
 * record the multi-class info in metadata.cslb_classification.
 */
async function fetchAllCslb(limit: number): Promise<ScrapedProfessional[]> {
  const seenLicence = new Set<string>();
  const out: ScrapedProfessional[] = [];
  let droppedNoCity = 0;
  let droppedNoLicence = 0;
  let droppedNoName = 0;
  let droppedBadStatus = 0;
  let droppedClassMismatch = 0;
  const perClass: ClassificationResult[] = [];

  for (const klass of TARGET_CLASSIFICATIONS) {
    if (out.length >= limit) break;
    console.log(
      `[cslb] fetching classification ${klass.code} (${klass.description})`,
    );
    const { rows } = await fetchClassification(klass.code);
    let kept = 0;
    for (const row of rows) {
      if (out.length >= limit) break;
      // Sanity guards:
      const licence = row.licenseNumber.trim();
      if (!licence) {
        droppedNoLicence += 1;
        continue;
      }
      if (seenLicence.has(licence)) continue;
      const name = row.businessName.trim();
      if (!name) {
        droppedNoName += 1;
        continue;
      }
      // CSLB exports already filter to Status=CLEAR (Active). Defend
      // against future schema changes — drop anything else.
      const status = row.status.trim().toUpperCase();
      if (status && status !== "CLEAR") {
        droppedBadStatus += 1;
        continue;
      }
      // Confirm this row actually carries the target classification.
      // The export sometimes returns rows whose primary classification
      // is something else but who hold the queried class as a 2nd
      // licence; we still want them.
      if (!classificationMatches(row.classification, klass.code)) {
        droppedClassMismatch += 1;
        continue;
      }
      const citySlug = mapCslbCity(row.city);
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      seenLicence.add(licence);
      const addressParts = [row.address, row.city, row.state, row.zip]
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const record = normalise({
        source: "cslb",
        country: "US",
        sourceId: `cslb:${licence}`,
        name,
        categoryKey: klass.category,
        citySlug,
        phone: normaliseUsPhone(row.phoneNumber),
        address: addressParts.length > 0 ? addressParts.join(", ") : undefined,
        licenseNumber: licence,
        foundedAt: isoDate(row.issueDate),
        metadata: {
          country: "US",
          state: "CA",
          verified_by_authority: true,
          authority: "CSLB",
          cslb_status: status || "CLEAR",
          cslb_classification: row.classification.trim(),
          cslb_primary_match: klass.code,
          cslb_county: row.county || undefined,
          cslb_business_type: row.businessType || undefined,
          cslb_expiration_date: isoDate(row.expirationDate),
          cslb_last_updated: isoDate(row.lastUpdated),
        },
      });
      out.push(record);
      kept += 1;
    }
    perClass.push({ code: klass.code, rowsRaw: rows.length, rowsKept: kept });
  }

  console.log(
    `[cslb] parsed=${out.length} ` +
      `droppedNoCity=${droppedNoCity} droppedNoLicence=${droppedNoLicence} ` +
      `droppedNoName=${droppedNoName} droppedBadStatus=${droppedBadStatus} ` +
      `droppedClassMismatch=${droppedClassMismatch}`,
  );
  for (const pc of perClass) {
    console.log(
      `[cslb]   ${pc.code}: rowsRaw=${pc.rowsRaw} rowsKept=${pc.rowsKept}`,
    );
  }
  return out;
}

// --- Public entrypoint -------------------------------------------------

export const cslbSource: ScraperSource = {
  name: "cslb",
  enabled() {
    return process.env.PROLIO_RUN_CSLB === "true";
  },
  async fetch() {
    return [];
  },
};

/**
 * Bulk runner. Cap via PROLIO_CSLB_LIMIT (default 2000).
 */
export async function runCslb(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cslbSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_CSLB_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  if (rawLimit !== limit) {
    console.warn(
      `[cslb] invalid PROLIO_CSLB_LIMIT=${process.env.PROLIO_CSLB_LIMIT}; using ${DEFAULT_LIMIT}`,
    );
  }

  const records = await fetchAllCslb(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[cslb] done — fetched=${records.length} inserted=${inserted} ` +
      `updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
