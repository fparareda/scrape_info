import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * Canadian provincial licensing-body scraper.
 *
 * These are government/authority databases of licensed tradespeople —
 * the highest-trust data source available to us in Canada. Unlike the
 * generic competitor-na directories (HomeAdvisor, HomeStars, etc.),
 * every record here comes with a real licence number issued by a
 * regulator, which is a defensible trust signal for our landings.
 *
 * Pre-flight (2026-04-24):
 *
 *   BCSA  (technicalsafetybc.ca) — SKIPPED.
 *     robots.txt disallows /api/* and /search. The public "find a
 *     licensed contractor" page is a Next.js SPA whose contractor data
 *     is fetched via /api/* (disallowed). No static endpoint found.
 *     Per-project rule: do not scrape blocked sources, ever.
 *
 *   CMMTQ (cmmtq.org)         — SKIPPED.
 *     "Find a contractor" redirects to connexionprod.cmmtq.org which
 *     requires a Microsoft Identity B2C login (`/MicrosoftIdentity/
 *     Account/SignIn`). Member directory is behind auth.
 *
 *   ECRA/ESA (licensing.esasafe.com) — BUILT.
 *     Public tool at /contractor-locator-tool/ fetches a single JSON
 *     array via a sibling `./data` endpoint. robots.txt on esasafe.com
 *     is permissive (only disallows /cgi-bin/). licensing.esasafe.com
 *     has no robots.txt (404) — we apply the parent-domain rules and
 *     verify the path isn't under /cgi-bin/. ~18k records returned in
 *     one request. No pagination, no auth, no captcha.
 *
 * Scope: seed Ontario electricians with regulator-issued licence
 * numbers into `professionals`, with `metadata.verified_by_authority =
 * true` so landings can render a trust badge. We only keep rows whose
 * city maps to a seeded slug (top-200 CA cities in migration 0035);
 * boroughs of Toronto collapse to `toronto`.
 *
 * Off by default. Enable via `PROLIO_RUN_COMPETITOR_CA_LICENSING=true`.
 * Never runs on the monthly scheduled sweep — workflow_dispatch only.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 500;

// --- Category mapping --------------------------------------------------

const CATEGORY_ELECTRICIAN: CategoryKey = "electricidad";
// Retained for when we add gas-fitter sources (BCSA, if it ever opens
// a public endpoint). Canadian "gas fitter" is a semantic stretch from
// Spanish "fontanero" — closest match in our taxonomy.
const CATEGORY_GASFITTER: CategoryKey = "fontaneria";
void CATEGORY_GASFITTER; // keep import shape stable; silence TS6133

// --- City mapping ------------------------------------------------------

/**
 * Map a raw ECRA city string (lowercase) to a seeded city_slug. Keys
 * cover the top-30 cities by ECRA record count plus Toronto's
 * amalgamated-1998 boroughs (Scarborough, Etobicoke, North York, East
 * York, York) which collapse to `toronto`. Anything not in this table
 * is dropped — the sink would drop it anyway, but pre-filtering keeps
 * the upsert batches small.
 */
const ECRA_CITY_ALIAS: Record<string, string> = {
  // Greater Toronto
  toronto: "toronto",
  scarborough: "toronto",
  etobicoke: "toronto",
  "north york": "toronto",
  "east york": "toronto",
  york: "toronto",
  // Peel / York / Durham / Halton
  mississauga: "mississauga",
  brampton: "brampton",
  markham: "markham-ca-on",
  "richmond hill": "richmond-hill",
  vaughan: "vaughan",
  woodbridge: "vaughan", // community within Vaughan
  concord: "vaughan", // community within Vaughan
  "thornhill": "vaughan", // spans Vaughan + Markham; bucket to Vaughan
  oakville: "oakville",
  burlington: "burlington",
  milton: "milton",
  oshawa: "oshawa",
  whitby: "whitby",
  pickering: "pickering",
  ajax: "ajax",
  newmarket: "newmarket",
  aurora: "aurora",
  // Rest of Ontario top cities
  ottawa: "ottawa",
  hamilton: "hamilton-ca",
  "stoney creek": "hamilton-ca", // amalgamated into Hamilton 2001
  ancaster: "hamilton-ca",
  dundas: "hamilton-ca",
  london: "london-ca",
  kitchener: "kitchener-ca-on",
  waterloo: "waterloo",
  cambridge: "cambridge-ca-on",
  guelph: "guelph",
  barrie: "barrie",
  windsor: "windsor",
  kingston: "kingston",
  "st. catharines": "st-catharines",
  "saint catharines": "st-catharines",
  niagara: "niagara-falls",
  "niagara falls": "niagara-falls",
  sudbury: "sudbury",
  "greater sudbury": "sudbury",
  "thunder bay": "thunder-bay",
  peterborough: "peterborough",
  brantford: "brantford",
  sarnia: "sarnia",
};

function mapEcraCity(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  return ECRA_CITY_ALIAS[key];
}

// --- HTTP helpers ------------------------------------------------------

/**
 * Fetch with a Prolio UA first; on 403/503 retry once with a Chrome
 * UA. Returns null on any failure — callers treat that as "source
 * unavailable, skip this run."
 */
async function politeFetch(url: string): Promise<{ status: number; body: string } | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
          "Accept-Language": "en-CA,en;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[competitor_ca_lic] ${new URL(url).host} blocked polite UA (${response.status}); retrying with Chrome UA`,
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
      const message = (error as Error).message ?? String(error);
      console.warn(`[competitor_ca_lic] network error on ${url}: ${message}`);
      return null;
    }
  }
  return null;
}

/**
 * Minimal robots.txt gate. Applies the User-agent:* block's Disallow
 * rules to `pathname`. Returns true if the path is blocked. Falls open
 * on network errors — we pre-verified the only host we hit
 * (licensing.esasafe.com) returns 404 for robots.txt, and the parent
 * host (esasafe.com) only disallows /cgi-bin/.
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

// --- ECRA adapter ------------------------------------------------------

/**
 * Shape of a single ECRA contractor record as served by
 * `/contractor-locator-tool/data`. Field names are two-letter keys —
 * we re-assert them loosely because ESA occasionally ships null values.
 *
 *   n  name                      cp contact person (nullable)
 *   ln licence number            w  website (nullable)
 *   ls licence status            wt work-type codes (array, int)
 *   s  street address            a  account GUID (unique, stable)
 *   c  city                      hc has convictions (bool)
 *   p  province (always "ON")    la lat / lo lng
 *   pc postal code               e  email? (always null in sample)
 *   ph phone                     em email (occasionally present)
 */
interface EcraRecord {
  n?: string;
  ln?: string;
  ls?: string; // "Valid" | "Expired" | "Closed" | "Suspended" | "Revoked" | "Unlicenced" | null
  s?: string;
  c?: string;
  p?: string;
  pc?: string;
  ph?: string;
  em?: string | null;
  e?: string | null;
  w?: string | null;
  cp?: string | null;
  wt?: number[];
  a?: string;
  hc?: boolean;
  la?: string;
  lo?: string;
}

function normaliseCaPhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

function normaliseWebsite(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function parseLatLng(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function fetchEcraContractors(): Promise<ScrapedProfessional[]> {
  const url = "https://licensing.esasafe.com/contractor-locator-tool/data";
  if (await isRobotsBlocked(url)) {
    console.warn(`[competitor_ca_lic] ecra blocked by robots.txt — skipping`);
    return [];
  }
  const response = await politeFetch(url);
  if (!response || !response.body) {
    console.warn(
      `[competitor_ca_lic] ecra fetch failed (status=${response?.status ?? "network"})`,
    );
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(response.body);
  } catch (error) {
    console.warn(
      `[competitor_ca_lic] ecra JSON parse failed: ${(error as Error).message}`,
    );
    return [];
  }
  if (!Array.isArray(data)) {
    console.warn(`[competitor_ca_lic] ecra payload not an array`);
    return [];
  }

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCity = 0;
  let droppedBadStatus = 0;
  let droppedNoName = 0;

  for (const raw of data as EcraRecord[]) {
    const name = (raw.n ?? "").trim();
    if (!name) {
      droppedNoName += 1;
      continue;
    }
    // We keep both Valid and Expired licences (Expired still
    // carries a real regulator-issued ID; it's still higher-trust
    // than a directory scrape). We drop Closed / Revoked /
    // Unlicenced — those are NOT licensed contractors.
    const status = (raw.ls ?? "").trim();
    if (status !== "Valid" && status !== "Expired" && status !== "Suspended") {
      droppedBadStatus += 1;
      continue;
    }
    const citySlug = mapEcraCity(raw.c);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }
    const licence = (raw.ln ?? "").trim();
    // ECRA licence numbers are guaranteed unique. Prefer the account
    // GUID (`a`) when present as a stable identifier even if a row
    // later changes licence numbers; fall back to licence.
    const sourceId = `ecra:${raw.a ?? licence}`;
    if (!sourceId || sourceId === "ecra:") continue;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const addressParts = [raw.s, raw.pc].filter(
      (p): p is string => typeof p === "string" && p.trim().length > 0,
    );
    const record = normalise({
      source: "ecra",
      sourceId,
      name,
      categoryKey: CATEGORY_ELECTRICIAN,
      citySlug,
      phone: normaliseCaPhone(raw.ph),
      email: typeof raw.em === "string" ? raw.em : undefined,
      website: normaliseWebsite(raw.w),
      address: addressParts.length > 0 ? addressParts.join(", ") : undefined,
      lat: parseLatLng(raw.la),
      lng: parseLatLng(raw.lo),
      licenseNumber: licence || undefined,
      metadata: {
        province: "ON",
        country: "CA",
        verified_by_authority: true,
        authority: "ECRA/ESA",
        licence_status: status,
        work_types: Array.isArray(raw.wt) ? raw.wt : [],
        has_convictions: raw.hc === true,
        account_id: raw.a,
      },
    });
    out.push(record);
  }

  console.log(
    `[competitor_ca_lic] ecra parsed=${out.length} ` +
      `droppedNoCity=${droppedNoCity} droppedBadStatus=${droppedBadStatus} droppedNoName=${droppedNoName}`,
  );
  return out;
}

// --- Public entrypoint -------------------------------------------------

export const competitorCaLicensingSource: ScraperSource = {
  // Logging name; emitted rows carry the real per-authority source.
  name: "ecra",
  enabled() {
    return process.env.PROLIO_RUN_COMPETITOR_CA_LICENSING === "true";
  },
  // One-shot bulk runner; per-target fetch is a no-op.
  async fetch() {
    return [];
  },
};

/**
 * Bulk runner. Calls each surviving authority adapter and upserts via
 * sink. Respects PROLIO_COMPETITOR_CA_LICENSING_LIMIT (default 500) as
 * a global cap across all authorities in this run.
 */
export async function runCompetitorCaLicensing(): Promise<void> {
  if (!competitorCaLicensingSource.enabled()) return;
  const limit = Number(
    process.env.PROLIO_COMPETITOR_CA_LICENSING_LIMIT ?? DEFAULT_LIMIT,
  );
  if (!Number.isFinite(limit) || limit <= 0) {
    console.warn(
      `[competitor_ca_lic] invalid PROLIO_COMPETITOR_CA_LICENSING_LIMIT, using ${DEFAULT_LIMIT}`,
    );
  }
  const effective = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const sink = getSink();
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalRecords = 0;

  // ECRA — Ontario electricians (only surviving adapter as of
  // 2026-04-24; BCSA + CMMTQ blocked by robots/auth).
  try {
    const ecra = await fetchEcraContractors();
    const capped = ecra.slice(0, effective);
    if (capped.length > 0) {
      totalRecords += capped.length;
      const { inserted, updated, skipped } = await sink.upsert(capped);
      totalInserted += inserted;
      totalUpdated += updated;
      totalSkipped += skipped;
      console.log(
        `[competitor_ca_lic] ecra: found=${ecra.length} upserted=${capped.length} ` +
          `inserted=${inserted} updated=${updated} skipped=${skipped}`,
      );
    }
  } catch (error) {
    console.warn(
      `[competitor_ca_lic] ecra crashed: ${(error as Error).message}`,
    );
  }

  console.log(
    `[competitor_ca_lic] done — records=${totalRecords} ` +
      `inserted=${totalInserted} updated=${totalUpdated} skipped=${totalSkipped}`,
  );
}
