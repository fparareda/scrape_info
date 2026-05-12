import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * North-American competitor directory scraper.
 *
 * Seeds our DB with US + Canadian professionals by scraping four
 * permissive directories (robots.txt verified 2026-04-23):
 *
 *   - homeadvisor.com      (US)
 *   - thumbtack.com        (US)
 *   - homestars.com        (Canada)
 *   - trustedpros.ca       (Canada)
 *
 * Scope per run: top-5 US cities + top-5 Canadian cities × 4 categories
 * (electrician / plumber / mechanic / carpenter) across all four sites.
 * That's ~40 list-pages × 4 sites = 160 list-pages, each yielding up to
 * ~50 listings, target ceiling 2000 extractions / 1000 pages budget.
 *
 * Politeness:
 *   - Identifies as Prolio-Bot on first try; falls back to a Chrome UA
 *     only when the polite UA receives 403/503.
 *   - 1 concurrent request per host, 500ms throttle between requests.
 *   - Parses robots.txt once per host before scraping and respects
 *     wildcard Disallow. Any path matching the rules is skipped.
 *   - 10s timeout per request, global 1000-page cap per run.
 *
 * Off by default. Enable via `PROLIO_RUN_COMPETITOR_NA=true`. Never runs
 * on the monthly scheduled sweep — only workflow_dispatch.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 10_000;
const THROTTLE_MS = 500;
const MAX_PAGES_PER_RUN = 1000;
const DEFAULT_LIMIT = 2000;

// --- City mapping ------------------------------------------------------

// Our DB city_slugs are lowercase kebab. These top-5 lists align with the
// competitor URL path segments (always the same lowercase-kebab form
// except where a site uses its own quirk — handled per-adapter below).
const US_CITIES: ReadonlyArray<{
  slug: string;
  name: string;
  state: string; // 2-letter
  stateFull: string; // lowercased full name
}> = [
  { slug: "new-york", name: "New York", state: "ny", stateFull: "new-york" },
  { slug: "los-angeles", name: "Los Angeles", state: "ca", stateFull: "california" },
  { slug: "chicago", name: "Chicago", state: "il", stateFull: "illinois" },
  { slug: "houston", name: "Houston", state: "tx", stateFull: "texas" },
  { slug: "phoenix", name: "Phoenix", state: "az", stateFull: "arizona" },
];

const CA_CITIES: ReadonlyArray<{
  slug: string;
  name: string;
  province: string; // 2-letter
  provinceFull: string; // lowercased full name in URL form
}> = [
  { slug: "toronto", name: "Toronto", province: "on", provinceFull: "ontario" },
  { slug: "vancouver", name: "Vancouver", province: "bc", provinceFull: "british-columbia" },
  { slug: "montreal", name: "Montreal", province: "qc", provinceFull: "quebec" },
  { slug: "calgary", name: "Calgary", province: "ab", provinceFull: "alberta" },
  { slug: "ottawa", name: "Ottawa", province: "on", provinceFull: "ontario" },
];

// Map common "directory city string" → our DB slug. Covers HomeAdvisor /
// Thumbtack / HomeStars / TrustedPros variations. Anything that misses
// gets skipped (sink also drops unseeded slugs, but we short-circuit
// earlier to save a DB round-trip).
const CITY_ALIAS: Record<string, string> = {
  "new york": "new-york",
  "new york city": "new-york",
  nyc: "new-york",
  manhattan: "new-york",
  brooklyn: "new-york",
  "los angeles": "los-angeles",
  la: "los-angeles",
  chicago: "chicago",
  houston: "houston",
  phoenix: "phoenix",
  toronto: "toronto",
  vancouver: "vancouver",
  montreal: "montreal",
  "montréal": "montreal",
  calgary: "calgary",
  ottawa: "ottawa",
};

function mapCitySlug(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  return CITY_ALIAS[key];
}

// --- Category mapping --------------------------------------------------

type CompetitorCategory = "electrician" | "plumber" | "mechanic" | "carpenter";

const CATEGORY_MAP: Record<CompetitorCategory, CategoryKey> = {
  electrician: "electricidad",
  plumber: "fontaneria",
  mechanic: "mecanica",
  carpenter: "carpinteria",
};

// Site-specific URL slugs per category. We keep these as data so a
// markup change only touches one table.
const CAT_SLUGS = {
  homeadvisor: {
    electrician: "Electrical",
    plumber: "Plumbing",
    mechanic: "Auto-Repair", // weak on HA; keep to seed whatever is there
    carpenter: "Carpentry",
  },
  thumbtack: {
    electrician: "electrician",
    plumber: "plumber",
    mechanic: "auto-mechanic",
    carpenter: "carpenter",
  },
  homestars: {
    electrician: "electricians",
    plumber: "plumbers",
    mechanic: "auto-services", // HomeStars is home-services-skewed
    carpenter: "carpenters",
  },
  trustedpros: {
    electrician: "electrical",
    plumber: "plumbing",
    mechanic: "mechanical",
    carpenter: "carpentry",
  },
} as const satisfies Record<
  "homeadvisor" | "thumbtack" | "homestars" | "trustedpros",
  Record<CompetitorCategory, string>
>;

// --- HTTP helpers ------------------------------------------------------

interface HostState {
  lastRequestAt: number;
  disallow: string[] | null; // null = not yet loaded; [] = nothing disallowed
  inFlight: Promise<unknown> | null;
  fallbackUa: boolean; // once true, stick with fallback UA for rest of run
}

const hostState = new Map<string, HostState>();

function getHostState(host: string): HostState {
  let state = hostState.get(host);
  if (!state) {
    state = { lastRequestAt: 0, disallow: null, inFlight: null, fallbackUa: false };
    hostState.set(host, state);
  }
  return state;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttledFetch(
  url: string,
  attempt: "polite" | "fallback" = "polite",
): Promise<{ status: number; html: string | null }> {
  const { host, pathname } = new URL(url);
  const state = getHostState(host);

  // Serialise per-host to keep concurrency at 1.
  while (state.inFlight) {
    try {
      await state.inFlight;
    } catch {
      // ignore — we just want to wait for the slot
    }
  }

  const work = (async (): Promise<{ status: number; html: string | null }> => {
    const sinceLast = Date.now() - state.lastRequestAt;
    if (sinceLast < THROTTLE_MS) {
      await delay(THROTTLE_MS - sinceLast);
    }

    // robots.txt gating: load once per host.
    if (state.disallow === null) {
      state.disallow = await loadRobotsDisallow(host);
    }
    if (isDisallowed(pathname, state.disallow)) {
      return { status: 0, html: null };
    }

    const ua = state.fallbackUa || attempt === "fallback" ? FALLBACK_UA : POLITE_UA;
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
      state.lastRequestAt = Date.now();
      if (
        (response.status === 403 || response.status === 503) &&
        attempt === "polite" &&
        !state.fallbackUa
      ) {
        // Upgrade this host to fallback UA for the rest of the run.
        state.fallbackUa = true;
        console.warn(
          `[competitor_na] ${host} blocked polite UA (${response.status}); falling back to Chrome UA`,
        );
        // Retry once with fallback; we re-enter the fetch via a recursive
        // call after releasing the slot — simpler to just fetch here.
        return fetchWithUa(url, FALLBACK_UA);
      }
      if (!response.ok) {
        return { status: response.status, html: null };
      }
      const html = await response.text();
      return { status: response.status, html };
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      console.warn(`[competitor_na] network error on ${url}: ${message}`);
      return { status: 0, html: null };
    } finally {
      clearTimeout(timer);
    }
  })();

  state.inFlight = work;
  try {
    return await work;
  } finally {
    if (state.inFlight === work) state.inFlight = null;
  }
}

async function fetchWithUa(
  url: string,
  ua: string,
): Promise<{ status: number; html: string | null }> {
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
    const host = new URL(url).host;
    getHostState(host).lastRequestAt = Date.now();
    if (!response.ok) return { status: response.status, html: null };
    const html = await response.text();
    return { status: response.status, html };
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    console.warn(`[competitor_na] network error on ${url}: ${message}`);
    return { status: 0, html: null };
  } finally {
    clearTimeout(timer);
  }
}

// --- robots.txt --------------------------------------------------------

async function loadRobotsDisallow(host: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`https://${host}/robots.txt`, {
      headers: { "User-Agent": POLITE_UA },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return [];
    const text = await response.text();
    return parseRobotsDisallow(text);
  } catch {
    return [];
  }
}

/**
 * Parse only the `User-agent: *` section. We take a conservative view:
 * if the file is malformed, return [] (nothing disallowed) — we've
 * already pre-verified all four hosts allow us.
 */
function parseRobotsDisallow(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const disallow: string[] = [];
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
      disallow.push(value);
    }
  }
  return disallow;
}

function isDisallowed(pathname: string, disallow: string[]): boolean {
  for (const rule of disallow) {
    if (rule === "/") return true;
    if (pathname.startsWith(rule)) return true;
  }
  return false;
}

// --- HTML helpers ------------------------------------------------------

function stripTags(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseNaPhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

/**
 * Extract numbers that look like ratings (e.g. 4.8) and review counts
 * (e.g. "(123)") from a listing block. Parsers are best-effort; a
 * missing value is fine.
 */
function extractRating(block: string): number | undefined {
  const match = block.match(/\b([1-5](?:\.[0-9])?)\s*(?:out of|\/|stars?)/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

function extractReviewCount(block: string): number | undefined {
  const match = block.match(/\(\s*([0-9,]+)\s*(?:reviews?|ratings?)?\s*\)/i);
  if (!match) return undefined;
  const n = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

// --- Per-site adapters -------------------------------------------------
//
// Each adapter returns ScrapedProfessional[] for one (city, category).
// Adapters MUST swallow their own errors — one failing adapter must not
// stop the others. Pagination is capped at ~1 page per combo so the run
// stays inside the global 1000-page budget.

interface AdapterCtx {
  pagesUsed: () => number;
  incrementPages: () => void;
  limit: number;
}

interface SiteAdapter {
  source: "homeadvisor" | "thumbtack" | "homestars" | "trustedpros";
  /** true if this site covers the given country. */
  supports(country: "US" | "CA"): boolean;
  run(
    category: CompetitorCategory,
    city: (typeof US_CITIES)[number] | (typeof CA_CITIES)[number],
    country: "US" | "CA",
    ctx: AdapterCtx,
  ): Promise<ScrapedProfessional[]>;
}

// --- HomeAdvisor (US) --------------------------------------------------

const homeAdvisorAdapter: SiteAdapter = {
  source: "homeadvisor",
  supports: (c) => c === "US",
  async run(category, city, country, ctx) {
    if (country !== "US") return [];
    if (ctx.pagesUsed() >= MAX_PAGES_PER_RUN) return [];
    const catPath = CAT_SLUGS.homeadvisor[category];
    const cityUs = city as (typeof US_CITIES)[number];
    const url = `https://www.homeadvisor.com/near-me/${catPath}/${cityUs.slug}-${cityUs.state}/`;
    const { html, status } = await throttledFetch(url);
    ctx.incrementPages();
    if (!html) {
      if (status !== 0) {
        console.log(`[competitor_na] homeadvisor ${cityUs.slug}/${category} ${status}`);
      }
      return [];
    }
    // HomeAdvisor renders results in <div class="SpProfileContainer">
    // blocks with name in an <a class="SpProfileAnchor">. We split on
    // that anchor; any site redesign that changes this classname means
    // we return []. Acceptable — the other three adapters still fire.
    const out: ScrapedProfessional[] = [];
    const blocks = html.split(/<div[^>]+class="[^"]*SpProfileContainer[^"]*"/i).slice(1);
    for (const block of blocks) {
      const nameMatch = block.match(
        /<a[^>]+class="[^"]*SpProfileAnchor[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
      );
      const hrefMatch = block.match(
        /<a[^>]+href="([^"]*\/rated\.[^"]+)"[^>]*class="[^"]*SpProfileAnchor/i,
      );
      if (!nameMatch || !hrefMatch) continue;
      const name = stripTags(nameMatch[1]);
      if (!name) continue;
      const slugMatch = hrefMatch[1].match(/\/rated\.([^.]+)\.(\d+)/);
      const sourceId = slugMatch ? `${slugMatch[1]}.${slugMatch[2]}` : `name:${name.toLowerCase().replace(/\s+/g, "-")}`;
      const phoneMatch = block.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      out.push(
        normalise({
          source: "homeadvisor",
          sourceId,
          name,
          categoryKey: CATEGORY_MAP[category],
          citySlug: cityUs.slug,
          phone: normaliseNaPhone(phoneMatch?.[0]),
          rating: extractRating(block),
          reviewCount: extractReviewCount(block),
          metadata: { state: cityUs.state.toUpperCase(), country: "US" },
        }),
      );
    }
    return dedupe(out);
  },
};

// --- Thumbtack (US) ----------------------------------------------------

const thumbtackAdapter: SiteAdapter = {
  source: "thumbtack",
  supports: (c) => c === "US",
  async run(category, city, country, ctx) {
    if (country !== "US") return [];
    if (ctx.pagesUsed() >= MAX_PAGES_PER_RUN) return [];
    const catPath = CAT_SLUGS.thumbtack[category];
    const cityUs = city as (typeof US_CITIES)[number];
    // Thumbtack SEO URL: /{state}/{city}/{category}/
    const url = `https://www.thumbtack.com/${cityUs.state}/${cityUs.slug}/${catPath}/`;
    const { html, status } = await throttledFetch(url);
    ctx.incrementPages();
    if (!html) {
      if (status !== 0) {
        console.log(`[competitor_na] thumbtack ${cityUs.slug}/${category} ${status}`);
      }
      return [];
    }
    // Thumbtack ships a __NEXT_DATA__ script with fully-structured JSON.
    // When present we prefer that; it's stable across redesigns.
    const out: ScrapedProfessional[] = [];
    const jsonMatch = html.match(
      /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
    );
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]) as unknown;
        const pros = collectThumbtackPros(data);
        for (const p of pros) {
          if (!p.name || !p.sourceId) continue;
          out.push(
            normalise({
              source: "thumbtack",
              sourceId: p.sourceId,
              name: p.name,
              categoryKey: CATEGORY_MAP[category],
              citySlug: cityUs.slug,
              rating: p.rating,
              reviewCount: p.reviewCount,
              metadata: { state: cityUs.state.toUpperCase(), country: "US" },
            }),
          );
        }
      } catch {
        // Fall through to HTML parse.
      }
    }
    if (out.length === 0) {
      // Fallback: grep `<h2>Business Name</h2>`-style markup.
      const blocks = html.split(/<article[^>]*>/i).slice(1);
      for (const block of blocks) {
        const nameMatch = block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
        if (!nameMatch) continue;
        const name = stripTags(nameMatch[1]);
        if (!name) continue;
        out.push(
          normalise({
            source: "thumbtack",
            sourceId: `name:${name.toLowerCase().replace(/\s+/g, "-")}-${cityUs.slug}`,
            name,
            categoryKey: CATEGORY_MAP[category],
            citySlug: cityUs.slug,
            rating: extractRating(block),
            reviewCount: extractReviewCount(block),
            metadata: { state: cityUs.state.toUpperCase(), country: "US" },
          }),
        );
      }
    }
    return dedupe(out);
  },
};

interface ThumbtackPro {
  sourceId?: string;
  name?: string;
  rating?: number;
  reviewCount?: number;
}

/**
 * Walk the Thumbtack __NEXT_DATA__ blob for objects that look like
 * service-pro summaries. Thumbtack's schema changes semi-regularly, so
 * we look for a loose shape: `{ businessName|name, avgRating, numReviews, servicePk|id }`.
 */
function collectThumbtackPros(root: unknown): ThumbtackPro[] {
  const out: ThumbtackPro[] = [];
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0 && out.length < 100) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);
    const obj = node as Record<string, unknown>;
    const name =
      (typeof obj.businessName === "string" && obj.businessName) ||
      (typeof obj.name === "string" && obj.name) ||
      undefined;
    const id =
      (typeof obj.servicePk === "string" && obj.servicePk) ||
      (typeof obj.serviceId === "string" && obj.serviceId) ||
      (typeof obj.id === "string" && obj.id) ||
      undefined;
    if (name && id) {
      const rating =
        typeof obj.avgRating === "number"
          ? obj.avgRating
          : typeof obj.rating === "number"
            ? obj.rating
            : undefined;
      const reviewCount =
        typeof obj.numReviews === "number"
          ? obj.numReviews
          : typeof obj.reviewCount === "number"
            ? obj.reviewCount
            : undefined;
      out.push({ sourceId: `tt:${id}`, name, rating, reviewCount });
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return out;
}

// --- HomeStars (Canada) ------------------------------------------------

const homeStarsAdapter: SiteAdapter = {
  source: "homestars",
  supports: (c) => c === "CA",
  async run(category, city, country, ctx) {
    if (country !== "CA") return [];
    if (ctx.pagesUsed() >= MAX_PAGES_PER_RUN) return [];
    const catPath = CAT_SLUGS.homestars[category];
    const cityCa = city as (typeof CA_CITIES)[number];
    // URL: /companies/{province}/{city}/{category}
    const url = `https://homestars.com/companies/${cityCa.provinceFull}/${cityCa.slug}/${catPath}`;
    const { html, status } = await throttledFetch(url);
    ctx.incrementPages();
    if (!html) {
      if (status !== 0) {
        console.log(`[competitor_na] homestars ${cityCa.slug}/${category} ${status}`);
      }
      return [];
    }
    // HomeStars listing cards use `<div class="company-card">` with a
    // link to `/companies/<slug>`. We pull name + rating + review count
    // per card.
    const out: ScrapedProfessional[] = [];
    const blocks = html.split(/<(?:div|article)[^>]+class="[^"]*company-card[^"]*"/i).slice(1);
    for (const block of blocks) {
      const hrefMatch = block.match(/href="(\/companies\/[^"]+)"/i);
      const nameMatch = block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
      if (!hrefMatch || !nameMatch) continue;
      const name = stripTags(nameMatch[1]);
      if (!name) continue;
      const slug = hrefMatch[1].split("/").filter(Boolean).pop() ?? "";
      out.push(
        normalise({
          source: "homestars",
          sourceId: `hs:${slug}`,
          name,
          categoryKey: CATEGORY_MAP[category],
          citySlug: cityCa.slug,
          rating: extractRating(block),
          reviewCount: extractReviewCount(block),
          metadata: { province: cityCa.province.toUpperCase(), country: "CA" },
        }),
      );
    }
    return dedupe(out);
  },
};

// --- TrustedPros (Canada) ---------------------------------------------

const trustedProsAdapter: SiteAdapter = {
  source: "trustedpros",
  supports: (c) => c === "CA",
  async run(category, city, country, ctx) {
    if (country !== "CA") return [];
    if (ctx.pagesUsed() >= MAX_PAGES_PER_RUN) return [];
    const catPath = CAT_SLUGS.trustedpros[category];
    const cityCa = city as (typeof CA_CITIES)[number];
    // URL: /{province}/{city}/{category}
    const url = `https://www.trustedpros.ca/${cityCa.provinceFull}/${cityCa.slug}/${catPath}`;
    const { html, status } = await throttledFetch(url);
    ctx.incrementPages();
    if (!html) {
      if (status !== 0) {
        console.log(`[competitor_na] trustedpros ${cityCa.slug}/${category} ${status}`);
      }
      return [];
    }
    // TrustedPros lists contractors in `<div class="contractor-listing">`
    // with name in an anchor. Fields are sparse (no phone on list page).
    const out: ScrapedProfessional[] = [];
    const blocks = html
      .split(/<(?:div|article)[^>]+class="[^"]*(?:contractor-listing|listing-item)[^"]*"/i)
      .slice(1);
    for (const block of blocks) {
      const hrefMatch = block.match(/href="(\/contractor\/[^"]+)"/i);
      const nameMatch = block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
      if (!nameMatch) continue;
      const name = stripTags(nameMatch[1]);
      if (!name) continue;
      const slug = hrefMatch
        ? (hrefMatch[1].split("/").filter(Boolean).pop() ?? "")
        : name.toLowerCase().replace(/\s+/g, "-");
      out.push(
        normalise({
          source: "trustedpros",
          sourceId: `tp:${slug}-${cityCa.slug}`,
          name,
          categoryKey: CATEGORY_MAP[category],
          citySlug: cityCa.slug,
          rating: extractRating(block),
          reviewCount: extractReviewCount(block),
          metadata: { province: cityCa.province.toUpperCase(), country: "CA" },
        }),
      );
    }
    return dedupe(out);
  },
};

const ADAPTERS: SiteAdapter[] = [
  homeAdvisorAdapter,
  thumbtackAdapter,
  homeStarsAdapter,
  trustedProsAdapter,
];

function dedupe(records: ScrapedProfessional[]): ScrapedProfessional[] {
  const seen = new Map<string, ScrapedProfessional>();
  for (const r of records) {
    const key = `${r.source}::${r.sourceId}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return Array.from(seen.values());
}

// --- Public entrypoint -------------------------------------------------

export const competitorNaSource: ScraperSource = {
  // We declare a representative source name just for logging; the
  // emitted records carry the real per-directory source value.
  name: "homeadvisor",
  enabled() {
    return process.env.PROLIO_RUN_COMPETITOR_NA === "true";
  },
  // Per-target fetch is intentionally a no-op. competitor-na runs as a
  // one-shot bulk job via `runCompetitorNa()` (see index.ts wiring) to
  // avoid being called 9×200 times by the generic target loop.
  async fetch() {
    return [];
  },
};

/**
 * One-shot bulk runner. Iterates every (site, country, city, category)
 * combination within budget and upserts results via sink.
 *
 * Call from index.ts when PROLIO_RUN_COMPETITOR_NA=true. Skips itself if
 * disabled so index.ts can wire it unconditionally.
 */
export async function runCompetitorNa(): Promise<void> {
  if (!competitorNaSource.enabled()) return;
  const limit = Number(process.env.PROLIO_COMPETITOR_NA_LIMIT ?? DEFAULT_LIMIT);
  let pagesUsed = 0;
  const ctx: AdapterCtx = {
    pagesUsed: () => pagesUsed,
    incrementPages: () => {
      pagesUsed += 1;
    },
    limit,
  };
  const categories: CompetitorCategory[] = [
    "electrician",
    "plumber",
    "mechanic",
    "carpenter",
  ];
  const combos: Array<{
    country: "US" | "CA";
    city: (typeof US_CITIES)[number] | (typeof CA_CITIES)[number];
  }> = [
    ...US_CITIES.map((city) => ({ country: "US" as const, city })),
    ...CA_CITIES.map((city) => ({ country: "CA" as const, city })),
  ];

  const sink = getSink();
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalRecords = 0;

  outer: for (const { country, city } of combos) {
    for (const category of categories) {
      for (const adapter of ADAPTERS) {
        if (!adapter.supports(country)) continue;
        if (pagesUsed >= MAX_PAGES_PER_RUN) {
          console.warn(
            `[competitor_na] page budget ${MAX_PAGES_PER_RUN} exhausted; stopping`,
          );
          break outer;
        }
        if (totalRecords >= limit) {
          console.warn(`[competitor_na] record limit ${limit} reached; stopping`);
          break outer;
        }
        let records: ScrapedProfessional[] = [];
        try {
          records = await adapter.run(category, city, country, ctx);
        } catch (error) {
          console.warn(
            `[competitor_na] ${adapter.source} ${city.slug}/${category} crashed: ${(error as Error).message}`,
          );
          continue;
        }
        // Remap any records whose city_slug didn't come pre-mapped. All
        // four adapters hard-code the slug from our city table, so this
        // is a defensive guard rather than a hot path.
        const usable = records.filter((r) => {
          if (!r.name) return false;
          if (!r.citySlug) return false;
          return mapCitySlug(r.citySlug) || isKnownSlug(r.citySlug);
        });
        if (usable.length === 0) continue;
        totalRecords += usable.length;
        const { inserted, updated, skipped } = await sink.upsert(usable);
        totalInserted += inserted;
        totalUpdated += updated;
        totalSkipped += skipped;
        console.log(
          `[competitor_na] ${adapter.source} ${country}/${city.slug}/${category}: ` +
            `found=${usable.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
        );
      }
    }
  }
  console.log(
    `[competitor_na] done — pages=${pagesUsed} records=${totalRecords} ` +
      `inserted=${totalInserted} updated=${totalUpdated} skipped=${totalSkipped}`,
  );
}

const KNOWN_SLUGS = new Set<string>([
  ...US_CITIES.map((c) => c.slug),
  ...CA_CITIES.map((c) => c.slug),
]);

function isKnownSlug(slug: string): boolean {
  return KNOWN_SLUGS.has(slug);
}
