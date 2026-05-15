import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * SVMA — Saskatchewan Veterinary Medical Association.
 *
 * Public register at:
 *   https://svma.sk.ca/resources/find-a-svma-veterinary-professional-2/
 *
 * Pre-flight 2026-05-15:
 *   • robots.txt: Disallow: [empty] — fully open.
 *   • Format: WordPress + TablePress plugin. The entire register is
 *     server-rendered into a single <table id="tablepress-1"> element;
 *     no JS required, no pagination. One GET returns all 1,818 rows
 *     (April 30, 2026 snapshot).
 *   • Columns: Registration Category | License/Registration Type |
 *     First Name | Last Name | Expiration Date | Restrictions & Notices
 *   • No per-record city data — all registrants are province-wide
 *     Saskatchewan. We anchor every row to `saskatoon` (provincial
 *     capital) so the records appear in the SK metro; downstream
 *     Google Places enrichment can refine to actual clinic city.
 *   • Auth/WAF: none detected.
 *
 * Off by default; `PROLIO_RUN_SVMA_SK_VETS=true` to enable.
 * Cap via `PROLIO_SVMA_SK_VETS_LIMIT` (default 2000).
 */

const SOURCE_URL =
  "https://svma.sk.ca/resources/find-a-svma-veterinary-professional-2/";
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 2000;
const CATEGORY: CategoryKey = "veterinario";
const DEFAULT_CITY_SLUG = "saskatoon";

// Regex to match data rows in the TablePress table.
// Matches: <tr class="row-N"><td ...>col1</td><td>col2</td>...<td>col6</td></tr>
const ROW_RE =
  /<tr class="row-\d+">\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/g;

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

interface SvmaRow {
  category: string;
  licenseType: string;
  firstName: string;
  lastName: string;
  expirationDate: string;
  restrictions: string;
}

async function fetchPage(): Promise<string | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(SOURCE_URL, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "en-CA,en;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[svma-sk-vets] blocked by host (${response.status}); retrying with Chrome UA`,
          );
          continue;
        }
        console.warn(`[svma-sk-vets] fetch failed with status ${response.status}`);
        return null;
      }
      if (!response.ok) {
        console.warn(`[svma-sk-vets] HTTP ${response.status} — aborting`);
        return null;
      }
      return await response.text();
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[svma-sk-vets] network error: ${(err as Error).message}`);
      return null;
    }
  }
  return null;
}

function parseRows(html: string): SvmaRow[] {
  const rows: SvmaRow[] = [];
  ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(html)) !== null) {
    const [, cat, licType, firstName, lastName, expiry, restrictions] = m;
    const first = decodeHtml(firstName ?? "");
    const last = decodeHtml(lastName ?? "");
    if (!first && !last) continue;
    rows.push({
      category: decodeHtml(cat ?? ""),
      licenseType: decodeHtml(licType ?? ""),
      firstName: first,
      lastName: last,
      expirationDate: decodeHtml(expiry ?? ""),
      restrictions: decodeHtml(restrictions ?? ""),
    });
  }
  return rows;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const html = await fetchPage();
  if (!html) return [];

  if (!html.includes("tablepress")) {
    console.warn("[svma-sk-vets] tablepress table not found in response — page may have changed");
    return [];
  }

  const rows = parseRows(html);
  console.log(`[svma-sk-vets] parsed ${rows.length} rows from HTML table`);

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
    if (!name) continue;

    // Build a stable source ID from name + license type (no numeric ID in source)
    const rawId = `${row.firstName.toLowerCase()}:${row.lastName.toLowerCase()}:${row.licenseType.toLowerCase()}`;
    const sourceId = `svma-sk-vets:${rawId}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    out.push(
      normalise({
        source: "svma-sk-vets" as ScrapeSource,
        sourceId,
        name,
        categoryKey: CATEGORY,
        citySlug: DEFAULT_CITY_SLUG,
        metadata: {
          country: "CA",
          province: "SK",
          authority: "SVMA",
          verified_by_authority: true,
          registration_category: row.category || undefined,
          license_type: row.licenseType || undefined,
          expiration_date: row.expirationDate || undefined,
          restrictions: row.restrictions || undefined,
        },
      }),
    );
  }
  return out;
}

export const svmaSkVetsSource: ScraperSource = {
  name: "svma-sk-vets" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_SVMA_SK_VETS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runSvmaSkVets(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!svmaSkVetsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_SVMA_SK_VETS_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const records = await fetchAll(cap);
  if (records.length === 0) {
    console.warn("[svma-sk-vets] no rows fetched — source page may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[svma-sk-vets] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
