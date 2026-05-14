import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * Florida Department of Health — Medical Quality Assurance (MQA).
 *
 * Public health-provider verification at
 * https://mqa-internet.doh.state.fl.us/MQASearchServices/Healthcareproviders
 *
 * Pre-flight (2026-05-14):
 *   robots.txt    — host serves no restrictive directives for this path.
 *   Form          — ASP.NET MVC, POST + __RequestVerificationToken for
 *                   interactive search, but the result-set has a public
 *                   "Export" CSV endpoint that is a plain GET with the
 *                   search criteria encoded in `?jsonModel=…`. Neither
 *                   the verification token nor a session cookie is
 *                   required for the export GET (probed cold; HTTP 200
 *                   with 2 MB+ CSV payload).
 *   No CAPTCHA, no JS requirement, no rate-limit headers.
 *
 * Probe yields (single-shot per profession, Active+Inactive both
 * returned; we filter to Active client-side):
 *   1501 Medical Doctor        ~172,000 rows
 *    701 Dentist                ~29,000 rows
 *   (others scale similarly; expected ~700k total across the wave below)
 *
 * Endpoint:
 *   GET https://mqa-internet.doh.state.fl.us/MQASearchServices/
 *       Healthcareproviders/ExportToCsvLVP?jsonModel={URL-encoded JSON}
 *
 *   The JSON body matches `SearchDto`:
 *     { Profession: "<code>", LicenseStatus: "A" }
 *
 *   `LicenseStatus=A` is the server-side filter for active, but the
 *   server occasionally returns Inactive rows even with the filter
 *   set — we keep the redundant client filter on the CSV's
 *   "License Status" column ("Clear/Active") for safety.
 *
 * Polite rate-limiting: REQUEST_DELAY_MS=1100 between profession
 * fetches. Each profession is one big CSV (no per-page paging) so the
 * burst budget is ~1 CSV/sec ≤ 12 requests/full run.
 *
 * Category mapping: profession code → Prolio CategoryKey. Codes that
 * don't map cleanly (e.g. radiation, behaviour analyst, telehealth
 * out-of-state) are skipped.
 *
 * Off by default. `PROLIO_RUN_FL_DOH_MQA=true` to enable. Cap via
 * `PROLIO_FL_DOH_MQA_LIMIT` (default 20000 rows total across all
 * professions). Cron: monthly day 26 (renewals are biennial; data
 * changes slowly).
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_DELAY_MS = 1_100;
const DEFAULT_LIMIT = 20_000;

const EXPORT_BASE =
  "https://mqa-internet.doh.state.fl.us/MQASearchServices/Healthcareproviders/ExportToCsvLVP";

// --- Profession code → CategoryKey -----------------------------------

interface ProfessionEntry {
  code: string;
  label: string;
  category: CategoryKey;
}

/**
 * Curated subset of FL DOH profession codes that map to Prolio
 * categories. Each is a primary, in-state licence type — telehealth /
 * out-of-state variants are intentionally excluded to avoid
 * double-counting practitioners who hold both.
 */
const PROFESSIONS: readonly ProfessionEntry[] = [
  // Board of Medicine (15)
  { code: "1501", label: "Medical Doctor",          category: "medicina" },
  { code: "1901", label: "Osteopathic Physician",   category: "medicina" },
  { code: "3201", label: "Licensed Midwife",        category: "medicina" },
  // Board of Dentistry (07)
  { code: "701",  label: "Dentist",                 category: "dentista" },
  // Board of Physical Therapy Practice (55)
  { code: "5501", label: "Physical Therapist",      category: "fisioterapia" },
  // Board of Psychology (27) / School Psychology (41)
  { code: "2701", label: "Psychologist",            category: "psicologia" },
  { code: "4101", label: "School Psychologist",     category: "psicologia" },
  // Board of Nursing (17) — RN / LPN / APRN bucketed under medicina
  { code: "1701", label: "Registered Nurse",        category: "medicina" },
  { code: "1702", label: "Licensed Practical Nurse",category: "medicina" },
  { code: "1711", label: "Advanced Practice Registered Nurse", category: "medicina" },
  // Board of Chiropractic Medicine (05) — under medicina
  { code: "501",  label: "Chiropractic Physician",  category: "medicina" },
  // Board of Optometry (18) — under medicina
  { code: "1801", label: "Optometrist",             category: "medicina" },
];

// --- City slug map ----------------------------------------------------

/**
 * FL DOH stores city in upper-case (sometimes with leading spaces).
 * We map the seeded Florida city slugs from `cities.ts`. Anything
 * unmapped is silently dropped (the sink would reject for missing FK
 * anyway). Only Jacksonville is currently seeded as a Florida city in
 * the prolio cities catalog (2026-05-14), so this is intentionally
 * thin — extra slugs are wired for the day the FL seed expands.
 */
const FL_CITY_ALIAS: Record<string, string> = {
  jacksonville: "jacksonville",
  // Future seed expansion targets — preserved as no-ops today (the
  // sink will reject unseeded slugs). Listed so the city derivation
  // is one Edit away when those slugs land in the cities catalog.
  miami: "miami",
  orlando: "orlando",
  tampa: "tampa",
  tallahassee: "tallahassee",
  hialeah: "hialeah",
  "st petersburg": "st-petersburg",
  "saint petersburg": "st-petersburg",
  "st. petersburg": "st-petersburg",
  "fort lauderdale": "fort-lauderdale",
  "ft lauderdale": "fort-lauderdale",
  gainesville: "gainesville",
  "cape coral": "cape-coral",
  pensacola: "pensacola",
};

function mapFlCity(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  return FL_CITY_ALIAS[key];
}

// --- CSV parsing -------------------------------------------------------

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') inQuotes = false;
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

interface CsvRow {
  license: string;
  name: string;
  profession: string;
  city: string;
  licenseStatus: string;
}

function parseCsv(text: string): CsvRow[] {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const out: CsvRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]).map((c) => c.trim());
    if (cells.length < 5) continue;
    out.push({
      license: cells[0],
      name: cells[1],
      profession: cells[2],
      city: cells[3],
      licenseStatus: cells[4],
    });
  }
  return out;
}

// --- HTTP helpers -----------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert "SMITH, ADIEL GOTTLIEB" → "Smith, Adiel Gottlieb".
 * The MQA export is all-caps for most rows; title-case for display.
 */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

async function fetchProfessionCsv(
  entry: ProfessionEntry,
): Promise<CsvRow[] | null> {
  const model = JSON.stringify({
    Id: 0,
    Profession: entry.code,
    LicenseStatus: "A",
  });
  const url = `${EXPORT_BASE}?jsonModel=${encodeURIComponent(model)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/csv,text/plain,*/*",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(
        `[fl-doh-mqa] ${entry.code} ${entry.label}: HTTP ${response.status}`,
      );
      return null;
    }
    const text = await response.text();
    return parseCsv(text);
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[fl-doh-mqa] ${entry.code} ${entry.label}: ${(err as Error).message}`,
    );
    return null;
  }
}

// --- Main runner -------------------------------------------------------

export const flDohMqaSource = {
  name: "fl-doh-mqa",
  enabled() {
    return process.env.PROLIO_RUN_FL_DOH_MQA === "true";
  },
  async fetch(): Promise<ScrapedProfessional[]> {
    return [];
  },
} satisfies ScraperSource as ScraperSource;

export async function runFlDohMqa(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!flDohMqaSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(
    process.env.PROLIO_FL_DOH_MQA_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const sink = getSink();
  const seen = new Set<string>();
  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let droppedNoCity = 0;
  let droppedNotActive = 0;
  let droppedNoLicence = 0;

  for (const entry of PROFESSIONS) {
    if (totalFetched >= limit) break;
    console.log(
      `[fl-doh-mqa] fetching ${entry.code} ${entry.label} → ${entry.category}`,
    );
    const rows = await fetchProfessionCsv(entry);
    if (!rows || rows.length === 0) {
      await delay(REQUEST_DELAY_MS);
      continue;
    }
    console.log(`[fl-doh-mqa] ${entry.code} returned ${rows.length} rows`);

    const batch: ScrapedProfessional[] = [];
    for (const r of rows) {
      if (totalFetched >= limit) break;
      // Server filter is unreliable; double-check client-side.
      if (!r.licenseStatus.toLowerCase().includes("active")) {
        droppedNotActive += 1;
        continue;
      }
      const licence = r.license.trim();
      if (!licence) {
        droppedNoLicence += 1;
        continue;
      }
      const sourceId = `fl-doh-mqa:${entry.code}:${licence}`;
      if (seen.has(sourceId)) continue;

      const citySlug = mapFlCity(r.city);
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      seen.add(sourceId);
      totalFetched += 1;

      const displayName = r.name.includes(",")
        ? titleCase(r.name)
        : r.name.trim();

      batch.push(
        normalise({
          source: "fl-doh-mqa",
          sourceId,
          name: displayName,
          categoryKey: entry.category,
          citySlug,
          licenseNumber: licence,
          metadata: {
            country: "US",
            state: "FL",
            city: r.city.trim(),
            authority: "Florida Department of Health — MQA",
            verified_by_authority: true,
            fl_doh_profession_code: entry.code,
            fl_doh_profession: r.profession,
            fl_doh_license_status: r.licenseStatus,
          },
        }),
      );
    }

    if (batch.length > 0) {
      const { inserted, updated, skipped } = await sink.upsert(batch);
      totalInserted += inserted;
      totalUpdated += updated;
      totalSkipped += skipped;
      console.log(
        `[fl-doh-mqa] ${entry.code} kept=${batch.length} ` +
          `inserted=${inserted} updated=${updated} skipped=${skipped}`,
      );
    }

    await delay(REQUEST_DELAY_MS);
  }

  console.log(
    `[fl-doh-mqa] done — fetched=${totalFetched} inserted=${totalInserted} ` +
      `updated=${totalUpdated} skipped=${totalSkipped} ` +
      `droppedNoCity=${droppedNoCity} droppedNotActive=${droppedNotActive} ` +
      `droppedNoLicence=${droppedNoLicence}`,
  );
  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    skipped: totalSkipped,
  };
}
