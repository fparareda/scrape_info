/**
 * IRS FOIA — Active Enrolled Agents (US fiscal / tax professionals)
 *
 * Source: U.S. Internal Revenue Service, Freedom of Information Act disclosure.
 * URL:    https://www.irs.gov/tax-professionals/enrolled-agents/active-enrolled-agents-and-the-freedom-of-information-act
 * File:   https://www.irs.gov/pub/foia/active-ea-foia-listing-<month>-<year>.csv
 *
 * Pre-flight (2026-06-14):
 *   - robots.txt (www.irs.gov): No Disallow for /pub/ or /tax-professionals/ paths.
 *     The FOIA CSV download at /pub/foia/ is intentionally public per FOIA mandate.
 *   - File format: CSV with headers — "First Name", "Middle Name", "Last Name",
 *     "Address Line 1", "Address Line 2", "Address Line 3", "City", "State",
 *     "Country", "Zip" (plus empty columns). No auth, no CAPTCHA, no rate-limit.
 *   - Record count: ~87,000 active enrolled agents worldwide (majority US-based).
 *   - Update cadence: bi-annually (May/November typically).
 *   - CategoryKey: fiscal — Enrolled Agents (EAs) are federally licensed tax
 *     professionals authorised to represent taxpayers before the IRS. They are the
 *     closest US equivalent to the "asesor fiscal" / "gestor fiscal" role in ES/MX.
 *
 * URL strategy: The IRS does not publish a stable permanent URL for the CSV;
 * the filename encodes the publication month (e.g. "active-ea-foia-listing-may-2026.csv").
 * We probe a short list of candidate filenames (current + previous month) and fall
 * back to the most recent known good URL stored in PROLIO_IRS_EA_FOIA_URL env var.
 * This is more robust than scraping the IRS landing page.
 *
 * Off by default. Enabled via PROLIO_RUN_IRS_EA_FOIA=true.
 * Workflow: .github/workflows/scrape-irs-ea-foia.yml — 1st of month 06:00 UTC
 * (bi-annual updates; monthly poll catches any out-of-cycle refreshes).
 */

import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { createClient } from "@supabase/supabase-js";

const SOURCE_NAME = "irs-ea-foia" as const;
const CATEGORY: CategoryKey = "fiscal";
const REQUEST_TIMEOUT_MS = 120_000; // CSV can be several MB
const BATCH_SIZE = 500;

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// --- URL resolution -------------------------------------------------------

/**
 * Build a list of candidate FOIA CSV URLs to try, in preference order.
 * The IRS encodes the publication month in the filename.
 * We try the current month, then the previous two months.
 */
function buildCandidateUrls(): string[] {
  const override = process.env.PROLIO_IRS_EA_FOIA_URL;
  if (override) return [override];

  const now = new Date();
  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];

  const candidates: string[] = [];
  for (let delta = 0; delta <= 6; delta += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - delta, 1);
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    candidates.push(
      `https://www.irs.gov/pub/foia/active-ea-foia-listing-${month}-${year}.csv`,
    );
  }
  return candidates;
}

// --- CSV parsing ----------------------------------------------------------

interface EaRow {
  firstName: string;
  lastName: string;
  address: string | undefined;
  city: string | undefined;
  state: string | undefined;
  country: string | undefined;
  zip: string | undefined;
}

/**
 * Minimal RFC-4180-compatible CSV parser (handles quoted fields with commas).
 * Returns the parsed rows as arrays of strings (empty string for missing cells).
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      let value = "";
      i += 1; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (line[i] === '"') {
          i += 1; // skip closing quote
          break;
        } else {
          value += line[i];
          i += 1;
        }
      }
      cells.push(value);
      if (line[i] === ",") i += 1;
    } else {
      const end = line.indexOf(",", i);
      if (end < 0) {
        cells.push(line.slice(i).trim());
        break;
      }
      cells.push(line.slice(i, end).trim());
      i = end + 1;
    }
  }
  return cells;
}

function parseEaCsv(text: string): EaRow[] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];

  // Find header row (first non-empty line)
  let headerIdx = 0;
  while (headerIdx < lines.length && !lines[headerIdx]?.trim()) headerIdx += 1;
  const header = parseCsvLine(lines[headerIdx] ?? "").map((h) =>
    h.toLowerCase().replace(/\s+/g, "_"),
  );

  // Column index helpers
  const col = (names: string[]): number => {
    for (const n of names) {
      const idx = header.indexOf(n);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const idxFirst = col(["first_name", "first"]);
  const idxLast = col(["last_name", "last"]);
  const idxAddr1 = col(["address_line_1", "address"]);
  const idxAddr2 = col(["address_line_2"]);
  const idxAddr3 = col(["address_line_3"]);
  const idxCity = col(["city"]);
  const idxState = col(["state"]);
  const idxCountry = col(["country"]);
  const idxZip = col(["zip", "zipcode", "postal_code"]);

  const rows: EaRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const cells = parseCsvLine(line);

    const firstName = idxFirst >= 0 ? (cells[idxFirst] ?? "").trim() : "";
    const lastName = idxLast >= 0 ? (cells[idxLast] ?? "").trim() : "";
    if (!firstName && !lastName) continue;
    // Skip rows where the "last name" field holds a single period — those
    // are entries with no actual last name parsed (common for non-ASCII names).
    if (lastName === ".") continue;

    const addr1 = idxAddr1 >= 0 ? (cells[idxAddr1] ?? "").trim() : "";
    const addr2 = idxAddr2 >= 0 ? (cells[idxAddr2] ?? "").trim() : "";
    const addr3 = idxAddr3 >= 0 ? (cells[idxAddr3] ?? "").trim() : "";
    const addrParts = [addr1, addr2, addr3].filter((p) => p.length > 0);

    rows.push({
      firstName,
      lastName,
      address: addrParts.length > 0 ? addrParts.join(", ") : undefined,
      city: idxCity >= 0 ? (cells[idxCity] ?? "").trim() || undefined : undefined,
      state: idxState >= 0 ? (cells[idxState] ?? "").trim() || undefined : undefined,
      country: idxCountry >= 0 ? (cells[idxCountry] ?? "").trim() || undefined : undefined,
      zip: idxZip >= 0 ? (cells[idxZip] ?? "").trim() || undefined : undefined,
    });
  }
  return rows;
}

// --- City-slug loader (US only) -------------------------------------------

async function loadUsCitySlugs(): Promise<Set<string>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Set();
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const slugs = new Set<string>();
  for (let from = 0; from < 20_000; from += 1000) {
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

// --- HTTP fetch with retries -----------------------------------------------

async function fetchCsv(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/csv,text/plain,*/*",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// --- Source export ---------------------------------------------------------

export const irsEaFoiaSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_IRS_EA_FOIA === "true";
  },
  async fetch() {
    return [];
  },
};

export interface IrsEaFoiaRunSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  usOnly: number;
  international: number;
}

export async function runIrsEaFoia(): Promise<IrsEaFoiaRunSummary | null> {
  if (!irsEaFoiaSource.enabled()) return null;

  const limitRaw = Number(process.env.PROLIO_IRS_EA_FOIA_LIMIT ?? 100_000);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100_000;

  const validCitySlugs = await loadUsCitySlugs();
  if (validCitySlugs.size === 0) {
    console.warn(`[${SOURCE_NAME}] no US cities seeded — skipping`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0, usOnly: 0, international: 0 };
  }
  console.log(`[${SOURCE_NAME}] loaded ${validCitySlugs.size} US city slugs`);

  // Try candidate URLs in order until one returns a valid CSV.
  const candidates = buildCandidateUrls();
  let csvText: string | null = null;
  let resolvedUrl: string | undefined;
  for (const url of candidates) {
    console.log(`[${SOURCE_NAME}] trying ${url}`);
    csvText = await fetchCsv(url);
    if (csvText && csvText.length > 1000 && csvText.toLowerCase().includes("first")) {
      resolvedUrl = url;
      console.log(`[${SOURCE_NAME}] found CSV at ${url} (${csvText.length} bytes)`);
      break;
    }
    csvText = null;
  }

  if (!csvText) {
    console.error(
      `[${SOURCE_NAME}] could not fetch FOIA CSV from any candidate URL. ` +
        `Set PROLIO_IRS_EA_FOIA_URL to override.`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0, usOnly: 0, international: 0 };
  }

  const rows = parseEaCsv(csvText);
  console.log(`[${SOURCE_NAME}] parsed ${rows.length} rows from CSV`);

  const sink = getSink();
  const batch: ScrapedProfessional[] = [];
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let usOnly = 0;
  let international = 0;
  let processed = 0;

  for (const row of rows) {
    if (processed >= limit) break;

    // Filter to US-based EAs only — we skip rows without a US state.
    // International EAs can be licensed to practice before the IRS but
    // are not useful for our US directory.
    const country = (row.country ?? "").toLowerCase();
    const isUs =
      !country ||
      country === "united states" ||
      country === "us" ||
      country === "usa" ||
      // Rows with a valid 2-letter US state code and no country field
      (country === "" && /^[A-Z]{2}$/.test(row.state ?? ""));
    if (!isUs) {
      international += 1;
      continue;
    }

    // Resolve city slug — we require a match to prevent phantom cities.
    const cityRaw = row.city ?? "";
    const citySlug = cityRaw ? slugify(cityRaw) : "";
    if (!citySlug || !validCitySlugs.has(citySlug)) continue;

    // Build a stable sourceId from name + state + zip (the FOIA file has no ID column).
    const namePart = `${row.lastName}:${row.firstName}`.toLowerCase().replace(/[^a-z0-9:]/g, "");
    const statePart = (row.state ?? "").toLowerCase();
    const zipPart = (row.zip ?? "").replace(/[^0-9]/g, "").slice(0, 5);
    const sourceId = `ea:${namePart}:${statePart}:${zipPart}`;

    const fullName = `${row.firstName} ${row.lastName}`.replace(/\s+/g, " ").trim();
    if (!fullName || fullName.length < 2) continue;

    // Build address string
    const addressParts: string[] = [];
    if (row.address) addressParts.push(row.address);
    if (cityRaw) addressParts.push(cityRaw);
    if (row.state) addressParts.push(row.state);
    if (row.zip) addressParts.push(row.zip);

    batch.push(
      normalise({
        source: SOURCE_NAME,
        country: "US",
        sourceId,
        name: fullName,
        categoryKey: CATEGORY,
        citySlug,
        address: addressParts.join(", ") || undefined,
        metadata: {
          state: row.state,
          zip: row.zip,
          foia_url: resolvedUrl,
          credential: "Enrolled Agent (EA)",
        },
      }),
    );
    usOnly += 1;
    processed += 1;

    if (batch.length >= BATCH_SIZE) {
      const { inserted, updated, skipped } = await sink.upsert(batch);
      totalInserted += inserted;
      totalUpdated += updated;
      totalSkipped += skipped;
      batch.length = 0;
    }
  }

  if (batch.length > 0) {
    const { inserted, updated, skipped } = await sink.upsert(batch);
    totalInserted += inserted;
    totalUpdated += updated;
    totalSkipped += skipped;
  }

  console.log(
    `[${SOURCE_NAME}] done — parsed=${rows.length} us=${usOnly} ` +
      `international=${international} ` +
      `inserted=${totalInserted} updated=${totalUpdated} skipped=${totalSkipped}`,
  );

  return {
    fetched: usOnly,
    inserted: totalInserted,
    updated: totalUpdated,
    skipped: totalSkipped,
    usOnly,
    international,
  };
}
