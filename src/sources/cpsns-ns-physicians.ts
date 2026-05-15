import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";

/**
 * CPSNS — College of Physicians and Surgeons of Nova Scotia.
 *
 * Public search at https://cpsnsphysiciansearch.azurewebsites.net/
 * The home page is an ASP.NET WebForms shell exposing one form with
 * hidden __VIEWSTATE / __VIEWSTATEGENERATOR / __EVENTVALIDATION
 * tokens. Submitting an empty form (POST → /SearchResults.aspx)
 * returns the full registrant list in a single `#grid-basic` table
 * (~6,700 physicians as of 2026-05). No CAPTCHA, no pagination, no
 * JS rendering — pure server-side render.
 *
 * Each result row looks like:
 *   <tr>
 *     <td>
 *       <a href="/PhysicianDetails.aspx?LicenceNumber=014392">Abazid, Nizar</a>&nbsp;&nbsp;MD<br/>
 *       Specialty:&nbsp;...&nbsp;Neonatal-Perinatal Medicine<br/>
 *       Practice Location:&nbsp;...&nbsp;Sydney <br/>
 *       Zone:&nbsp;...&nbsp;Eastern Zone <br/>
 *     </td>
 *   </tr>
 *
 * Strategy: GET home page → extract VIEWSTATE tokens → POST empty
 * search → regex-parse the result table. Each registrant is uniquely
 * identified by `LicenceNumber`. Only `halifax` is seeded as an NS
 * city; other practice locations fall back to halifax (the regulator
 * is province-wide and the slug is the closest seeded bucket — the
 * raw practice location is preserved in metadata.practice_location).
 *
 * Category: `medicina`. Off by default; `PROLIO_RUN_CPSNS_NS_PHYSICIANS=true`.
 * Cap via `PROLIO_CPSNS_NS_PHYSICIANS_LIMIT` (default 8000 — full roster
 * is ~6.7k).
 */

const BASE = "https://cpsnsphysiciansearch.azurewebsites.net";
const HOME_URL = `${BASE}/`;
const SEARCH_URL = `${BASE}/SearchResults.aspx`;
const AUTHORITY = "CPSNS";
const PROVINCE = "NS";
const CATEGORY: CategoryKey = "medicina";
const DEFAULT_CITY = "halifax";
const DEFAULT_LIMIT = 8000;
const REQUEST_TIMEOUT_MS = 90_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const NS_CITY_MAP: Record<string, string> = {
  halifax: "halifax",
  // Everything else in NS (Sydney, Dartmouth, Truro, …) collapses to
  // halifax — Prolio only seeds Halifax as the NS bucket.
};

export const cpsnsNsPhysiciansSource: ScraperSource = {
  name: "cpsns-ns-physicians" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CPSNS_NS_PHYSICIANS === "true";
  },
  async fetch() {
    return [];
  },
};

interface CpsnsRow {
  licenceNumber: string;
  rawName: string;
  designation: string;
  specialty?: string;
  practiceLocation?: string;
  zone?: string;
  phone?: string;
}

function extractHidden(html: string, fieldId: string): string | null {
  const re = new RegExp(
    `name="${fieldId}"[^>]*id="${fieldId}"[^>]*value="([^"]*)"`,
    "i",
  );
  const m = html.match(re);
  if (m) return m[1];
  // Try reversed attribute order.
  const re2 = new RegExp(
    `id="${fieldId}"[^>]*name="${fieldId}"[^>]*value="([^"]*)"`,
    "i",
  );
  const m2 = html.match(re2);
  return m2 ? m2[1] : null;
}

async function fetchHome(): Promise<{
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
  cookie: string;
} | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(HOME_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[cpsns-ns-physicians] home HTTP ${response.status}`);
      return null;
    }
    const html = await response.text();
    const vs = extractHidden(html, "__VIEWSTATE");
    const vsg = extractHidden(html, "__VIEWSTATEGENERATOR");
    const ev = extractHidden(html, "__EVENTVALIDATION");
    if (!vs || !vsg || !ev) {
      console.warn(`[cpsns-ns-physicians] missing VIEWSTATE tokens on home page`);
      return null;
    }
    const cookie = response.headers.get("set-cookie") || "";
    // ASP.NET only sets a single ASP.NET_SessionId — strip path/expires.
    const cookieStr = cookie
      .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
      .map((c) => c.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
    return {
      viewState: vs,
      viewStateGenerator: vsg,
      eventValidation: ev,
      cookie: cookieStr,
    };
  } catch (e) {
    console.warn(`[cpsns-ns-physicians] home fetch failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchResults(tokens: {
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
  cookie: string;
}): Promise<string | null> {
  const body = new URLSearchParams();
  body.set("__VIEWSTATE", tokens.viewState);
  body.set("__VIEWSTATEGENERATOR", tokens.viewStateGenerator);
  body.set("__EVENTVALIDATION", tokens.eventValidation);
  body.set("firstname", "");
  body.set("lastname", "");
  body.set("previousname", "");
  body.set("ctl00$MainContent$location", "");
  body.set("ctl00$MainContent$btnSearch", "Search");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: HOME_URL,
    };
    if (tokens.cookie) headers.Cookie = tokens.cookie;
    const response = await fetch(SEARCH_URL, {
      method: "POST",
      headers,
      body: body.toString(),
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[cpsns-ns-physicians] search HTTP ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (e) {
    console.warn(`[cpsns-ns-physicians] search fetch failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseRows(html: string): CpsnsRow[] {
  const out: CpsnsRow[] = [];
  // Each row: <tr> <td><a href="/PhysicianDetails.aspx?LicenceNumber=NNN">Name, …</a>&nbsp;&nbsp;DESIGNATION<br/>… </td></tr>
  const re =
    /<a\s+href="\/PhysicianDetails\.aspx\?LicenceNumber=([0-9]+)"[^>]*>([^<]+)<\/a>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const licenceNumber = m[1];
    const rawName = m[2].trim();
    const tail = m[3];
    // Split tail into pseudo-fields by <br/>.
    const segs = tail
      .replace(/&nbsp;/g, " ")
      .split(/<br\s*\/?>/i)
      .map((s) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const row: CpsnsRow = {
      licenceNumber,
      rawName,
      designation: segs[0] ?? "",
    };
    for (const seg of segs.slice(1)) {
      const colon = seg.indexOf(":");
      if (colon < 0) continue;
      const key = seg.slice(0, colon).trim().toLowerCase();
      const value = seg.slice(colon + 1).trim();
      if (!value) continue;
      if (key.startsWith("specialty")) row.specialty = value;
      else if (key.startsWith("practice location")) row.practiceLocation = value;
      else if (key.startsWith("zone")) row.zone = value;
      else if (key.startsWith("phone")) row.phone = value;
    }
    out.push(row);
  }
  return out;
}

function buildName(rawName: string): string {
  // "Aali, Maral" → "Maral Aali". Some rows are "Last, First M." — best effort.
  const idx = rawName.indexOf(",");
  if (idx < 0) return toTitleCase(rawName.trim());
  const last = rawName.slice(0, idx).trim();
  const first = rawName.slice(idx + 1).trim();
  return toTitleCase([first, last].filter(Boolean).join(" "));
}

function mapCity(raw: string | undefined): string {
  if (!raw) return DEFAULT_CITY;
  const k = raw.toLowerCase().trim();
  return NS_CITY_MAP[k] ?? DEFAULT_CITY;
}

function toRecord(row: CpsnsRow): ScrapedProfessional | null {
  const name = buildName(row.rawName);
  if (!name) return null;
  return normalise({
    source: "cpsns-ns-physicians" as ScrapeSource,
    sourceId: `cpsns-ns-physicians:${row.licenceNumber}`,
    name,
    categoryKey: CATEGORY,
    citySlug: mapCity(row.practiceLocation),
    phone: row.phone,
    licenseNumber: row.licenceNumber,
    metadata: {
      country: "CA",
      province: PROVINCE,
      authority: AUTHORITY,
      verified_by_authority: true,
      designation: row.designation || null,
      specialty: row.specialty ?? null,
      practice_location: row.practiceLocation ?? null,
      zone: row.zone ?? null,
    },
  });
}

export async function runCpsnsNsPhysicians(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cpsnsNsPhysiciansSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_CPSNS_NS_PHYSICIANS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const tokens = await fetchHome();
  if (!tokens) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const resultsHtml = await fetchResults(tokens);
  if (!resultsHtml) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rows = parseRows(resultsHtml);
  console.log(`[cpsns-ns-physicians] parsed ${rows.length} rows from results page`);

  const seen = new Set<string>();
  const records: ScrapedProfessional[] = [];
  for (const row of rows) {
    if (records.length >= cap) break;
    const rec = toRecord(row);
    if (!rec) continue;
    if (seen.has(rec.sourceId)) continue;
    seen.add(rec.sourceId);
    records.push(rec);
  }
  if (records.length === 0) {
    console.warn(`[cpsns-ns-physicians] no rows — search page structure may have changed`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cpsns-ns-physicians] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
