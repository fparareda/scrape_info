/**
 * Law Society of Manitoba — public lawyer lookup.
 *
 * Pre-flight (2026-06-16):
 *   Portal endpoint action.php returns rendered HTML without any auth.
 *   robots.txt at portal.lawsociety.mb.ca returns 404 (all paths allowed
 *   per RFC 9309); lawsociety.mb.ca only blocks /wp-admin/ /wp-login.php.
 *   reCAPTCHA v3 fires asynchronously client-side AFTER data is returned
 *   and would only overwrite the results div if rowcount > 25 AND the JS
 *   reCAPTCHA score is low — does not apply to direct API calls.
 *   ~3,000–4,000 "Practising" lawyers in MB. Winnipeg query returns 2,257.
 *
 * Strategy: iterate last-name letter prefixes a–z, page at 15/page,
 * deduplicate by name+callDate composite key. Filter to "Practising" only.
 *
 * CategoryKey: abogado (Manitoba has zero abogado coverage).
 * Off by default. Enable via PROLIO_RUN_LSM_LAWYERS_MB=true.
 * Cap via PROLIO_LSM_LAWYERS_MB_LIMIT (default 5000).
 * Monthly cadence via .github/workflows/scrape-lsm-lawyers-mb.yml.
 */

import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

const BASE =
  process.env.PROLIO_LSM_LAWYERS_MB_BASE ||
  "https://portal.lawsociety.mb.ca/lookup/action.php";
const SOURCE_NAME = "lsm-lawyers-mb" as const;
const DEFAULT_LIMIT = 5_000;
const PAGE_SIZE = 15;
const REQUEST_DELAY_MS = 1_200;
const MAX_PAGES_PER_PREFIX = 100;
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

// Manitoba city name → city slug mapping.
const MB_CITY_SLUGS: Record<string, string> = {
  winnipeg: "winnipeg",
  brandon: "brandon",
  steinbach: "steinbach",
  thompson: "thompson",
  "portage la prairie": "portage-la-prairie",
  selkirk: "selkirk",
  morden: "morden",
  winkler: "winkler",
  "flin flon": "flin-flon",
  "the pas": "the-pas",
  dauphin: "dauphin",
  "st. boniface": "winnipeg",
  "saint boniface": "winnipeg",
};

function mapCity(raw: string): string {
  if (!raw) return "winnipeg";
  const key = raw.toLowerCase().trim();
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return MB_CITY_SLUGS[key] ?? (slug || "winnipeg");
}

interface LsmRecord {
  name: string;
  callDate: string;
  city: string;
  address?: string;
  phone?: string;
  email?: string;
  status: string;
}

// Decode common HTML entities.
function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the total match count from the HTML fragment.
 * Looks for: <span id="rc">N</span>
 */
function parseCount(html: string): number {
  const m = /<span[^>]*id="rc"[^>]*>(\d+)<\/span>/i.exec(html);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Parse lawyer rows from the HTML fragment returned by action.php.
 * Each row is a <td> block containing name in <strong>, then address
 * lines, phone, email, firm, status and call date.
 */
function parseRows(html: string): LsmRecord[] {
  const records: LsmRecord[] = [];

  // Find all <td> blocks that contain a <strong> (lawyer name).
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let tdMatch: RegExpExecArray | null;
  while ((tdMatch = tdRe.exec(html)) !== null) {
    const cell = tdMatch[1];
    // Name must be in a <strong> tag in format "LAST, FIRST".
    const nameM = /<strong[^>]*>([^<]+)<\/strong>/i.exec(cell);
    if (!nameM) continue;
    const rawName = decodeHtml(nameM[1]);
    // Expect "LAST, FIRST [MIDDLE]" format.
    if (!rawName.includes(",")) continue;

    // Extract status: look for "Practising" or "Non-practising".
    const statusM = /\b(Practising|Non-practising)\b/i.exec(cell);
    const status = statusM ? statusM[1] : "";
    if (!status || status.toLowerCase() === "non-practising") continue;

    // Extract call date.
    const callM = /[Cc]all\s*[Dd]ate[:\s]+(\d{4}-\d{2}-\d{2})/i.exec(cell);
    const callDate = callM ? callM[1] : "";

    // Extract city from address. The address is typically:
    // "Street<br>City, MB, Postal" or "Street\nCity, MB, Postal"
    // Strip HTML tags to get plain text for address parsing.
    const plain = cell
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Find "City, MB" pattern in the plain text.
    const cityM = /([A-Za-z\s.'-]+),\s*MB\b/.exec(plain);
    const city = cityM ? cityM[1].trim() : "Winnipeg";

    // Extract phone.
    const phoneM =
      /(?:Phone|Tel)[:\s]+\(?([\d]{3})\)?[-.\s]?([\d]{3})[-.\s]?([\d]{4})/i.exec(
        plain,
      );
    const phone = phoneM
      ? `+1${phoneM[1]}${phoneM[2]}${phoneM[3]}`
      : undefined;

    // Extract email.
    const emailM = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.exec(plain);
    const email = emailM ? emailM[0].toLowerCase() : undefined;

    // Reconstruct address from plain text (first 2-3 lines before City).
    const lines = plain.split("\n").map((l) => l.trim()).filter(Boolean);
    const cityLineIdx = lines.findIndex((l) =>
      /,\s*MB\b/.test(l),
    );
    const streetLines =
      cityLineIdx > 0 ? lines.slice(0, cityLineIdx) : [];
    const address =
      streetLines.length > 0 ? streetLines.join(", ") : undefined;

    records.push({
      name: rawName,
      callDate,
      city,
      address,
      phone,
      email,
      status,
    });
  }
  return records;
}

function formatName(raw: string): string {
  // "LAST, FIRST MIDDLE" → "First Middle Last"
  const commaIdx = raw.indexOf(",");
  if (commaIdx < 0) return toTitleCase(raw);
  const last = raw.slice(0, commaIdx).trim();
  const rest = raw.slice(commaIdx + 1).trim();
  return toTitleCase(`${rest} ${last}`);
}

async function fetchPage(
  query: string,
  page: number,
): Promise<{ html: string; status: number } | null> {
  const url = new URL(BASE);
  url.searchParams.set("query", query);
  url.searchParams.set("sort", "contact");
  url.searchParams.set("dir", "1");
  url.searchParams.set("page", String(page));
  url.searchParams.set("rp", String(PAGE_SIZE));

  for (const ua of [POLITE_UA, FALLBACK_UA]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(url.toString(), {
        headers: { "User-Agent": ua, Accept: "text/html" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 503) {
        if (ua === POLITE_UA) continue;
        return { html: "", status: res.status };
      }
      if (!res.ok) return { html: "", status: res.status };
      const html = await res.text();
      return { html, status: res.status };
    } catch (err) {
      clearTimeout(timer);
      console.warn(
        `[lsm-lawyers-mb] fetch error (ua=${ua.slice(0, 20)}): ${(err as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  // Deduplicate by "name:callDate" composite key.
  const seen = new Set<string>();
  let droppedNoPractising = 0;

  for (const letter of LETTERS) {
    if (out.length >= limit) break;

    for (let page = 1; page <= MAX_PAGES_PER_PREFIX; page += 1) {
      if (out.length >= limit) break;

      const resp = await fetchPage(letter, page);
      await delay(REQUEST_DELAY_MS);

      if (!resp || !resp.html) {
        console.warn(
          `[lsm-lawyers-mb] letter=${letter} page=${page} fetch failed`,
        );
        break;
      }

      // On page 1, check total count; break early if none.
      if (page === 1) {
        const count = parseCount(resp.html);
        if (count === 0) break;
      }

      const rows = parseRows(resp.html);
      if (rows.length === 0) break;

      let addedThisPage = 0;
      for (const row of rows) {
        if (out.length >= limit) break;

        const key = `${row.name}:${row.callDate}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const citySlug = mapCity(row.city);
        const name = formatName(row.name);
        if (!name) continue;

        out.push(
          normalise({
            source: SOURCE_NAME,
            country: "CA",
            sourceId: `lsm-lawyers-mb:${row.name.slice(0, 30).replace(/[^a-z0-9]/gi, "-")}:${row.callDate}`,
            name,
            categoryKey: "abogado",
            citySlug,
            phone: row.phone,
            email: row.email,
            address: row.address,
            licenseNumber: row.callDate || undefined,
            metadata: {
              province: "MB",
              country: "CA",
              authority: "Law Society of Manitoba",
              verified_by_authority: true,
              bar_status: row.status,
              call_date: row.callDate || undefined,
            },
          }),
        );
        addedThisPage += 1;
      }

      if (addedThisPage === 0 && rows.length > 0) break;
      if (rows.length < PAGE_SIZE) break;
    }
  }

  console.log(
    `[lsm-lawyers-mb] parsed=${out.length} droppedNoPractising=${droppedNoPractising}`,
  );
  return out;
}

export const lsmLawyersMbSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_LSM_LAWYERS_MB === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runLsmLawyersMb(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
} | null> {
  if (!lsmLawyersMbSource.enabled()) return null;

  const rawLimit = Number(
    process.env.PROLIO_LSM_LAWYERS_MB_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[lsm-lawyers-mb] done — fetched=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
