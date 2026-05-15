/**
 * iMIS public-register helper.
 *
 * iMIS (by ASI) powers public member directories for many CA professional
 * regulators (Engineers Nova Scotia, NSBS, PEGNL, etc.). The pages are
 * classic ASP.NET WebForms with a postback model:
 *
 *   1. GET the search page → scrape hidden tokens (__VIEWSTATE,
 *      __VIEWSTATEGENERATOR, __EVENTVALIDATION, sometimes __VIEWSTATEENCRYPTED).
 *   2. POST the same page with form filters + tokens → server renders
 *      a `<table>` of results inside an UpdatePanel-ish container.
 *   3. Paginate by issuing __doPostBack against the grid's pager
 *      (target like `ctl00$..._GridPagerControl` with arg `Page$N`).
 *
 * Because the markup varies per tenant (different control IDs, table
 * classes, column orders), this helper does only the protocol-level
 * heavy lifting: token extraction, postback, and best-effort table
 * extraction. Source modules supply a row mapper.
 *
 * Off-by-default. Each consuming source has its own PROLIO_RUN_* flag.
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_DELAY_MS = 1500;

export interface ImisTokens {
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
  viewStateEncrypted?: string;
  /** Any other hidden ASP.NET fields that appear on the form. */
  extra: Record<string, string>;
}

export interface ImisFetchOptions {
  /** Search page URL (full, including scheme). */
  url: string;
  /** Form field overrides for the initial search POST. Keys are name= as in HTML. */
  formFields: Record<string, string>;
  /** Optional event target / argument to trigger a specific button postback. */
  eventTarget?: string;
  eventArgument?: string;
  /** Cookies retained from a prior call (e.g. ASP.NET session). */
  cookieJar?: Map<string, string>;
  /** Per-request timeout override. */
  timeoutMs?: number;
}

export interface ImisRow {
  cells: string[];
  /** Raw HTML of the row (in case the mapper needs hrefs/data-* attrs). */
  rowHtml: string;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract all hidden ASP.NET tokens from a server-rendered HTML page.
 * Tolerates attribute ordering and either single/double quotes.
 */
export function parseImisTokens(html: string): ImisTokens {
  const hiddenRe =
    /<input[^>]*type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
  // Also handle name/value-before-type orderings:
  const hiddenRe2 =
    /<input[^>]*name=["']([^"']+)["'][^>]*type=["']hidden["'][^>]*value=["']([^"']*)["'][^>]*>/gi;

  const found = new Map<string, string>();
  for (const re of [hiddenRe, hiddenRe2]) {
    re.lastIndex = 0;
    for (const m of html.matchAll(re)) {
      const [, name, value] = m;
      if (name && !found.has(name)) found.set(name, value ?? "");
    }
  }

  const viewState = found.get("__VIEWSTATE") ?? "";
  const viewStateGenerator = found.get("__VIEWSTATEGENERATOR") ?? "";
  const eventValidation = found.get("__EVENTVALIDATION") ?? "";
  const viewStateEncrypted = found.get("__VIEWSTATEENCRYPTED");

  if (!viewState) {
    throw new Error("iMIS: __VIEWSTATE not found on page (not WebForms?)");
  }

  const extra: Record<string, string> = {};
  for (const [k, v] of found) {
    if (k.startsWith("__")) continue;
    extra[k] = v;
  }

  return {
    viewState,
    viewStateGenerator,
    eventValidation,
    viewStateEncrypted,
    extra,
  };
}

function mergeSetCookies(jar: Map<string, string>, headers: Headers): void {
  // Node's fetch coalesces Set-Cookie into a single header by `, ` delim.
  // We use getSetCookie() when available, else fall back to a best-effort split.
  const list: string[] =
    typeof (headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie === "function"
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : (headers.get("set-cookie") ?? "").split(/,(?=\s*\w+=)/);
  for (const raw of list) {
    if (!raw) continue;
    const firstPair = raw.split(";")[0].trim();
    const eq = firstPair.indexOf("=");
    if (eq <= 0) continue;
    const name = firstPair.slice(0, eq).trim();
    const value = firstPair.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * GET the search page and return tokens + cookie jar.
 */
export async function imisLoad(
  url: string,
  opts: { timeoutMs?: number; cookieJar?: Map<string, string> } = {},
): Promise<{ html: string; tokens: ImisTokens; cookieJar: Map<string, string> }> {
  const jar = opts.cookieJar ?? new Map<string, string>();
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html",
      ...(jar.size > 0 ? { Cookie: cookieHeader(jar) } : {}),
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`iMIS GET ${url} → ${res.status}`);
  }
  mergeSetCookies(jar, res.headers);
  const html = await res.text();
  const tokens = parseImisTokens(html);
  return { html, tokens, cookieJar: jar };
}

/**
 * Issue a postback against an iMIS page. Returns response HTML + refreshed tokens.
 *
 * The body merges the standard ASP.NET hidden fields with caller-supplied
 * form fields. Pass `eventTarget`/`eventArgument` for grid/pager postbacks.
 */
export async function imisPostback(
  url: string,
  tokens: ImisTokens,
  options: ImisFetchOptions,
): Promise<{
  html: string;
  tokens: ImisTokens;
  cookieJar: Map<string, string>;
}> {
  const jar = options.cookieJar ?? new Map<string, string>();
  const params = new URLSearchParams();
  params.set("__EVENTTARGET", options.eventTarget ?? "");
  params.set("__EVENTARGUMENT", options.eventArgument ?? "");
  params.set("__VIEWSTATE", tokens.viewState);
  if (tokens.viewStateGenerator) {
    params.set("__VIEWSTATEGENERATOR", tokens.viewStateGenerator);
  }
  if (tokens.eventValidation) {
    params.set("__EVENTVALIDATION", tokens.eventValidation);
  }
  if (tokens.viewStateEncrypted !== undefined) {
    params.set("__VIEWSTATEENCRYPTED", tokens.viewStateEncrypted);
  }
  for (const [k, v] of Object.entries(tokens.extra)) {
    // Caller-supplied fields override page defaults.
    if (!(k in options.formFields)) params.set(k, v);
  }
  for (const [k, v] of Object.entries(options.formFields)) {
    params.set(k, v);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
      Referer: url,
      ...(jar.size > 0 ? { Cookie: cookieHeader(jar) } : {}),
    },
    body: params.toString(),
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`iMIS POST ${url} → ${res.status}`);
  }
  mergeSetCookies(jar, res.headers);
  const html = await res.text();
  // Refresh tokens — most iMIS pages re-emit the hidden inputs on every POST.
  // If parsing fails (e.g. error page), fall back to the previous tokens.
  let nextTokens: ImisTokens;
  try {
    nextTokens = parseImisTokens(html);
  } catch {
    nextTokens = tokens;
  }
  return { html, tokens: nextTokens, cookieJar: jar };
}

/**
 * Extract `<tr>` rows from the first `<table>` whose markup matches
 * `tableMarker` (substring of the table tag, e.g. an id or class).
 *
 * If `tableMarker` is empty/undefined, picks the largest table in the page.
 */
export function extractImisRows(
  html: string,
  tableMarker?: string,
): ImisRow[] {
  const tables: Array<{ tag: string; body: string }> = [];
  const tableRe = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  for (const m of html.matchAll(tableRe)) {
    tables.push({ tag: m[1] ?? "", body: m[2] ?? "" });
  }
  if (tables.length === 0) return [];

  let chosen: { tag: string; body: string } | undefined;
  if (tableMarker && tableMarker.length > 0) {
    chosen = tables.find((t) => t.tag.includes(tableMarker));
  }
  if (!chosen) {
    chosen = tables.reduce((a, b) => (a.body.length >= b.body.length ? a : b));
  }

  const rows: ImisRow[] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const m of chosen.body.matchAll(rowRe)) {
    const rowHtml = m[1] ?? "";
    const cells: string[] = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    for (const cm of rowHtml.matchAll(cellRe)) {
      cells.push(stripHtml(cm[1] ?? ""));
    }
    if (cells.length > 0) rows.push({ cells, rowHtml });
  }
  return rows;
}

export function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Iterate pages of an iMIS result grid.
 *
 * Pager target is something like `ctl00$ContentPlaceHolder1$..$gv` with
 * argument `Page$<N>`. Source must supply both; helper drives the loop.
 */
export interface ImisPaginateOptions extends ImisFetchOptions {
  /** Pager __EVENTTARGET (server control path). */
  pagerTarget: string;
  /** Optional table marker for `extractImisRows`. */
  tableMarker?: string;
  /** Max pages to walk before bailing out. */
  maxPages?: number;
  /** Stop early when this many rows have been collected. */
  maxRows?: number;
  /** Hook to map an ImisRow → caller's domain type. Return null to drop the row. */
  mapRow: (row: ImisRow, pageIndex: number) => unknown | null;
  /** Per-page delay override. */
  delayMs?: number;
}

export async function imisPaginate<T>(
  initialHtml: string,
  initialTokens: ImisTokens,
  options: ImisPaginateOptions,
): Promise<T[]> {
  const out: T[] = [];
  const maxPages = options.maxPages ?? 500;
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const delayMs = options.delayMs ?? REQUEST_DELAY_MS;

  let html = initialHtml;
  let tokens = initialTokens;
  let cookieJar = options.cookieJar ?? new Map<string, string>();

  for (let page = 1; page <= maxPages; page += 1) {
    const rows = extractImisRows(html, options.tableMarker);
    let addedThisPage = 0;
    for (const row of rows) {
      const mapped = options.mapRow(row, page);
      if (mapped) {
        out.push(mapped as T);
        addedThisPage += 1;
        if (out.length >= maxRows) return out;
      }
    }
    if (addedThisPage === 0) break;
    if (page >= maxPages) break;

    await delay(delayMs);
    try {
      const next = await imisPostback(options.url, tokens, {
        ...options,
        eventTarget: options.pagerTarget,
        eventArgument: `Page$${page + 1}`,
        cookieJar,
      });
      // If next page returns identical HTML (same row signatures), bail out.
      if (next.html === html) break;
      html = next.html;
      tokens = next.tokens;
      cookieJar = next.cookieJar;
    } catch (error) {
      console.error(
        `[imis] pager fetch failed at page ${page + 1}: ${(error as Error).message}`,
      );
      break;
    }
  }

  return out;
}
