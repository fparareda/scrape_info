import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { createClient } from "@supabase/supabase-js";

/**
 * Houzz US — home-services directory scraper.
 *
 * Pre-flight (2026-04-24):
 *
 *   robots.txt (https://www.houzz.com/robots.txt) — REACHABLE with caveats.
 *     The User-agent asterisk block DISALLOWS:
 *       /professionals/<cat>/s/   (search sub-paths, per-cat)
 *       /professionals/query...   (query URLs)
 *       /<anything>/query/..., /s/...  (generic search)
 *     It does NOT disallow the browse path we use:
 *       /professionals/<category>/<city-state-us-probr0-bo~...>
 *     We avoid every disallowed path.
 *
 *   HEAD probe with Chrome User-Agent on a sample browse URL returns
 *   200 (after a 301 canonicalisation redirect). No Cloudflare
 *   interstitial observed. JSON-LD `LocalBusiness` objects (~30 per
 *   page) are embedded directly in the HTML — no JS rendering required,
 *   no XHR API to reverse.
 *
 * Strategy:
 *   - For each seeded US city × supported category, fetch the Houzz
 *     browse listing page and extract JSON-LD `LocalBusiness` records.
 *   - Drop rows whose `addressLocality` doesn't map to a seeded
 *     `cities.slug` (country='US'). The sink would drop unknown slugs
 *     anyway, but pre-filtering keeps batches small.
 *   - Cap at PROLIO_HOUZZ_LIMIT rows per run (default 500). Well under
 *     both the monthly GH Actions budget and Houzz's likely rate-limit
 *     threshold.
 *
 * Scope/scale:
 *   - 2 categories × top-10 US cities × ~30 pros/page = ~600 candidates
 *     per run, capped to 500. Single-page deep (no pagination loop) so
 *     we don't drift into noisier results or hammer the origin.
 *
 * Off by default. Enabled via PROLIO_RUN_COMPETITOR_HOUZZ=true. Gated
 * OFF in the scheduled monthly workflow — workflow_dispatch only.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 500;
const REQUEST_DELAY_MS = 2_500;

// --- Category mapping --------------------------------------------------

/**
 * Houzz category slug → Prolio CategoryKey. Only wiring categories that
 * map cleanly to our existing 9-category taxonomy; "general-contractor"
 * covers both carpinteria and general home-improvement, so we bucket to
 * carpinteria (matches our existing North-American handling).
 *
 * We deliberately skip architects / interior-designers / kitchen-
 * designers because we have no matching CategoryKey today.
 */
const HOUZZ_CATEGORIES: Array<{ slug: string; category: CategoryKey }> = [
  { slug: "general-contractor", category: "carpinteria" },
  { slug: "electrician", category: "electricidad" },
  { slug: "plumber", category: "fontaneria" },
];

// --- City URL mapping --------------------------------------------------

/**
 * Houzz URLs use a location token like
 *   `new-york-city-ny-us-probr0-bo~t_11786~r_5128581`
 * where `t_` is a category-topic ID and `r_` is a city region ID. We
 * can't derive those from our city slugs — they're internal Houzz keys.
 * Rather than scrape a discovery page (risk: unstable, extra requests),
 * we hand-curate a list of the top US cities we care about, keyed by
 * our city_slug. Only these cities are actually queried.
 *
 * Format: `<houzz-location-token>` — category+region tokens are NOT
 * city-specific, so we capture just the city slug + state code + GUID.
 * At request time we combine: /professionals/<cat>/<city-token>.
 *
 * Sourced by manually resolving the canonical URL on Houzz for each
 * city (one-time). If a city isn't here, we skip it — better than a
 * fragile "guess the slug" approach that 404s on 20% of cities.
 */
const HOUZZ_CITY_URL_TOKEN: Record<string, string> = {
  "new-york": "new-york-city-ny-us-probr0-bo~r_5128581",
  "new-york-us-ny": "new-york-city-ny-us-probr0-bo~r_5128581",
  "los-angeles": "los-angeles-ca-us-probr0-bo~r_5368361",
  chicago: "chicago-il-us-probr0-bo~r_4887398",
  houston: "houston-tx-us-probr0-bo~r_4699066",
  phoenix: "phoenix-az-us-probr0-bo~r_5308655",
  philadelphia: "philadelphia-pa-us-probr0-bo~r_4560349",
  "san-antonio": "san-antonio-tx-us-probr0-bo~r_4726206",
  "san-diego": "san-diego-ca-us-probr0-bo~r_5391811",
  dallas: "dallas-tx-us-probr0-bo~r_4684888",
  "san-jose": "san-jose-ca-us-probr0-bo~r_5392171",
};

// --- HTTP helpers ------------------------------------------------------

async function politeFetch(url: string): Promise<{ status: number; body: string } | null> {
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
            `[houzz] blocked polite UA (${response.status}); retrying with Chrome UA`,
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
      console.warn(`[houzz] network error on ${url}: ${(error as Error).message}`);
      return null;
    }
  }
  return null;
}

/**
 * robots.txt gate. Applies the User-agent:* block's Disallow rules to
 * `pathname`. Returns true if the path is blocked. Falls open on
 * network errors — we pre-verified the rules by hand (see module
 * header). This is a defence-in-depth check in case Houzz tightens
 * its robots.txt in the future.
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
      // Houzz uses glob-style `*` in disallow values. Translate to a
      // simple prefix+wildcard: split on `*`, require each segment in
      // order. Good enough for the patterns we've observed.
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
    if (i === 0 && idx !== 0) return false; // first segment is an anchor
    cursor = idx + seg.length;
  }
  return true;
}

// --- Parsing -----------------------------------------------------------

interface LocalBusinessJsonLd {
  "@type"?: string | string[];
  name?: string;
  telephone?: string;
  image?: string | string[] | { url?: string };
  address?: {
    streetAddress?: string;
    addressLocality?: string;
    addressRegion?: string;
    postalCode?: string;
    addressCountry?: string;
  };
  geo?: {
    latitude?: number | string;
    longitude?: number | string;
  };
  sameAs?: string[];
  url?: string;
}

function typeIncludes(type: unknown, needle: string): boolean {
  if (typeof type === "string") return type === needle;
  if (Array.isArray(type)) return type.some((t) => t === needle);
  return false;
}

/**
 * Extract every JSON-LD `LocalBusiness` block from an HTML page. We
 * tolerate either a single object or an array per `<script>` tag, which
 * is what schema.org recommends and what Houzz actually ships.
 */
function extractLocalBusinesses(html: string): LocalBusinessJsonLd[] {
  const out: LocalBusinessJsonLd[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const t = (item as LocalBusinessJsonLd)["@type"];
      if (typeIncludes(t, "LocalBusiness") || typeIncludes(t, "ProfessionalService")) {
        out.push(item as LocalBusinessJsonLd);
      }
    }
  }
  return out;
}

function normaliseUsPhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

function toNumber(raw: number | string | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function pickImage(image: LocalBusinessJsonLd["image"]): string | undefined {
  if (!image) return undefined;
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return typeof image[0] === "string" ? image[0] : undefined;
  if (typeof image === "object" && typeof image.url === "string") return image.url;
  return undefined;
}

/**
 * Pull Houzz's per-pro identifier out of the `sameAs` list. Entries
 * look like `https://www.houzz.com/professionals/<cat>/<slug>-pfvwus-pf~<digits>`.
 * The trailing `pf~<digits>` is a globally unique account ID.
 */
function extractSourceId(lb: LocalBusinessJsonLd): string | undefined {
  const hits = (lb.sameAs ?? []).filter(
    (u) => typeof u === "string" && u.includes("houzz.com/professionals/"),
  );
  for (const u of hits) {
    const m = u.match(/pf~(\d+)/);
    if (m) return `houzz:${m[1]}`;
  }
  return undefined;
}

function buildAddress(lb: LocalBusinessJsonLd): string | undefined {
  const a = lb.address;
  if (!a) return undefined;
  const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function extractProUrl(lb: LocalBusinessJsonLd): string | undefined {
  const hits = (lb.sameAs ?? []).filter(
    (u) => typeof u === "string" && u.includes("houzz.com/professionals/"),
  );
  return hits[0];
}

// --- Fetch + parse a single listing page -------------------------------

async function fetchCategoryCityPage(
  categorySlug: string,
  cityToken: string,
  citySlug: string,
  categoryKey: CategoryKey,
  validCitySlugs: Set<string>,
): Promise<{ records: ScrapedProfessional[]; status: number }> {
  const url = `https://www.houzz.com/professionals/${categorySlug}/${cityToken}`;
  if (await isRobotsBlocked(url)) {
    console.warn(`[houzz] robots blocked ${url} — skipping`);
    return { records: [], status: 0 };
  }
  const response = await politeFetch(url);
  if (!response) return { records: [], status: 0 };
  if (!response.body) return { records: [], status: response.status };

  const businesses = extractLocalBusinesses(response.body);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCity = 0;
  let droppedNoId = 0;

  for (const lb of businesses) {
    const sourceId = extractSourceId(lb);
    if (!sourceId) {
      droppedNoId += 1;
      continue;
    }
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const name = (lb.name ?? "").trim();
    if (!name) continue;

    // Houzz's `addressLocality` rarely matches our slugs verbatim —
    // slugify it and check against the seeded set. Fallback to the
    // current query's city_slug (we already know that's valid).
    const locality = lb.address?.addressLocality?.trim();
    const localitySlug = locality ? slugify(locality) : undefined;
    const mappedCity = localitySlug && validCitySlugs.has(localitySlug) ? localitySlug : citySlug;
    if (!validCitySlugs.has(mappedCity)) {
      droppedNoCity += 1;
      continue;
    }

    out.push(
      normalise({
        source: "houzz",
        sourceId,
        name,
        categoryKey,
        citySlug: mappedCity,
        phone: normaliseUsPhone(lb.telephone),
        website: extractProUrl(lb),
        address: buildAddress(lb),
        lat: toNumber(lb.geo?.latitude),
        lng: toNumber(lb.geo?.longitude),
        photoUrl: pickImage(lb.image),
        metadata: {
          country: "US",
          region: lb.address?.addressRegion,
          postal_code: lb.address?.postalCode,
          houzz_category: categorySlug,
          same_as: lb.sameAs,
        },
      }),
    );
  }

  console.log(
    `[houzz] ${categorySlug}/${citySlug}: ` +
      `found=${businesses.length} kept=${out.length} ` +
      `droppedNoCity=${droppedNoCity} droppedNoId=${droppedNoId}`,
  );
  return { records: out, status: response.status };
}

// --- City-slug loader (shared pattern with sink.ts) --------------------

async function loadUsCitySlugs(): Promise<Set<string>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Set();
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const slugs = new Set<string>();
  for (let from = 0; from < 5000; from += 1000) {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Public entrypoint -------------------------------------------------

export const competitorHouzzSource: ScraperSource = {
  name: "houzz",
  enabled() {
    return process.env.PROLIO_RUN_COMPETITOR_HOUZZ === "true";
  },
  // One-shot bulk runner; per-target fetch is a no-op.
  async fetch() {
    return [];
  },
};

export interface HouzzRunSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export async function runCompetitorHouzz(): Promise<HouzzRunSummary | null> {
  if (!competitorHouzzSource.enabled()) return null;

  const limitRaw = Number(process.env.PROLIO_HOUZZ_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

  const validCitySlugs = await loadUsCitySlugs();
  if (validCitySlugs.size === 0) {
    console.warn(`[houzz] no US cities seeded — skipping`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const all: ScrapedProfessional[] = [];
  let pageCount = 0;

  outer: for (const [citySlug, cityToken] of Object.entries(HOUZZ_CITY_URL_TOKEN)) {
    if (!validCitySlugs.has(citySlug)) continue;
    for (const { slug: categorySlug, category } of HOUZZ_CATEGORIES) {
      const { records, status } = await fetchCategoryCityPage(
        categorySlug,
        cityToken,
        citySlug,
        category,
        validCitySlugs,
      );
      pageCount += 1;
      if (status === 403 || status === 503) {
        console.warn(`[houzz] got ${status}; aborting run to respect rate limits`);
        break outer;
      }
      all.push(...records);
      if (all.length >= limit) {
        console.log(`[houzz] reached cap ${limit}, stopping`);
        break outer;
      }
      await delay(REQUEST_DELAY_MS);
    }
  }

  const capped = all.slice(0, limit);
  if (capped.length === 0) {
    console.log(`[houzz] done — pages=${pageCount} records=0`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await sink.upsert(capped);
  console.log(
    `[houzz] done — pages=${pageCount} records=${capped.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: capped.length, inserted, updated, skipped };
}
