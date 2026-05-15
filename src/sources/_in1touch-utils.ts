/**
 * in1touch (Internet Solutions Inc.) public-roster helper.
 *
 * in1touch (in1touch.org) is a SaaS for "Association, Regulatory and
 * Licensing Board Management Software" — many professional bodies use it
 * to host their public member register. Unlike Alinity/Thentia, the
 * platform is hosted on the regulator's own domain (e.g. saskpharm.ca,
 * abda.ca) rather than a `<tenant>.in1touch.org` subdomain. The footer
 * credits the platform: "Powered by in1touch".
 *
 * Shape (verified on saskpharm.ca 2026-05):
 *
 * 1. Shell page (e.g. `https://saskpharm.ca/site/find-a-pharmacist`)
 *    contains a `<form id="command" action="/client/roster/clientRosterView.html"
 *    method="post">`. Hidden inputs identify which roster to query:
 *        <input name="clientRosterId" value="484" />
 *        <input name="clientForm.subscriptionFilter.status" value="Active" />
 *        <input name="clientForm.subscriptionFilter.productIds" value="<membership-class-id>" />
 *        <input name="clientForm.subscriptionFilter.and" value="true" />
 *    plus filter fields like `clientForm.clientFilter.v[<fieldId>]` for
 *    First/Last/City. The field IDs are tenant-specific.
 *
 * 2. POSTing the same body (without filter values) to the action URL
 *    returns the first page of results. Pagination is `?page=N` and
 *    page size is fixed at 25 by the platform.
 *
 * 3. Results are rendered as `<div class="row registryBlock ...">` blocks
 *    inside `<div id="rosterRecords" data-roster="clientRoster-<id>">`.
 *    Each block has 5 `<div class="col-lg-{3,3,2,2,2}">` columns:
 *        Name | Membership Class | Effective | Expires | Details link
 *    The Details link is `/client/roster/clientRosterDetails.html?clientId=<N>&clientRosterId=<R>`.
 *
 * 4. Header `<span class="pagebanner">N Profiles found, displaying X to Y.</span>`
 *    exposes the total count; we use it to bound pagination.
 *
 * Rate limit: 1.5s between page fetches. 30s per-request timeout.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120 Safari/537.36 Prolio-Bot/1.0 (+contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 1500;
const MAX_PAGES = 400;

export interface In1touchRecord {
  /** Full display name "First Last". */
  name: string;
  /** Tenant-internal client id parsed from the Details link. */
  clientId?: string;
  /** Membership class / register (e.g. "Practising"). */
  status?: string;
  /** Effective date of current registration (raw string). */
  effective?: string;
  /** Expiry date of current registration (raw string). */
  expires?: string;
  /** Raw HTML block for debugging. */
  raw: Record<string, unknown>;
}

export interface FetchIn1touchOpts {
  /** Hard cap on records yielded. */
  limit?: number;
  /** Extra hidden inputs to send with the POST body. The defaults already
   * include `clientRosterId`, status=Active and the and-flag — override
   * here if a tenant needs different membership-class ids. */
  extraFields?: Record<string, string | string[]>;
  /** Max pages to walk. Default 400 (10k members at 25/page). */
  maxPages?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip HTML tags and collapse whitespace. */
function clean(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function buildBody(
  clientRosterId: string,
  page: number,
  extra: Record<string, string | string[]>,
): string {
  const parts: string[] = [];
  parts.push(`clientRosterId=${encodeURIComponent(clientRosterId)}`);
  parts.push(`page=${page}`);
  for (const [k, v] of Object.entries(extra)) {
    const values = Array.isArray(v) ? v : [v];
    for (const val of values) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`);
    }
  }
  return parts.join("&");
}

function parsePageBanner(html: string): number | null {
  // "1,996 Profiles found, displaying 1 to 25."
  const m = html.match(/([\d,]+)\s+Profiles?\s+found/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseRegistryBlocks(html: string): In1touchRecord[] {
  const out: In1touchRecord[] = [];
  // Each row of results.
  const blockRe =
    /<div\s+class="row\s+registryBlock[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<p>|<div\s+class="row\s+registryBlock|<\/div>|<div\s+class="row\s+py-3)/gi;
  const colRe = /<div\s+class="col-lg-[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  const clientIdRe = /clientId=(\d+)/i;

  for (const block of html.matchAll(blockRe)) {
    const body = block[1];
    const cols: string[] = [];
    colRe.lastIndex = 0;
    for (const c of body.matchAll(colRe)) cols.push(c[1]);
    if (cols.length < 1) continue;
    const name = clean(cols[0]);
    if (!name) continue;
    const status = cols[1] ? clean(cols[1]) : undefined;
    const effective = cols[2] ? clean(cols[2]) : undefined;
    const expires = cols[3] ? clean(cols[3]) : undefined;
    const detailsCol = cols[4] ?? "";
    const idMatch = detailsCol.match(clientIdRe);
    const clientId = idMatch ? idMatch[1] : undefined;
    out.push({
      name,
      clientId,
      status,
      effective,
      expires,
      raw: { html: body.slice(0, 1000) },
    });
  }
  return out;
}

async function fetchPage(
  searchUrl: string,
  body: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Iterate every registrant page of an in1touch roster.
 *
 * @param searchUrl Absolute URL of the roster POST endpoint
 *                  (typically `https://<host>/client/roster/clientRosterView.html`).
 * @param clientRosterId The tenant's roster id (read from a hidden
 *                  input on the shell page).
 * @param opts See {@link FetchIn1touchOpts}.
 */
export async function* fetchIn1touchRoster(
  searchUrl: string,
  clientRosterId: string,
  opts: FetchIn1touchOpts = {},
): AsyncIterableIterator<In1touchRecord> {
  const limit = opts.limit ?? 50_000;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const extra = opts.extraFields ?? {};

  let yielded = 0;
  let totalKnown: number | null = null;
  const seen = new Set<string>();

  for (let page = 1; page <= maxPages; page += 1) {
    if (yielded >= limit) return;
    const body = buildBody(clientRosterId, page, extra);
    const html = await fetchPage(searchUrl, body);
    if (html === null) {
      console.warn(
        `[in1touch] ${searchUrl} page=${page} fetch failed — stopping`,
      );
      return;
    }
    if (page === 1) totalKnown = parsePageBanner(html);
    const rows = parseRegistryBlocks(html);
    if (rows.length === 0) {
      if (page === 1) {
        console.warn(
          `[in1touch] ${searchUrl} returned no rows on page 1 — schema may have changed`,
        );
      }
      return;
    }
    for (const r of rows) {
      const key = r.clientId ?? `${r.name}|${r.effective ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      yielded += 1;
      yield r;
      if (yielded >= limit) return;
    }
    if (totalKnown !== null && yielded >= totalKnown) return;
    await delay(PAGE_DELAY_MS);
  }
}
