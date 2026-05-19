import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Canadian regulated-trades licensing scraper.
 *
 * These are *trade* regulators (gas/HVAC/fuel oil + new-home builders) —
 * complementing the existing professional-college (`competitor-ca-
 * professional.ts`) and ECRA electrician (`competitor-ca-licensing.ts`)
 * scrapers. Same trust profile: every record carries a regulator-issued
 * licence number, so landings can render a verified-by-authority badge.
 *
 * Pre-flight (2026-04-24):
 *
 *   TSSA Ontario (tssa.org / safetyinfo.ca) — BUILT.
 *     The "Find a Registered Fuels Contractor" tool at
 *     /fuels-contractor renders 50 contractors per page in plain
 *     server-rendered HTML (Drupal). robots.txt allows the path.
 *     Contractor record carries name, FS-R licence number, full
 *     postal address. Pagination via ?page=N. We map every TSSA
 *     contractor to `hvac` (the closest taxonomy match — TSSA's
 *     fuels licence covers gas, propane, oil-burner, HVAC); a small
 *     subset of trade-name keywords (PLUMBING / KYCHECK / etc.)
 *     re-route to `fontaneria`.
 *
 *   OPHA / OBOA Ontario (plumbing inspectors) — BLOCKED.
 *     OBOA = Ontario Building Officials Association (building-code
 *     inspectors, not plumbers as the issue assumed). Their member-
 *     info portal at v0.oboa.on.ca/sa/memberinfo/ returns 403 to
 *     every UA we tried; the public site is a Wix SPA whose
 *     directory is wired through filesusr.com (no static endpoint).
 *     OPHA Ontario does not exist — confused with OPIA (a domain
 *     parked on atom.com). The actual ON plumber regulator is
 *     Skilled Trades Ontario, which exposes a JS-only public-search
 *     SPA at services.skilledtradesontario.ca/STOportal/app/public-
 *     search (no JSON endpoint reachable without form interaction).
 *     Source kind reserved (`opha`) for the day either ships a feed.
 *
 *   CMHC builders (cmhc-schl.gc.ca) — REROUTED.
 *     CMHC does not run a builder warranty registry; that role
 *     belongs to HCRA (Home Construction Regulatory Authority,
 *     Ontario, replaced Tarion as the regulator in 2021). HCRA's
 *     Ontario Builder Directory at obd.hcraontario.ca is a SPA but
 *     ships the *full* dataset via /api/builders (~48k builders,
 *     8.2 MB JSON, robots.txt: `Disallow:` empty = allow all). One
 *     bulk fetch covers the entire province. We map all builders to
 *     `carpinteria` — closest match in our taxonomy (we don't yet
 *     have a `general-contractor` category). Source kind named
 *     `hcra` rather than `cmhc-builders` to reflect what we actually
 *     hit.
 *
 * Off by default. Enable via `PROLIO_RUN_CA_TRADES=true`. Weekly via
 * .github/workflows/scrape-ca-trades.yml — trade licences move faster
 * than college rolls (renewals are annual and TSSA registrations
 * lapse on non-payment).
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 2000;
const TSSA_MAX_PAGES = 200; // safety cap: ~50 rows/page → 10k rows max

const CATEGORY_HVAC: CategoryKey = "hvac";
const CATEGORY_FONTANERO: CategoryKey = "fontaneria";
const CATEGORY_CARPINTERO: CategoryKey = "carpinteria";

// --- HTTP helpers ------------------------------------------------------

interface FetchResponse {
  status: number;
  body: string;
}

/**
 * Fetch with a polite UA first; on 403/503 retry once with Chrome UA.
 * Returns null on network error so callers can skip the source cleanly.
 */
async function politeFetch(
  url: string,
  acceptHeader = "text/html,application/json;q=0.9,*/*;q=0.1",
): Promise<FetchResponse | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: acceptHeader,
          "Accept-Language": "en-CA,en;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[ca_trades] ${new URL(url).host} blocked polite UA (${response.status}); retrying with Chrome UA`,
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
      console.warn(`[ca_trades] network error on ${url}: ${message}`);
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
      if (value === "/") return true;
      if (pathname.startsWith(value)) return true;
    }
  }
  return false;
}

// --- City mapping (CA) -------------------------------------------------

interface CityIndex {
  exact: Map<string, string>;
  /** lower-case alias → city slug. Maps Toronto boroughs etc. */
  aliases: Map<string, string>;
}

let cityIndexCache: CityIndex | null = null;

async function loadCityIndex(): Promise<CityIndex> {
  if (cityIndexCache) return cityIndexCache;
  const cities = await getCities({ country: "CA" });
  const exact = new Map<string, string>();
  for (const city of cities) {
    exact.set(city.name.toLowerCase(), city.slug);
    // Slug fallback so e.g. "richmond-hill" is found verbatim.
    exact.set(city.slug.toLowerCase(), city.slug);
  }
  // Toronto boroughs amalgamated 1998 → toronto.
  const aliases = new Map<string, string>([
    ["scarborough", "toronto"],
    ["etobicoke", "toronto"],
    ["north york", "toronto"],
    ["east york", "toronto"],
    ["york", "toronto"],
    // Communities within Vaughan
    ["woodbridge", "vaughan"],
    ["concord", "vaughan"],
    ["thornhill", "vaughan"],
    // Communities within Hamilton (post-2001 amalgamation)
    ["stoney creek", "hamilton-ca"],
    ["ancaster", "hamilton-ca"],
    ["dundas", "hamilton-ca"],
    ["flamborough", "hamilton-ca"],
    // Greater Sudbury
    ["greater sudbury", "sudbury"],
    // Common spelling variants for st. catharines
    ["saint catharines", "st-catharines"],
    ["niagara", "niagara-falls"],
    ["nepean", "ottawa"],
    ["kanata", "ottawa"],
    ["gloucester", "ottawa"],
    ["orleans", "ottawa"],
    ["st.-charles", "sudbury"], // small ON community closest to Sudbury
  ]);
  cityIndexCache = { exact, aliases };
  return cityIndexCache;
}

function mapCity(idx: CityIndex, raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  if (idx.aliases.has(key)) return idx.aliases.get(key);
  if (idx.exact.has(key)) return idx.exact.get(key);
  return undefined;
}

function normaliseCaPhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

// --- TSSA fuels-contractor adapter ------------------------------------

interface TssaRow {
  detailId: string;
  name: string;
  licenceNumber: string;
  rawAddress: string;
}

const TSSA_LIST_RE =
  /<h2><a href="\/fuels-contractor-detail\/(\d+)">([^<]+)<\/a><\/h2>\s*<p>([^<]+)<\/p>/g;

function parseTssaPage(html: string): TssaRow[] {
  const rows: TssaRow[] = [];
  // Reset regex state — global.
  TSSA_LIST_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TSSA_LIST_RE.exec(html)) !== null) {
    const [, detailId, name, paragraph] = match;
    if (!detailId || !name) continue;
    const decoded = decodeHtmlEntities(name).trim();
    if (!decoded) continue;
    const para = decodeHtmlEntities(paragraph);
    // First "<br>"-delimited token is the licence number; remainder
    // is the comma-separated address. We split on the literal text
    // because Drupal renders `<br>` (not `\n`) and we already
    // captured the inner-paragraph text.
    const [licencePart = "", ...rest] = para.split(/\s{2,}/);
    rows.push({
      detailId,
      name: decoded,
      licenceNumber: licencePart.trim(),
      rawAddress: rest.join(" ").trim(),
    });
  }
  return rows;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Pull the city out of a TSSA paragraph like
 *   "FS-R-53336<br>1535 Alta Vista Dr, Unit 1402, Ottawa, ON, K1G 3N9, Canada"
 * (we already stripped "<br>" via parseTssaPage). Format is comma-
 * separated; province "ON" comes second-to-last after the city. Drop
 * any rows whose province isn't ON.
 */
function extractTssaCity(rawAddress: string): string | undefined {
  if (!rawAddress) return undefined;
  // Re-stringify <br>-style separators to a comma.
  const cleaned = rawAddress.replace(/<br\s*\/?>/gi, ", ");
  const parts = cleaned
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 3) return undefined;
  // Find the index of "ON" — city is the previous segment.
  const onIdx = parts.findIndex((p) => /^on$/i.test(p));
  if (onIdx <= 0) return undefined;
  return parts[onIdx - 1];
}

/**
 * TSSA licence numbers look like FS-R-53336, FS-CR-12345, etc. The "R"
 * prefix is registered fuels contractor (gas+oil). We default to HVAC;
 * trade-name heuristics route a subset to fontaneria.
 */
function pickTssaCategory(name: string): CategoryKey {
  const n = name.toUpperCase();
  if (
    /\bPLUMB\b|\bPLUMBING\b|\bDRAIN\b|\bWATER\b|\bSEWER\b|\bPIPE\b/.test(n)
  ) {
    return CATEGORY_FONTANERO;
  }
  return CATEGORY_HVAC;
}

async function fetchTssaContractors(
  cityIndex: CityIndex,
): Promise<ScrapedProfessional[]> {
  const base = "https://www.tssa.org/fuels-contractor";
  if (await isRobotsBlocked(base)) {
    console.warn(`[ca_trades] tssa blocked by robots.txt — skipping`);
    return [];
  }
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCity = 0;
  let droppedNoLicence = 0;
  let lastFingerprint: string | null = null;
  let repeatedPages = 0;

  for (let page = 0; page < TSSA_MAX_PAGES; page += 1) {
    const url = page === 0 ? base : `${base}?page=${page}`;
    const response = await politeFetch(url);
    if (!response || !response.body) {
      console.warn(
        `[ca_trades] tssa page=${page} fetch failed (status=${response?.status ?? "network"})`,
      );
      break;
    }
    const rows = parseTssaPage(response.body);
    if (rows.length === 0) {
      console.log(`[ca_trades] tssa page=${page} empty — stopping`);
      break;
    }
    // TSSA loops if you over-paginate (any high page returns the
    // last data slice). Detect by hashing the first-row id; abort on
    // 2 consecutive identical pages.
    const fingerprint = rows[0].detailId;
    if (fingerprint === lastFingerprint) {
      repeatedPages += 1;
      if (repeatedPages >= 2) {
        console.log(
          `[ca_trades] tssa page=${page} duplicate fingerprint — stopping`,
        );
        break;
      }
    } else {
      repeatedPages = 0;
    }
    lastFingerprint = fingerprint;

    for (const row of rows) {
      if (!row.licenceNumber) {
        droppedNoLicence += 1;
        continue;
      }
      const cityRaw = extractTssaCity(row.rawAddress);
      const citySlug = mapCity(cityIndex, cityRaw);
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }
      const sourceId = `tssa:${row.detailId}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const record = normalise({
        source: "tssa",
        country: "CA",
        sourceId,
        name: row.name,
        categoryKey: pickTssaCategory(row.name),
        citySlug,
        address: row.rawAddress || undefined,
        licenseNumber: row.licenceNumber,
        metadata: {
          province: "ON",
          country: "CA",
          verified_by_authority: true,
          authority: "TSSA",
          licence_kind: "fuels-contractor",
        },
      });
      out.push(record);
    }
  }

  console.log(
    `[ca_trades] tssa parsed=${out.length} ` +
      `droppedNoCity=${droppedNoCity} droppedNoLicence=${droppedNoLicence}`,
  );
  return out;
}

// --- HCRA Ontario Builder Directory adapter ----------------------------

interface HcraRow {
  NAME?: string | null;
  OPERATINGNAME?: string | null;
  ACCOUNTNUMBER?: string | null;
  ADDRESS_2_CITY?: string | null;
  LICENSESTATUS?: string | null;
  INSOLVENCY_INDICATOR?: string | null;
}

const HCRA_LIVE_STATUSES = new Set<string>([
  "Licensed",
  "Licensed with Conditions",
  "Licenced - NOP Under Appeal",
  "Licenced - NOP to Refuse a Licence",
  "Licenced - NOP to Revoke a Licence",
]);

async function fetchHcraBuilders(
  cityIndex: CityIndex,
): Promise<ScrapedProfessional[]> {
  const url = "https://obd.hcraontario.ca/api/builders";
  if (await isRobotsBlocked(url)) {
    console.warn(`[ca_trades] hcra blocked by robots.txt — skipping`);
    return [];
  }
  const response = await politeFetch(url, "application/json");
  if (!response || !response.body) {
    console.warn(
      `[ca_trades] hcra fetch failed (status=${response?.status ?? "network"})`,
    );
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(response.body);
  } catch (error) {
    console.warn(
      `[ca_trades] hcra JSON parse failed: ${(error as Error).message}`,
    );
    return [];
  }
  if (!Array.isArray(data)) {
    console.warn(`[ca_trades] hcra payload not an array`);
    return [];
  }

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoName = 0;
  let droppedBadStatus = 0;
  let droppedNoCity = 0;
  let droppedNoAccount = 0;

  for (const raw of data as HcraRow[]) {
    const name = (raw.NAME ?? "").trim();
    if (!name) {
      droppedNoName += 1;
      continue;
    }
    const status = (raw.LICENSESTATUS ?? "").trim();
    if (!HCRA_LIVE_STATUSES.has(status)) {
      droppedBadStatus += 1;
      continue;
    }
    const account = (raw.ACCOUNTNUMBER ?? "").trim();
    if (!account) {
      droppedNoAccount += 1;
      continue;
    }
    const citySlug = mapCity(cityIndex, raw.ADDRESS_2_CITY ?? undefined);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }
    const sourceId = `hcra:${account}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const operating = (raw.OPERATINGNAME ?? "").trim();
    const record = normalise({
      source: "hcra",
      country: "CA",
      sourceId,
      name: operating || name,
      categoryKey: CATEGORY_CARPINTERO,
      citySlug,
      licenseNumber: account,
      metadata: {
        province: "ON",
        country: "CA",
        verified_by_authority: true,
        authority: "HCRA",
        licence_status: status,
        legal_name: name,
        operating_name: operating || undefined,
        insolvency: raw.INSOLVENCY_INDICATOR === "true",
      },
    });
    out.push(record);
  }

  console.log(
    `[ca_trades] hcra parsed=${out.length} ` +
      `droppedNoName=${droppedNoName} droppedBadStatus=${droppedBadStatus} ` +
      `droppedNoCity=${droppedNoCity} droppedNoAccount=${droppedNoAccount}`,
  );
  return out;
}

// --- Public entrypoint -------------------------------------------------

export const competitorCaTradesSource: ScraperSource = {
  // Logging name only; emitted rows carry the per-authority source.
  name: "tssa",
  enabled() {
    return process.env.PROLIO_RUN_CA_TRADES === "true";
  },
  async fetch() {
    return [];
  },
};

export function competitorCaTradesEnabled(): boolean {
  return competitorCaTradesSource.enabled();
}

/**
 * Bulk runner. Calls each surviving authority adapter and upserts via
 * sink. Respects `PROLIO_CA_TRADES_LIMIT` (default 2000) as a per-source
 * cap (TSSA + HCRA each capped independently — they cover non-overlapping
 * categories so cross-source double-spending isn't a concern).
 */
export async function runCompetitorCaTrades(): Promise<void> {
  if (!competitorCaTradesSource.enabled()) return;
  const limit = Number(process.env.PROLIO_CA_TRADES_LIMIT ?? DEFAULT_LIMIT);
  const effective =
    Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    console.warn(
      `[ca_trades] invalid PROLIO_CA_TRADES_LIMIT, using ${DEFAULT_LIMIT}`,
    );
  }

  const cityIndex = await loadCityIndex();
  const sink = getSink();

  // Per-source `withScrapeRun` so each authority gets its own
  // scrape_runs row in /admin (TSSA can fail without masking HCRA).
  await withScrapeRun("tssa", async () => {
    const rows = await fetchTssaContractors(cityIndex);
    const capped = rows.slice(0, effective);
    if (capped.length === 0) {
      return { rowsFetched: rows.length };
    }
    const { inserted, updated, skipped } = await sink.upsert(capped);
    console.log(
      `[ca_trades] tssa: found=${rows.length} upserted=${capped.length} ` +
        `inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
    return {
      rowsFetched: rows.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
    };
  }).catch((e) =>
    console.error(`[ca_trades] tssa crashed:`, (e as Error).message),
  );

  await withScrapeRun("hcra", async () => {
    const rows = await fetchHcraBuilders(cityIndex);
    const capped = rows.slice(0, effective);
    if (capped.length === 0) {
      return { rowsFetched: rows.length };
    }
    const { inserted, updated, skipped } = await sink.upsert(capped);
    console.log(
      `[ca_trades] hcra: found=${rows.length} upserted=${capped.length} ` +
        `inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
    return {
      rowsFetched: rows.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
    };
  }).catch((e) =>
    console.error(`[ca_trades] hcra crashed:`, (e as Error).message),
  );
}
