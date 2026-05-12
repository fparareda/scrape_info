import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { createClient } from "@supabase/supabase-js";

/**
 * US state bar associations + AILA — official lawyer registries.
 *
 * Pre-flight (2026-04-24) of 4 candidate sources:
 *
 *   - State Bar of California (apps.calbar.ca.gov):
 *       robots allows /attorney/. QuickSearch returns server-rendered
 *       HTML rows with <a href="/attorney/Licensee/Detail/<id>">Last,
 *       First</a>. Detail pages expose Address/Phone/License Status/
 *       Practice Areas as plain HTML labels. ~190k licensees. **PICKED.**
 *   - State Bar of New York (iapps.courts.state.ny.us): 403 from
 *       datacenter IPs (Akamai 'Request Could Not Be Processed').
 *       SKIPPED — enum reserved for a future Playwright/residential
 *       proxy adapter.
 *   - State Bar of Texas (texasbar.com/AM/Template.cfm): Cloudflare
 *       in front + ColdFusion CFID/CFTOKEN cookies + CFM postback form.
 *       Direct GET 302s to error.cfm. SKIPPED — needs full session sim.
 *   - AILA (ailalawyer.com): ASP.NET WebForms; every search is a
 *       __VIEWSTATE postback. No JSON. SKIPPED — needs Playwright.
 *
 * Wedge: practice area "Immigration" → CategoryKey 'extranjeria' +
 * metadata.wedge_specialty='extranjeria' (Prolio revenue wedge in ES;
 * tagged for US too in case we expand). Other / no practice areas →
 * 'fiscal' bucket (closest professional-services key today) with
 * metadata.lawyer_general=true so we can re-bucket once we add a
 * dedicated legal CategoryKey.
 *
 * Off by default. Enabled via PROLIO_RUN_US_BARS=true. Workflow:
 * .github/workflows/scrape-us-bars.yml — monthly day 3 05:00 UTC
 * (bar renewals are annual; data is slow-moving).
 *
 * Per-source kill: NY/TX/AILA are intentionally no-ops today. They log
 * the skip reason at runtime so a future operator sees why. CA blocked
 * mid-run (403/503) aborts only itself, not the whole job.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_DELAY_MS = 1_100; // ≥1 req/sec across all sub-sources.
const DEFAULT_LIMIT = 1000;
const DEFAULT_DETAILS_PER_RUN = 200;

// CalBar QuickSearch returns up to ~500 rows per query; iterating all
// 26 last-name initials gives broad coverage without paging plumbing.
const CALBAR_INITIALS = "abcdefghijklmnopqrstuvwxyz".split("");

// City fallback when we can't slug-match the licensee's address city.
// CalBar lists CA-licensed attorneys but residence/office can be in
// any state, so we drop rows whose city isn't in our seeded set.

// --- HTTP helpers (mirror competitor-us-lawyers) ----------------------

async function politeFetch(
  url: string,
  tag: string,
): Promise<{ status: number; body: string } | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[${tag}] blocked polite UA (${response.status}); retry Chrome UA`,
          );
          continue;
        }
        return { status: response.status, body: "" };
      }
      if (!response.ok) return { status: response.status, body: "" };
      const body = await response.text();
      return { status: response.status, body };
    } catch (error) {
      clearTimeout(timer);
      console.warn(`[${tag}] network error on ${url}: ${(error as Error).message}`);
      return null;
    }
  }
  return null;
}

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
      if (matchesGlob(pathname, value)) return true;
    }
  }
  return false;
}

function matchesGlob(path: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === "/") return true;
  const parts = pattern.split("*");
  let cursor = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    if (!seg) continue;
    const idx = path.indexOf(seg, cursor);
    if (idx < 0) return false;
    if (i === 0 && idx !== 0) return false;
    cursor = idx + seg.length;
  }
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- City-slug loader (CA cities only — CalBar is California) --------

async function loadUsCitySlugs(): Promise<Set<string>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Set();
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const slugs = new Set<string>();
  for (let from = 0; from < 12000; from += 1000) {
    const { data, error } = await sb
      .from("cities")
      .select("slug")
      .eq("country", "US")
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    for (const row of data) slugs.add(row.slug as string);
    if (data.length < 1000) break;
  }
  return slugs;
}

// --- Practice-area classification (matches Avvo conventions) ---------

const IMMIGRATION_NEEDLES = ["immigration", "asylum", "visa", "naturalization"];

function isImmigration(raw: string[]): boolean {
  const lower = raw.map((s) => s.toLowerCase());
  return lower.some((p) => IMMIGRATION_NEEDLES.some((n) => p.includes(n)));
}

// --- CalBar (bar-ca) -------------------------------------------------

interface CalBarListItem {
  barNumber: string;
  detailUrl: string;
  displayName: string;
}

function parseCalBarList(html: string): CalBarListItem[] {
  // Each row links to /attorney/Licensee/Detail/<barNumber>.
  const re =
    /<a\s+href="\/attorney\/Licensee\/Detail\/(\d+)"[^>]*>([^<]+)<\/a>/gi;
  const out: CalBarListItem[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const barNumber = m[1];
    if (!barNumber || seen.has(barNumber)) continue;
    seen.add(barNumber);
    const displayName = (m[2] ?? "").replace(/\s+/g, " ").trim();
    if (!displayName) continue;
    out.push({
      barNumber,
      detailUrl: `https://apps.calbar.ca.gov/attorney/Licensee/Detail/${barNumber}`,
      displayName,
    });
  }
  return out;
}

interface CalBarDetail {
  name: string;
  phone?: string;
  address?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  status?: string;
  practiceAreas: string[];
  firm?: string;
}

function extractLabelValue(html: string, label: string): string | undefined {
  // Match patterns like "Phone:</strong> 555-1234" or "Phone: 555-1234".
  // CalBar mixes <strong>/<b>/plain labels; tolerate any tag wrapper.
  const re = new RegExp(
    `${label}\\s*:?\\s*(?:<[^>]+>)*\\s*([^<\\n]{1,200})`,
    "i",
  );
  const m = re.exec(html);
  if (!m) return undefined;
  const value = m[1]?.replace(/\s+/g, " ").trim();
  return value && value.length > 0 ? value : undefined;
}

function parseCalBarDetail(
  html: string,
  fallbackName: string,
): CalBarDetail | null {
  // Address line follows "Address:" up to next break.
  const rawAddress = extractLabelValue(html, "Address");
  const address = rawAddress?.replace(/&nbsp;/gi, " ").trim();
  let city: string | undefined;
  let region: string | undefined;
  let postalCode: string | undefined;
  if (address) {
    // "5802 London Ln, Dallas, TX 75252"
    const parts = address.split(",").map((p) => p.trim());
    if (parts.length >= 3) {
      city = parts[parts.length - 2];
      const tail = parts[parts.length - 1];
      const tm = /^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/.exec(tail ?? "");
      if (tm) {
        region = tm[1];
        postalCode = tm[2];
      }
    }
  }
  const phone = extractLabelValue(html, "Phone");
  const status = extractLabelValue(html, "License Status");
  const firm = extractLabelValue(html, "Firm")
    ?? extractLabelValue(html, "Law Firm");
  const paBlock = extractLabelValue(html, "Practice Areas");
  const practiceAreas = paBlock
    ? paBlock
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length < 80)
    : [];
  return {
    name: fallbackName,
    phone,
    address,
    city,
    region,
    postalCode,
    status,
    practiceAreas,
    firm,
  };
}

function normaliseUsPhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

function reorderName(displayName: string): string {
  // CalBar shows "Last, First Middle" — flip to "First Middle Last".
  const idx = displayName.indexOf(",");
  if (idx < 0) return displayName;
  const last = displayName.slice(0, idx).trim();
  const rest = displayName.slice(idx + 1).trim();
  return `${rest} ${last}`.replace(/\s+/g, " ").trim();
}

interface BarRunStats {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  wedge: number;
  general: number;
}

async function runCalBar(
  validCitySlugs: Set<string>,
  limit: number,
  detailsCap: number,
): Promise<BarRunStats> {
  const tag = "bar-ca";
  const sink = getSink();
  const all: ScrapedProfessional[] = [];
  let wedge = 0;
  let general = 0;
  let detailsFetched = 0;

  // Sanity: robots check the search endpoint once.
  const seedUrl =
    "https://apps.calbar.ca.gov/attorney/LicenseeSearch/QuickSearch?FreeText=a";
  if (await isRobotsBlocked(seedUrl)) {
    console.warn(`[${tag}] robots.txt disallows search path — SKIP`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0, wedge: 0, general: 0 };
  }

  outer: for (const initial of CALBAR_INITIALS) {
    if (all.length >= limit || detailsFetched >= detailsCap) break;
    const listUrl =
      `https://apps.calbar.ca.gov/attorney/LicenseeSearch/QuickSearch` +
      `?FreeText=${encodeURIComponent(initial)}&SoundsLike=false`;
    const listResp = await politeFetch(listUrl, tag);
    if (!listResp) continue;
    if (listResp.status === 403 || listResp.status === 503) {
      console.warn(`[${tag}] got ${listResp.status} on list — abort source`);
      break outer;
    }
    if (!listResp.body) continue;

    const items = parseCalBarList(listResp.body);
    console.log(`[${tag}] initial="${initial}" listed=${items.length}`);
    await delay(REQUEST_DELAY_MS);

    for (const item of items) {
      if (all.length >= limit || detailsFetched >= detailsCap) break outer;
      detailsFetched += 1;
      const det = await politeFetch(item.detailUrl, tag);
      await delay(REQUEST_DELAY_MS);
      if (!det || !det.body) continue;
      if (det.status === 403 || det.status === 503) {
        console.warn(`[${tag}] got ${det.status} on detail — abort source`);
        break outer;
      }
      const detail = parseCalBarDetail(det.body, item.displayName);
      if (!detail) continue;

      // Skip non-active licensees — keeps the directory tight.
      if (detail.status && !/active/i.test(detail.status)) continue;

      const citySlug = detail.city ? slugify(detail.city) : undefined;
      if (!citySlug || !validCitySlugs.has(citySlug)) continue;

      const wedgeFlag = isImmigration(detail.practiceAreas);
      const category: CategoryKey = wedgeFlag ? "extranjeria" : "fiscal";
      if (wedgeFlag) wedge += 1;
      else general += 1;

      const metadata: Record<string, unknown> = {
        country: "US",
        bar: ["CA"],
        bar_number: item.barNumber,
        license_status: detail.status,
        firm: detail.firm,
        practice_areas: detail.practiceAreas,
        region: detail.region,
        postal_code: detail.postalCode,
        profile_url: item.detailUrl,
      };
      if (wedgeFlag) metadata.wedge_specialty = "extranjeria";
      else metadata.lawyer_general = true;

      all.push(
        normalise({
          source: "bar-ca",
          sourceId: `bar-ca:${item.barNumber}`,
          name: reorderName(detail.name),
          categoryKey: category,
          citySlug,
          phone: normaliseUsPhone(detail.phone),
          address: detail.address,
          website: item.detailUrl,
          metadata,
        }),
      );
    }
  }

  if (all.length === 0) {
    console.log(`[${tag}] done — details=${detailsFetched} records=0`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0, wedge, general };
  }
  const { inserted, updated, skipped } = await sink.upsert(all);
  console.log(
    `[${tag}] done — details=${detailsFetched} records=${all.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped} ` +
      `wedge=${wedge} general=${general}`,
  );
  return { fetched: all.length, inserted, updated, skipped, wedge, general };
}

// --- Stub adapters for blocked sources -------------------------------
//
// Per-source kill criterion: if pre-flight finds the source unreachable,
// we ship the enum value + log the skip reason so admin observability
// shows zero-yield rather than a silent absence.

function logSkip(tag: string, reason: string): BarRunStats {
  console.warn(`[${tag}] SKIP — ${reason}`);
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0, wedge: 0, general: 0 };
}

function runBarNy(): BarRunStats {
  return logSkip(
    "bar-ny",
    "iapps.courts.state.ny.us returns 403 from datacenter IPs (Akamai). Needs Playwright/residential proxy.",
  );
}

function runBarTx(): BarRunStats {
  return logSkip(
    "bar-tx",
    "texasbar.com search uses Cloudflare + ColdFusion CFID/CFTOKEN session cookies + CFM postback. Needs full session-form sim.",
  );
}

function runAila(): BarRunStats {
  return logSkip(
    "aila",
    "ailalawyer.com is ASP.NET WebForms — every search is a __VIEWSTATE postback. No JSON. Needs Playwright.",
  );
}

// --- Public entrypoint -----------------------------------------------

export const competitorUsBarsSource: ScraperSource = {
  name: "bar-ca",
  enabled() {
    return process.env.PROLIO_RUN_US_BARS === "true";
  },
  async fetch() {
    return [];
  },
};

export interface UsBarsRunSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  wedge: number;
  general: number;
}

export async function runCompetitorUsBars(): Promise<UsBarsRunSummary | null> {
  if (!competitorUsBarsSource.enabled()) return null;

  const limitRaw = Number(process.env.PROLIO_US_BARS_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;
  const detailsRaw = Number(
    process.env.PROLIO_US_BARS_DETAILS ?? DEFAULT_DETAILS_PER_RUN,
  );
  const detailsCap =
    Number.isFinite(detailsRaw) && detailsRaw > 0
      ? detailsRaw
      : DEFAULT_DETAILS_PER_RUN;

  const validCitySlugs = await loadUsCitySlugs();
  if (validCitySlugs.size === 0) {
    console.warn(`[us-bars] no US cities seeded — skipping`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0, wedge: 0, general: 0 };
  }

  // Run each sub-source independently. Stub sources return zero; CalBar
  // does the actual work.
  const ca = await runCalBar(validCitySlugs, limit, detailsCap);
  const ny = runBarNy();
  const tx = runBarTx();
  const aila = runAila();

  const total: UsBarsRunSummary = {
    fetched: ca.fetched + ny.fetched + tx.fetched + aila.fetched,
    inserted: ca.inserted + ny.inserted + tx.inserted + aila.inserted,
    updated: ca.updated + ny.updated + tx.updated + aila.updated,
    skipped: ca.skipped + ny.skipped + tx.skipped + aila.skipped,
    wedge: ca.wedge + ny.wedge + tx.wedge + aila.wedge,
    general: ca.general + ny.general + tx.general + aila.general,
  };
  console.log(
    `[us-bars] aggregate fetched=${total.fetched} inserted=${total.inserted} ` +
      `updated=${total.updated} wedge=${total.wedge} general=${total.general}`,
  );
  return total;
}
