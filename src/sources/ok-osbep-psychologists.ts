import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { normaliseNorthAmericanPhone } from "./_bulk-utils.js";

/**
 * Oklahoma State Board of Examiners of Psychologists (OSBEP).
 *
 * Public licensee search at pay.apps.ok.gov/OSBEP/_app/search/index.php.
 * A single HTTP POST with blank fields returns all ~1,200 licensed
 * psychologists (611 active, 1,203 all statuses as of 2026-06-01) as a
 * plain HTML table. No pagination, no JS-SPA, no Cloudflare, no CAPTCHA.
 * robots.txt returns 404 on this host — no crawl restrictions.
 *
 * Columns: Last Name | First Name | City | State | ZIP | Phone |
 *          License # | Status | Issue Date | Specialty
 *
 * Off by default. Enable via `PROLIO_RUN_OK_OSBEP_PSYCHOLOGISTS=true`.
 * Override record cap via `PROLIO_OK_OSBEP_PSYCHOLOGISTS_LIMIT`.
 *
 * Pre-flight verified 2026-06-01.
 */

const SEARCH_URL =
  "https://pay.apps.ok.gov/OSBEP/_app/search/index.php";
const DEFAULT_LIMIT = 2000;
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;

/** Fetch with polite UA; retry once with browser UA on 403/503. */
async function politeFetch(
  url: string,
  body: string,
): Promise<{ status: number; text: string } | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        body,
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[ok-osbep] host blocked polite UA (${response.status}); retrying with browser UA`,
          );
          continue;
        }
        return { status: response.status, text: "" };
      }
      if (!response.ok) return { status: response.status, text: "" };
      const text = await response.text();
      return { status: response.status, text };
    } catch (error) {
      clearTimeout(timer);
      const msg = (error as Error).message ?? String(error);
      console.warn(`[ok-osbep] network error: ${msg}`);
      return null;
    }
  }
  return null;
}

/**
 * Parse the HTML table returned by the OSBEP search page.
 *
 * The table has these columns (0-indexed):
 *   0: Last Name (contains <a href="psychologist.php?id=N">)
 *   1: First Name
 *   2: City
 *   3: State
 *   4: ZIP
 *   5: Phone
 *   6: License #
 *   7: Status
 *   8: Issue Date
 *   9: Specialty
 */
async function parseTable(
  client: SupabaseClient,
  html: string,
): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  // Match each <tr> that contains <td> cells
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const idRe = /psychologist\.php\?id=(\d+)/i;
  const tagRe = /<[^>]+>/g;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1].replace(tagRe, "").trim());
    }
    if (cells.length < 8) continue;

    const lastName = cells[0] ?? "";
    const firstName = cells[1] ?? "";
    const city = cells[2] ?? "";
    const stateCode = cells[3] ?? "OK";
    const zip = cells[4] ?? "";
    const phoneRaw = cells[5] ?? "";
    const licenseNum = cells[6] ?? "";
    const status = cells[7] ?? "";
    const issueDate = cells[8] ?? "";
    const specialty = cells[9] ?? "";

    if (!lastName || !licenseNum) continue;
    // Skip header rows (no license number looks like digits)
    if (!/^\d+$/.test(licenseNum.trim())) continue;

    // Extract the record id from the first cell's link
    const idMatch = idRe.exec(rowMatch[1]);
    const recordId = idMatch ? idMatch[1] : licenseNum;

    const sourceId = `ok-osbep:${recordId}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    if (!fullName) continue;

    // Auto-seed the city by NAME (OK municipalities are not all pre-seeded).
    // When there is no city, emit citySlug:"" so the sink keeps the row with
    // a NULL city instead of dropping it.
    let citySlug = "";
    if (city) {
      const cityResult = await ensureCity(client, {
        name: city,
        state: stateCode || "OK",
        country: "US",
      });
      if (cityResult) citySlug = cityResult.slug;
    }

    const phone = normaliseNorthAmericanPhone(phoneRaw);
    const address = [city, stateCode, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "ok-osbep-psychologists",
        country: "US",
        sourceId,
        name: fullName,
        categoryKey: "psicologia",
        citySlug,
        phone,
        address: address || undefined,
        licenseNumber: licenseNum || undefined,
        metadata: {
          country: "US",
          state: "OK",
          authority: "Oklahoma State Board of Examiners of Psychologists",
          verified_by_authority: true,
          license_status: status,
          issue_date: issueDate,
          specialty,
          record_id: recordId,
        },
      }),
    );
  }

  return out;
}

async function fetchAll(
  client: SupabaseClient,
  limit: number,
): Promise<ScrapedProfessional[]> {
  const formBody = new URLSearchParams({
    LAST_NAME: "",
    FIRST_NAME: "",
    CITY: "",
    STATE: "",
    ZIP: "",
    LICENSE_NUM: "",
    STATUS_ID: "", // blank = all statuses
    ISSUEDATE_FROM: "",
    ISSUEDATE_TO: "",
    button: "Search",
  }).toString();

  const result = await politeFetch(SEARCH_URL, formBody);
  if (!result || !result.text) {
    console.error(
      `[ok-osbep] fetch failed (status=${result?.status ?? "network"})`,
    );
    return [];
  }
  if (!result.text.includes("psychologist.php")) {
    console.error(
      `[ok-osbep] unexpected response — no psychologist records found`,
    );
    return [];
  }

  const records = await parseTable(client, result.text);
  const capped = records.slice(0, limit);
  const cs = getCityUpsertStats();
  console.log(
    `[ok-osbep] parsed=${records.length} capped=${capped.length} limit=${limit} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return capped;
}

export const okOsbepPsychologistsSource: ScraperSource = {
  name: "ok-osbep-psychologists",
  enabled() {
    return process.env.PROLIO_RUN_OK_OSBEP_PSYCHOLOGISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOkOsbepPsychologists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!okOsbepPsychologistsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_OK_OSBEP_PSYCHOLOGISTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const client = getSupabaseClient();
  const records = await fetchAll(client, limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink({ trustCitySlugs: true });
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[ok-osbep] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
