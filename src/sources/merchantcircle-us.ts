import { gunzipSync } from "node:zlib";
import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * MerchantCircle — US generalist business directory.
 *
 * Backed by the public sitemap index at:
 *   https://www.merchantcircle.com/business_index.xml
 *   → 897 sub-sitemaps (business{,1..896}.xml.gz), each gzipped,
 *     each with up to 50_000 `<loc>` entries. Total universe
 *     ≈ 44.9M business profile URLs (verified 2026-05-26).
 *
 * Pre-flight 2026-05-26 (datacenter IP):
 *   - robots.txt explicitly lists `business_index.xml` and friends as
 *     allowed sitemaps. Bot-detection: none observed on GET.
 *   - One sub-sitemap (`business.xml.gz`, 833 KB compressed) decompresses
 *     to ~13 MB XML with 50_000 URLs. Sample slug shape:
 *       https://www.merchantcircle.com/<biz-slug>-<city>-<state2>
 *     where <state2> is the 2-letter USPS abbreviation. City and state
 *     are recoverable from the slug WITHOUT fetching the profile.
 *   - Profile page (`/esma--south-holland-il`) renders schema.org markup:
 *       itemprop="telephone|streetAddress|addressLocality|addressRegion|postalCode"
 *     plus `<h1>` for the business name. ~65 KB per profile.
 *
 * Realistic scale arithmetic:
 *   44.9M URLs × 1.5 s/profile = ~780 days serial. Not viable for a
 *   full crawl. We shard by sub-sitemap index AND optionally by state,
 *   capping each run to PROLIO_MC_LIMIT rows (default 5_000). Top-state
 *   slices (CA/NY/TX/FL) yield ~10-15 k candidate URLs per sub-sitemap,
 *   so 5_000 cap × weekly cron is the right cadence.
 *
 * Categorisation: MerchantCircle doesn't expose a clean category field
 * we can rely on. We keyword-match the slug against the prolio
 * CategoryKey enum (plumb→fontaneria, dentist→dentista, etc.).
 * Profiles whose slug doesn't match any known keyword are SKIPPED to
 * avoid polluting the directory with mis-categorised noise.
 *
 * Off by default. Enable via PROLIO_RUN_MC_US=true.
 *
 * Env knobs:
 *   PROLIO_MC_LIMIT             global row cap (default 5_000)
 *   PROLIO_MC_SITEMAP_INDICES   comma-separated indices of sub-sitemaps
 *                               to process (default "0"). Index 0 =
 *                               business.xml.gz, 1 = business1.xml.gz, …
 *                               up to 896.
 *   PROLIO_MC_STATES            comma-separated USPS abbreviations
 *                               (e.g. "ca,ny,tx,fl"). Default = all.
 *   PROLIO_MC_DELAY_MS          ms between profile fetches (default 1500)
 *   PROLIO_MC_MAX_404_STREAK    abort sub-sitemap if N consecutive 404s
 *                               (default 50 — site has dead profiles)
 */

const SITEMAP_INDEX = "https://www.merchantcircle.com/business_index.xml";
const SOURCE_NAME = "merchantcircle-us" as ScrapeSource;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 5_000;
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_404_STREAK = 50;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// USPS 2-letter abbreviations. We use this to validate the trailing
// state token on each slug. Anything that doesn't end in one of these
// is dropped (sometimes slugs have weird tails like "-1" or city-only).
const US_STATES = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in",
  "ia","ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv",
  "nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn",
  "tx","ut","vt","va","wa","wv","wi","wy","dc",
]);

interface CategoryRule {
  key: CategoryKey;
  keywords: RegExp;
}

// Keyword → CategoryKey. Tried in order; first match wins.
const CATEGORY_RULES: CategoryRule[] = [
  { key: "dentista",     keywords: /\b(dentist|dental|orthodontist|endodontist)\b/i },
  { key: "veterinario",  keywords: /\b(vet|veterinar|animal-hospital)\b/i },
  { key: "fisioterapia", keywords: /\b(physical-?therap|physiotherap|chiro)\b/i },
  { key: "psicologia",   keywords: /\b(psycholog|counsel|therap(y|ist)|mental-health)\b/i },
  { key: "farmacia",     keywords: /\b(pharma|drugstore|chemist)\b/i },
  { key: "enfermeria",   keywords: /\b(nurs|home-?health|hospice)\b/i },
  { key: "medicina",     keywords: /\b(doctor|physician|clinic|medic|hospital|family-?practice|urgent-?care)\b/i },
  { key: "abogado",      keywords: /\b(lawyer|attorney|law-?firm|law-?offic|legal-?services|paralegal)\b/i },
  { key: "fiscal",       keywords: /\b(accountant|cpa|tax-?prep|bookkeep|payroll)\b/i },
  { key: "notario",      keywords: /\bnotary\b/i },
  { key: "arquitecto",   keywords: /\barchitect\b/i },
  { key: "ingenieria",   keywords: /\b(engineer|engineering)\b/i },
  { key: "fontaneria",   keywords: /\b(plumb|drain|sewer|septic)\b/i },
  { key: "electricidad", keywords: /\belectric(ian|al)?\b/i },
  { key: "hvac",         keywords: /\b(hvac|heating|cooling|air-?conditioning|furnace|ductwork)\b/i },
  { key: "cerrajero",    keywords: /\b(locksmith|lock-?and-?key)\b/i },
  { key: "mecanica",     keywords: /\b(auto-?repair|mechanic|automotive|car-?repair|transmission|tire-?shop|body-?shop)\b/i },
  { key: "carpinteria",  keywords: /\b(carpent|woodwork|cabinetry|millwork)\b/i },
];

export const merchantCircleUsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_MC_US === "true";
  },
  async fetch() {
    return [];
  },
};

interface ParsedSlug {
  /** Slug minus the trailing "-<state>". */
  bizCitySlug: string;
  /** USPS 2-letter abbreviation, lowercase. */
  state: string;
  /** Best-effort city slug (last component before state). */
  cityHint: string;
  /** Best-effort category from keyword match, or null when ambiguous. */
  category: CategoryKey | null;
  /** Full URL. */
  url: string;
  /** Site path (used as part of sourceId). */
  pathId: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function envList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[mc-us] ${url} HTTP ${res.status}`);
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    console.warn(`[mc-us] ${url} fetch error: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const body = res.ok ? await res.text() : "";
    return { status: res.status, body };
  } catch {
    return { status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

function categorise(slug: string): CategoryKey | null {
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.test(slug)) return rule.key;
  }
  return null;
}

function parseSlug(url: string): ParsedSlug | null {
  // URL shape: https://www.merchantcircle.com/<slug>
  const m = url.match(/merchantcircle\.com\/([^/?#]+)/i);
  if (!m) return null;
  const pathId = m[1];
  // Trailing "-xx" where xx is state. Some slugs have numeric tails
  // like "-1" before state; we accept "<…>-<state>" with state being
  // the last 2 chars after the last hyphen.
  const lastDash = pathId.lastIndexOf("-");
  if (lastDash < 0) return null;
  const tail = pathId.slice(lastDash + 1).toLowerCase();
  if (!US_STATES.has(tail)) return null;
  const head = pathId.slice(0, lastDash);
  // City hint = last segment of head before the next dash group.
  // Heuristic: take the last hyphen-separated token as city (often
  // multi-word cities like "south-holland" collapse — accepted noise).
  const headLastDash = head.lastIndexOf("-");
  const cityHint =
    headLastDash >= 0 ? head.slice(headLastDash + 1) : head;
  return {
    url,
    pathId,
    bizCitySlug: head,
    state: tail,
    cityHint,
    category: categorise(pathId),
  };
}

function* iterateLocs(xml: string): IterableIterator<string> {
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  for (const m of xml.matchAll(re)) yield m[1];
}

function extractItemProp(html: string, prop: string): string | undefined {
  const re = new RegExp(
    `itemprop="${prop}"[^>]*>([\\s\\S]{1,300}?)<`,
    "i",
  );
  const m = html.match(re);
  if (!m) return undefined;
  return m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined;
}

function extractH1(html: string): string | undefined {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return undefined;
  return m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined;
}

function citySlugFromParsed(p: ParsedSlug, localityRaw: string | undefined): string {
  if (localityRaw) {
    return localityRaw
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  return p.cityHint;
}

async function loadSubSitemap(index: number): Promise<string[]> {
  const path =
    index === 0
      ? "business.xml.gz"
      : `business${index}.xml.gz`;
  const url = `https://www.merchantcircle.com/${path}`;
  const bytes = await fetchBytes(url);
  if (!bytes) return [];
  let xml: string;
  try {
    xml = Buffer.from(gunzipSync(bytes)).toString("utf8");
  } catch (e) {
    console.warn(`[mc-us] sitemap ${index} gunzip failed: ${(e as Error).message}`);
    return [];
  }
  return Array.from(iterateLocs(xml));
}

export async function runMerchantCircleUs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!merchantCircleUsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_MC_LIMIT ?? DEFAULT_LIMIT);
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const delayMs = Number(process.env.PROLIO_MC_DELAY_MS ?? DEFAULT_DELAY_MS);
  const max404 = Number(
    process.env.PROLIO_MC_MAX_404_STREAK ?? DEFAULT_404_STREAK,
  );
  const indicesRaw = envList(process.env.PROLIO_MC_SITEMAP_INDICES);
  const indices =
    indicesRaw.length > 0
      ? indicesRaw
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n) && n >= 0 && n < 897)
      : [0];
  const stateFilter = new Set(envList(process.env.PROLIO_MC_STATES));

  console.log(
    `[mc-us] config indices=${indices.join(",")} states=${stateFilter.size ? [...stateFilter].join(",") : "ALL"} cap=${cap} delay=${delayMs}ms`,
  );

  const records: ScrapedProfessional[] = [];
  const seenSourceIds = new Set<string>();
  let totalParsed = 0;
  let totalCandidates = 0;
  let totalFetched = 0;
  let total404 = 0;
  let totalSkippedCategory = 0;

  outer: for (const idx of indices) {
    if (records.length >= cap) break;
    console.log(`[mc-us] loading sub-sitemap ${idx}…`);
    const urls = await loadSubSitemap(idx);
    console.log(`[mc-us] sub-sitemap ${idx}: ${urls.length} URLs`);
    let consec404 = 0;

    for (const url of urls) {
      if (records.length >= cap) break outer;
      const parsed = parseSlug(url);
      if (!parsed) continue;
      totalParsed += 1;
      if (stateFilter.size > 0 && !stateFilter.has(parsed.state)) continue;
      if (!parsed.category) {
        totalSkippedCategory += 1;
        continue;
      }
      totalCandidates += 1;

      const sourceId = `mc:${parsed.pathId}`;
      if (seenSourceIds.has(sourceId)) continue;

      const { status, body } = await fetchText(url);
      totalFetched += 1;
      if (status === 404) {
        consec404 += 1;
        total404 += 1;
        if (consec404 >= max404) {
          console.warn(
            `[mc-us] sub-sitemap ${idx}: aborting after ${consec404} consecutive 404s`,
          );
          break;
        }
        continue;
      }
      consec404 = 0;
      if (status !== 200 || !body) {
        await delay(delayMs);
        continue;
      }

      const name = extractH1(body);
      if (!name) {
        await delay(delayMs);
        continue;
      }
      const phone = extractItemProp(body, "telephone");
      const street = extractItemProp(body, "streetAddress");
      const locality = extractItemProp(body, "addressLocality");
      const region = extractItemProp(body, "addressRegion");
      const postal = extractItemProp(body, "postalCode");
      const address = [street, locality, region, postal]
        .map((p) => (p ? p.replace(/,\s*$/, "") : ""))
        .filter(Boolean)
        .join(", ");

      seenSourceIds.add(sourceId);
      records.push(
        normalise({
          source: SOURCE_NAME,
          country: "US",
          sourceId,
          name,
          categoryKey: parsed.category,
          citySlug: citySlugFromParsed(parsed, locality),
          phone,
          address: address || undefined,
          metadata: {
            country: "US",
            state: (region ?? parsed.state).toUpperCase(),
            postal_code: postal ?? null,
            locality: locality ?? null,
            source_url: url,
            sitemap_index: idx,
            slug_state: parsed.state.toUpperCase(),
          },
        }),
      );
      await delay(delayMs);
    }
  }

  console.log(
    `[mc-us] stats: parsed=${totalParsed} candidates=${totalCandidates} fetched=${totalFetched} 404s=${total404} skippedCat=${totalSkippedCategory} records=${records.length}`,
  );

  if (records.length === 0) {
    console.warn(`[mc-us] no records emitted`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[mc-us] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
