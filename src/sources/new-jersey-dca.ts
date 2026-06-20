import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * New Jersey DCA — Division of Consumer Affairs (Professional Boards).
 *
 * The DCA publishes its *entire* professional-licensee database for free
 * as bulk "Standard" extract files in a public (no-auth) Box folder,
 * refreshed monthly:
 *
 *   https://app.box.com/v/DCAStandardFiles
 *
 * Four files are published each cycle; we use the one we need:
 *   - "Standard Individuals active statuses <MM-DD-YYYY>.txt"  ← THIS
 *   - "Standard Individuals all statuses with discipline …"
 *   - "Standard Facilities active statuses …"
 *   - "Standard Facilities all statuses with discipline …"
 *
 * The original scraper pointed at a fabricated CSV URL
 * (`njconsumeraffairs.gov/data/active_licensees.csv`, 404) and a CSV
 * column schema that doesn't exist → 0 rows. This rewrite targets the
 * real extract.
 *
 * File format (discovered 2026-06-19):
 *   - Delimiter is `%` (NOT comma/tab). First line is the raw Oracle
 *     SQL concat expression (a pseudo-header), so we skip it.
 *   - One row per (person, license). Field layout (0-indexed):
 *       0  PROFESSION_NAME      e.g. "Electrical Contractors", "HVACR"
 *       1  license type text    e.g. "Burglar Alarm License"
 *       2  LICENSE_NO           e.g. "34BA00005400"
 *       3  status text          "Active" (this file is active-only)
 *       4  ISSUE_DATE
 *       5  EXPIRATION_DATE
 *       6  DATE_LAST_RENEWAL
 *       7  license method
 *       8  IS_ORGANIZATION      "Y"/"N"
 *       9  FIRST_NAME
 *       10 MIDDLE_NAME
 *       11 LAST_NAME
 *       12 BUSINESS_NAME
 *       13 display name         e.g. "PETER F RAYMOND" / org name
 *       14 address line 1
 *       15 address line 2
 *       16 address line 3
 *       17 "City State Zip" combined
 *       18 CITY
 *       19 STATE  (mailing state — may be out-of-NJ; these are NJ licences)
 *       20 ZIP
 *       21 COUNTY
 *       …  remainder (country flag, email, phone) varies
 *
 * Pre-flight (2026-06-19):
 *   - Box direct-download endpoint returns HTTP 200, no auth, text/plain.
 *   - "Standard Individuals active statuses" = 296,626 rows (all Active).
 *   - Relevant professions present:
 *       Electrical Contractors (3,492) → electricidad
 *       Master Plumbers        (1,905) → fontaneria
 *       HVACR                  (1,707) → hvac
 *       Architecture           (3,128) → arquitecto
 *       Dentistry             (16,938) → dentista
 *       Physical Therapy       (5,358) → fisioterapia
 *       Veterinary Med Exam    (1,701) → veterinario
 *
 * The monthly filename embeds a rotating date AND the Box file_id
 * rotates each cycle, so we discover the current "Standard Individuals
 * active statuses" file_id at run time by scraping the public folder
 * page (the name prefix is stable). Override the whole download URL with
 * `PROLIO_NEW_JERSEY_DCA_URL` for testing.
 *
 * Off by default. Enable via `PROLIO_RUN_NEW_JERSEY_DCA=true`.
 * Cap via `PROLIO_NEW_JERSEY_DCA_LIMIT` (default 50000).
 */

const BOX_FOLDER_URL = "https://app.box.com/v/DCAStandardFiles";
const BOX_SHARED_NAME = "e35th49ha9h8t5fozvzu5ec6f1bx73yj";
const TARGET_FILE_PREFIX = "Standard Individuals active statuses";
const SOURCE_NAME = "new-jersey-dca" as const;
const DEFAULT_LIMIT = 50_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// Field indices in the `%`-delimited extract.
const F_PROFESSION = 0;
const F_LICENSE_NO = 2;
const F_STATUS = 3;
const F_EXPIRATION = 5;
const F_FIRST = 9;
const F_LAST = 11;
const F_BUSINESS = 12;
const F_DISPLAY_NAME = 13;
const F_ADDR1 = 14;
const F_CITY = 18;
const F_STATE = 19;
const F_ZIP = 20;

function professionToCategory(p: string): CategoryKey | undefined {
  const d = p.toLowerCase();
  if (d.includes("electric")) return "electricidad";
  if (d.includes("plumb")) return "fontaneria";
  if (
    d.includes("hvac") ||
    d.includes("mechanical") ||
    d.includes("air condition") ||
    d.includes("refrigerat") ||
    d.includes("heating")
  )
    return "hvac";
  if (d.includes("architect")) return "arquitecto";
  if (d.includes("dent")) return "dentista";
  if (d.includes("physical therap")) return "fisioterapia";
  if (d.includes("veterinar")) return "veterinario";
  return undefined;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Discover the current "Standard Individuals active statuses" file_id by
 * scraping the public Box folder page. The folder embeds each item's
 * name and numeric id adjacently in the prefetched page state; we match
 * the stable name prefix and pull the nearest id.
 */
async function resolveActiveIndividualsFileId(): Promise<string | null> {
  let html: string;
  try {
    const res = await fetch(BOX_FOLDER_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`[new-jersey-dca] Box folder HTTP ${res.status}`);
      return null;
    }
    html = await res.text();
  } catch (error) {
    console.error(
      `[new-jersey-dca] Box folder fetch error: ${(error as Error).message}`,
    );
    return null;
  }

  // Match: "name":"Standard Individuals active statuses …txt" then the
  // nearby numeric id (Box repeats name+id within ~200 chars).
  const nameRe = new RegExp(
    `"name"\\s*:\\s*"(${TARGET_FILE_PREFIX}[^"]*\\.txt)"`,
    "i",
  );
  const m = nameRe.exec(html);
  if (!m) {
    console.error(
      `[new-jersey-dca] could not locate "${TARGET_FILE_PREFIX}" in Box folder listing`,
    );
    return null;
  }
  // Search a window around the match for an id of >=10 digits.
  const start = Math.max(0, m.index - 250);
  const window = html.slice(start, m.index + m[0].length + 250);
  const idRe = /"(?:id|typedID|file_id)"\s*:\s*"?(?:f_)?(\d{10,})"?/g;
  let idMatch: RegExpExecArray | null;
  let fileId: string | null = null;
  while ((idMatch = idRe.exec(window)) !== null) {
    fileId = idMatch[1];
  }
  if (!fileId) {
    console.error(`[new-jersey-dca] found file name but no adjacent file_id`);
    return null;
  }
  console.log(
    `[new-jersey-dca] resolved active-individuals file: "${m[1]}" id=${fileId}`,
  );
  return fileId;
}

function buildDownloadUrl(fileId: string): string {
  return (
    `https://app.box.com/index.php?rm=box_download_shared_file` +
    `&shared_name=${BOX_SHARED_NAME}&file_id=f_${fileId}`
  );
}

function buildName(fields: string[]): string | undefined {
  const business = (fields[F_BUSINESS] ?? "").trim();
  if (business) return titleCase(business);
  const display = (fields[F_DISPLAY_NAME] ?? "").trim();
  if (display) return titleCase(display);
  const first = (fields[F_FIRST] ?? "").trim();
  const last = (fields[F_LAST] ?? "").trim();
  const joined = `${first} ${last}`.trim();
  return joined ? titleCase(joined) : undefined;
}

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
}

export async function runNewJerseyDcaIngest(
  client: SupabaseClient,
  opts: RunOptions = {},
): Promise<{ scanned: number; accepted: number; written: number }> {
  const batchSize = opts.batchSize ?? 500;
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const sink = getSink({ trustCitySlugs: true });
  let scanned = 0;
  let accepted = 0;
  let written = 0;
  let buffer: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const res = await sink.upsert(buffer);
    written += res.inserted + res.updated;
    buffer = [];
  };

  const override = process.env.PROLIO_NEW_JERSEY_DCA_URL;
  let url: string | null = override ?? null;
  if (!url) {
    const fileId = await resolveActiveIndividualsFileId();
    if (!fileId) {
      console.error(
        `[new-jersey-dca] aborting — could not resolve Box file id`,
      );
      return { scanned: 0, accepted: 0, written: 0 };
    }
    url = buildDownloadUrl(fileId);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/plain" },
      redirect: "follow",
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    console.error(`[new-jersey-dca] download error: ${(error as Error).message}`);
    return { scanned: 0, accepted: 0, written: 0 };
  }
  if (!response.ok) {
    console.error(`[new-jersey-dca] download HTTP ${response.status} on ${url}`);
    return { scanned: 0, accepted: 0, written: 0 };
  }

  const text = await response.text();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    if (accepted >= maxRows) break;
    const line = lines[i];
    if (!line.trim()) continue;
    // Skip the pseudo-header (the raw SQL concat expression on line 0).
    if (i === 0 && line.includes("PROFESSION_NAME")) continue;

    const fields = line.split("%");
    if (fields.length < F_ZIP + 1) continue;
    scanned += 1;

    const status = (fields[F_STATUS] ?? "").trim().toLowerCase();
    if (status && !status.includes("active")) continue;

    const category = professionToCategory(fields[F_PROFESSION] ?? "");
    if (!category) continue;

    const licence = (fields[F_LICENSE_NO] ?? "").trim();
    if (!licence) continue;

    const cityRaw = (fields[F_CITY] ?? "").trim();
    if (!cityRaw) continue;

    const stateRaw = (fields[F_STATE] ?? "").trim().toUpperCase() || "NJ";
    // City rows are keyed by (name,state); use the licensee's mailing
    // state so out-of-state NJ licensees still seed a correct city.
    const cityResult = await ensureCity(client, {
      name: titleCase(cityRaw),
      state: stateRaw,
      country: "US",
    });
    if (!cityResult) continue;

    const name = buildName(fields);
    if (!name) continue;

    const key = `${licence}:${category}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const street = (fields[F_ADDR1] ?? "").trim();
    const zip = (fields[F_ZIP] ?? "").trim();
    const address = [street, titleCase(cityRaw), stateRaw, zip]
      .filter(Boolean)
      .join(", ");

    buffer.push({
      source: SOURCE_NAME as ScrapeSource,
      sourceId: `new-jersey-dca:${licence}:${category}`,
      name,
      categoryKey: category,
      country: "US",
      citySlug: cityResult.slug,
      address: address || undefined,
      licenseNumber: licence,
      metadata: {
        country: "US",
        state: "NJ",
        authority: "New Jersey DCA",
        verified_by_authority: true,
        dca_profession: (fields[F_PROFESSION] ?? "").trim(),
        expiration_date: (fields[F_EXPIRATION] ?? "").trim() || undefined,
      },
    });
    accepted += 1;
    if (buffer.length >= batchSize) await flush();
  }
  await flush();

  const cs = getCityUpsertStats();
  console.log(
    `[new-jersey-dca] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

export const newJerseyDcaSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_NEW_JERSEY_DCA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNewJerseyDca(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!newJerseyDcaSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_NEW_JERSEY_DCA_LIMIT ?? DEFAULT_LIMIT);
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runNewJerseyDcaIngest(client, {
    maxRows,
  });
  return {
    fetched: accepted,
    inserted: written,
    updated: 0,
    skipped: scanned - accepted,
  };
}
