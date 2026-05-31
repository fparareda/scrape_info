import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * GPhC — General Pharmaceutical Council (UK).
 *
 * Public register of pharmacy professionals (pharmacists + pharmacy
 * technicians) at:
 *   https://www.pharmacyregulation.org/registers/pharmacist
 *
 * === Enumeration strategy ===
 *
 * The GPhC register search supports lookup by registration number via a
 * Drupal form (form_build_id, form_id). Each lookup requires a GET
 * (to obtain a fresh form_build_id) followed by a POST with the number.
 * The response is an HTML table row:
 *   Surname | Forename(s) | Reg No | Accredited | Status
 *
 * Registration numbers are sequential integers in the range
 * 2,040,000–2,250,000 with ~60-70% density (verified 2026-05-31):
 *   2040000 → Mortimer Fiona (Registered)
 *   2076603 → Smith James Alan (Registered)
 *   2221557 → Samaan Abanoub (Registered)
 *   gaps at 2046000, 2056000–2058000, etc.
 *
 * Full range ~210,000 numbers; at 1 GET+POST per number with a 2 s delay
 * this is ~5.8 days serial. We shard by a configurable window:
 *   PROLIO_GPHC_START  start of range (default 2040000)
 *   PROLIO_GPHC_END    end of range inclusive (default 2250000)
 *   PROLIO_GPHC_LIMIT  max records to collect (default 2000)
 * A weekly cron moves PROLIO_GPHC_START forward by the shard size;
 * 2000 hits × 2s ≈ 70 min per run. At ~60% density, 2000 records ≈
 * 3300 numbers scanned → advance start by 3500 each week.
 *
 * === Alternative name-search route ===
 *
 * The single-registrant search requires exact first+last name — no
 * prefix/wildcard support. Registration number is the only enumerable
 * axis available without Playwright or residential IP.
 *
 * === Why not the monthly XLSX ===
 *
 * GPhC publishes monthly aggregate statistics at
 *   /about-us/publications-and-insights/research-data-and-insights/gphc-registers-data
 * but the XLSX is a summary report (counts by demographics) — no
 * individual registrant data. Per-registrant bulk download requires a
 * paid data subscription.
 *
 * === Coverage ===
 *
 * ~86,000 active pharmacy professionals on the GPhC register as of 2026.
 * Both pharmacists (category=farmacia) and pharmacy technicians (same
 * category — closest match in the taxonomy) are included.
 *
 * Country: GB. Off by default — PROLIO_RUN_GPHC_UK=true.
 */

const REGISTER_URL =
  "https://www.pharmacyregulation.org/registers/pharmacist";
const FORM_ID = "register_search_pharmacist_form";
const CATEGORY: CategoryKey = "farmacia";
const DEFAULT_START = 2_040_000;
const DEFAULT_END = 2_250_000;
// Each lookup = 1 GET (Drupal form_build_id) + 1 POST + 2s delay ≈ 8s/record.
// First GHA run hit the 120min timeout at 1000 records. Cap at 800 to finish
// within ~105min (safe margin). Increase timeout to 180min for headroom.
const DEFAULT_LIMIT = 800;
const DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const gphcUkSource: ScraperSource = {
  name: "gphc-uk-pharmacists" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_GPHC_UK === "true";
  },
  async fetch() {
    return [];
  },
};

interface GphcRow {
  regno: number;
  surname: string;
  forename: string;
  accredited: boolean;
  status: string; // "Registered" | "Removed" | ...
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clean(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/See registration details/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetch the Drupal form page and return a fresh form_build_id. */
async function getFormBuildId(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTER_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/name="form_build_id"\s+value="([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Look up a single registration number. Returns null on network error. */
async function lookupRegno(
  formBuildId: string,
  regno: number,
): Promise<GphcRow | null | "miss"> {
  const body =
    `form_build_id=${encodeURIComponent(formBuildId)}` +
    `&form_id=${encodeURIComponent(FORM_ID)}` +
    `&type=registration_number` +
    `&regno=${regno}` +
    `&op=Search+by+registration+number`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTER_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: REGISTER_URL,
        Accept: "text/html",
      },
      body,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Parse the first <tr> in <tbody>
    const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    if (!tbody) return "miss";
    const rows = [...tbody[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    const dataRows = rows.filter((m) => /<td/i.test(m[1]));
    if (dataRows.length === 0) return "miss";
    const cells = [
      ...dataRows[0][1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi),
    ].map((c) => clean(c[1]));
    if (cells.length < 4) return "miss";
    // Column order: Surname | Forename(s) | Reg No | Accredited | Status
    return {
      regno,
      surname: cells[0] || "",
      forename: cells[1] || "",
      // cells[2] = registration number (matches regno, skip)
      accredited: /yes/i.test(cells[3] ?? ""),
      status: cells[4] || "",
    };
  } catch {
    return null; // transient network error
  } finally {
    clearTimeout(timer);
  }
}

function toRecord(row: GphcRow): ScrapedProfessional | null {
  if (!row.surname && !row.forename) return null;
  const name = [row.forename, row.surname].filter(Boolean).join(" ");
  return normalise({
    source: "gphc-uk-pharmacists" as ScrapeSource,
    country: "GB",
    sourceId: `gphc:${row.regno}`,
    name,
    categoryKey: CATEGORY,
    // GPhC register doesn't expose city in the basic lookup; default
    // to London as a proxy (city_slug=null would also be fine but the
    // sink currently validates city slugs).
    citySlug: "london",
    licenseNumber: String(row.regno),
    metadata: {
      country: "GB",
      authority: "GPhC",
      verified_by_authority: true,
      registration_number: row.regno,
      surname: row.surname || null,
      forename: row.forename || null,
      accredited_checker: row.accredited,
      status: row.status || null,
    },
  });
}

export async function runGphcUk(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!gphcUkSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawStart = Number(process.env.PROLIO_GPHC_START ?? DEFAULT_START);
  const rawEnd = Number(process.env.PROLIO_GPHC_END ?? DEFAULT_END);
  const rawLimit = Number(process.env.PROLIO_GPHC_LIMIT ?? DEFAULT_LIMIT);
  const start =
    Number.isFinite(rawStart) && rawStart > 0 ? rawStart : DEFAULT_START;
  const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : DEFAULT_END;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  console.log(
    `[gphc-uk] start=${start} end=${end} limit=${limit} ` +
      `range_size=${end - start} delay=${DELAY_MS}ms`,
  );

  const records: ScrapedProfessional[] = [];
  const seenSourceIds = new Set<string>();
  let scanned = 0;
  let misses = 0;
  let errors = 0;
  let formFetches = 0;
  let formBuildId: string | null = null;

  for (let regno = start; regno <= end && records.length < limit; regno++) {
    // Refresh form_build_id every request (Drupal tokens are single-use)
    formBuildId = await getFormBuildId();
    formFetches++;
    if (!formBuildId) {
      console.warn(`[gphc-uk] could not get form_build_id at regno=${regno}`);
      errors++;
      await delay(DELAY_MS);
      continue;
    }

    const result = await lookupRegno(formBuildId, regno);
    scanned++;

    if (result === null) {
      errors++;
      // Back off briefly on network error
      await delay(DELAY_MS * 2);
      continue;
    }
    if (result === "miss") {
      misses++;
      await delay(DELAY_MS);
      continue;
    }
    // Filter to active registrants only
    if (!/registered/i.test(result.status)) {
      misses++;
      await delay(DELAY_MS);
      continue;
    }

    const sourceId = `gphc:${result.regno}`;
    if (seenSourceIds.has(sourceId)) continue;
    seenSourceIds.add(sourceId);

    const rec = toRecord(result);
    if (rec) {
      records.push(rec);
      if (records.length % 100 === 0) {
        console.log(
          `[gphc-uk] progress: regno=${regno} records=${records.length} ` +
            `misses=${misses} errors=${errors}`,
        );
      }
    }
    await delay(DELAY_MS);
  }

  console.log(
    `[gphc-uk] scan complete: scanned=${scanned} records=${records.length} ` +
      `misses=${misses} errors=${errors} formFetches=${formFetches}`,
  );

  if (records.length === 0) {
    console.warn(`[gphc-uk] no records found`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[gphc-uk] done — fetched=${records.length} inserted=${inserted} ` +
      `updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
