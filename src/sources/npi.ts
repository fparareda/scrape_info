import { inflateRawSync } from "node:zlib";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";
import { splitCsvLine } from "./_bulk-utils.js";

/**
 * NPI Registry — US healthcare provider scraper (bulk + weekly diff).
 *
 * CMS publishes the NPPES Data Dissemination File monthly (full snapshot,
 * ~1.08 GB ZIP / ~7M providers as of May 2026) and a weekly incremental
 * file (~6 MB ZIP, only NPIs added/changed in the past 7 days). Index:
 *
 *   https://download.cms.gov/nppes/NPI_Files.html
 *
 * Filename patterns observed (V2 format, mandatory since 2026-03-03):
 *   - Monthly  : NPPES_Data_Dissemination_<Month>_<YYYY>_V2.zip
 *   - Weekly   : NPPES_Data_Dissemination_<MMDDYY>_<MMDDYY>_Weekly_V2.zip
 *   - Deactiv. : NPPES_Deactivated_NPI_Report_<MMDDYY>_V2.zip
 *
 * --- Strategy ----------------------------------------------------------
 * The previous implementation iterated the public JSON API by
 * (state × taxonomy) tuples, capping at ~1k rows per state — ~6k total
 * upserts per run. The bulk file is 1000× that.
 *
 * Default behaviour in this scraper (CI-safe):
 *   1. Download the weekly diff ZIP (~6 MB) — always cheap.
 *   2. Stream-parse the embedded CSV (`npidata_pfile_*.csv`).
 *   3. Apply taxonomy → category mapping, drop non-healthcare rows
 *      (no matching root) and rows whose city isn't seeded in
 *      public.cities.
 *   4. Upsert in batches.
 *
 * For the initial backfill (millions of historical rows) the monthly
 * full snapshot is too large to download inside a typical GH Actions
 * runner without hitting disk/memory ceilings. Two opt-in env levers:
 *
 *   PROLIO_NPI_BASELINE_CSV_URL
 *     Pre-processed (e.g. by an offline job) CSV containing the
 *     healthcare-only subset of the monthly snapshot. If set, the
 *     scraper downloads + ingests that file in addition to the diff.
 *
 *   PROLIO_NPI_BULK_WEEKLY_URL
 *     Explicit override for the weekly diff URL (otherwise scraped
 *     from the index page).
 *
 *   PROLIO_NPI_INGEST_FULL_MONTHLY=true
 *     Dangerous in CI. Downloads the ~1 GB monthly ZIP and streams
 *     it. Only flip when running locally with enough disk + time.
 *
 *   PROLIO_NPI_LIMIT_PER_RUN  (default 100000)
 *     Hard cap on rows upserted per run.
 *
 * --- Taxonomy → Prolio category map -----------------------------------
 *   207… Medical Doctor (incl. specialties)         → medicina
 *   208… Medical Doctor (other roots)               → medicina
 *   261Q… Clinic/Center                              → medicina
 *   1223… Dental Providers (root)                    → dentista
 *   122… Dental Providers (compat)                  → dentista
 *   174M… Veterinarian                               → veterinario
 *   174… Veterinary services (Mexico-style mirror)  → veterinario
 *   103T… Psychologist                               → psicologia
 *   1041… Social Worker (psicologia-adjacent)        → psicologia
 *   224P… Physical Therapy assistants                → medicina
 *   2251… Physical Therapist (current)               → medicina
 *
 * The granular taxonomy code is preserved in metadata.npi_taxonomy so
 * downstream consumers can re-bucket without rescraping.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const INDEX_URL = "https://download.cms.gov/nppes/NPI_Files.html";
const DOWNLOAD_BASE = "https://download.cms.gov/nppes/";
const REQUEST_TIMEOUT_MS = 600_000; // 10 min — full file download
const DEFAULT_LIMIT_PER_RUN = 100_000;
const UPSERT_BATCH_SIZE = 500;

// --- Taxonomy mapping -------------------------------------------------

function categoryFromTaxonomy(code: string | undefined): CategoryKey | null {
  if (!code) return null;
  const c = code.toUpperCase();
  // Order matters: longer prefixes first.
  if (c.startsWith("1223")) return "dentista";
  if (c.startsWith("122")) return "dentista";
  if (c.startsWith("174M") || c.startsWith("174")) return "veterinario";
  if (c.startsWith("103T")) return "psicologia";
  if (c.startsWith("1041")) return "psicologia";
  if (c.startsWith("2251") || c.startsWith("224P")) return "medicina";
  if (c.startsWith("207") || c.startsWith("208") || c.startsWith("261Q")) {
    return "medicina";
  }
  return null;
}

// --- ZIP parsing (zero-dep, copied from _bulk-utils pattern) ----------

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
}

function findEndOfCentralDir(buf: Buffer): number {
  const SIG = 0x06054b50;
  const startSearch = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= startSearch; i -= 1) {
    if (buf.readUInt32LE(i) === SIG) return i;
  }
  return -1;
}

function parseCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDir(buf);
  if (eocd < 0) return [];
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let off = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const fnLen = buf.readUInt16LE(off + 28);
    const exLen = buf.readUInt16LE(off + 30);
    const ccLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + fnLen).toString("utf8");
    entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
    off += 46 + fnLen + exLen + ccLen;
  }
  return entries;
}

function readZipEntryData(buf: Buffer, entry: ZipEntry): Buffer | null {
  let lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const fnLen = buf.readUInt16LE(lh + 26);
  const exLen = buf.readUInt16LE(lh + 28);
  lh += 30 + fnLen + exLen;
  const slice = buf.slice(lh, lh + entry.compressedSize);
  if (entry.method === 0) return slice;
  if (entry.method === 8) {
    try {
      return inflateRawSync(slice);
    } catch (e) {
      console.warn(`[npi] inflate failed for ${entry.name}: ${(e as Error).message}`);
      return null;
    }
  }
  console.warn(`[npi] unsupported zip method ${entry.method} for ${entry.name}`);
  return null;
}

// --- Index scraping ----------------------------------------------------

interface NppesUrls {
  monthly?: string;
  weekly?: string;
  deactivation?: string;
}

async function scrapeNppesIndex(): Promise<NppesUrls> {
  const res = await fetch(INDEX_URL, {
    headers: { "User-Agent": POLITE_UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.warn(`[npi] index ${res.status}`);
    return {};
  }
  const html = await res.text();
  const out: NppesUrls = {};
  // Three known patterns; we scrape the first href match of each.
  const monthly = html.match(/href=['"]\.?\/?(NPPES_Data_Dissemination_[A-Za-z]+_\d{4}_V2\.zip)['"]/);
  const weekly = html.match(/href=['"]\.?\/?(NPPES_Data_Dissemination_\d{6}_\d{6}_Weekly_V2\.zip)['"]/);
  const deact = html.match(/href=['"]\.?\/?(NPPES_Deactivated_NPI_Report_\d{6}_V2\.zip)['"]/);
  if (monthly) out.monthly = DOWNLOAD_BASE + monthly[1];
  if (weekly) out.weekly = DOWNLOAD_BASE + weekly[1];
  if (deact) out.deactivation = DOWNLOAD_BASE + deact[1];
  return out;
}

// --- CSV streaming (line-by-line over the inflated buffer) ------------

function* iterCsvRows(
  buf: Buffer,
): Generator<Record<string, string>, void, unknown> {
  // NPPES CSVs are CRLF, quoted, ASCII. Decode incrementally.
  const text = buf.toString("utf8").replace(/^﻿/, "");
  let pos = 0;
  let lineStart = 0;
  let inQuotes = false;
  const lines: string[] = [];
  while (pos < text.length) {
    const c = text.charCodeAt(pos);
    if (c === 34 /* " */) inQuotes = !inQuotes;
    else if (!inQuotes && (c === 10 /* \n */ || c === 13 /* \r */)) {
      if (pos > lineStart) lines.push(text.slice(lineStart, pos));
      if (c === 13 && text.charCodeAt(pos + 1) === 10) pos += 1;
      lineStart = pos + 1;
    }
    pos += 1;
  }
  if (lineStart < text.length) lines.push(text.slice(lineStart));
  if (lines.length < 2) return;
  const header = splitCsvLine(lines[0], ",");
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i], ",");
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = (cells[j] ?? "").trim();
    }
    yield row;
  }
}

// --- Helpers -----------------------------------------------------------

function normaliseUsPhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function buildName(row: Record<string, string>): string | undefined {
  const entity = row["Entity Type Code"];
  if (entity === "2") {
    const org = row["Provider Organization Name (Legal Business Name)"];
    if (org) return titleCase(org);
    return undefined;
  }
  // Individuals (entity 1)
  const last = row["Provider Last Name (Legal Name)"];
  const first = row["Provider First Name"];
  const mid = row["Provider Middle Name"];
  const parts = [first, mid, last].filter((p) => p && p.length > 0);
  if (parts.length === 0) return undefined;
  return parts.map(titleCase).join(" ");
}

function primaryTaxonomy(row: Record<string, string>): {
  code: string;
  license?: string;
  state?: string;
} | null {
  // Scan slots 1..15 for the primary switch == "Y", else first non-empty.
  let fallback: { code: string; license?: string; state?: string } | null = null;
  for (let i = 1; i <= 15; i += 1) {
    const code = row[`Healthcare Provider Taxonomy Code_${i}`];
    if (!code) continue;
    const license = row[`Provider License Number_${i}`] || undefined;
    const state = row[`Provider License Number State Code_${i}`] || undefined;
    const sw = row[`Healthcare Provider Primary Taxonomy Switch_${i}`];
    const entry = { code, license, state };
    if (sw === "Y") return entry;
    if (!fallback) fallback = entry;
  }
  return fallback;
}

function rowToScraped(
  row: Record<string, string>,
  cityIndex: Map<string, string>,
): ScrapedProfessional | null {
  const npi = row["NPI"];
  if (!npi) return null;
  // Skip deactivated rows (have NPI Deactivation Date but no Reactivation Date)
  if (row["NPI Deactivation Date"] && !row["NPI Reactivation Date"]) return null;

  const tax = primaryTaxonomy(row);
  const category = categoryFromTaxonomy(tax?.code);
  if (!category) return null;

  const name = buildName(row);
  if (!name) return null;

  const city = row["Provider Business Practice Location Address City Name"];
  const cityKey = city?.trim().toLowerCase();
  const citySlug = cityKey ? cityIndex.get(cityKey) : undefined;
  if (!citySlug) return null;

  const country = row["Provider Business Practice Location Address Country Code (If outside U.S.)"];
  if (country && country !== "US") return null;

  const state = row["Provider Business Practice Location Address State Name"];
  const postal = row["Provider Business Practice Location Address Postal Code"];
  const addr1 = row["Provider First Line Business Practice Location Address"];
  const addressParts = [addr1, city, state, postal].filter((p) => p && p.length > 0);

  const phone = normaliseUsPhone(
    row["Provider Business Practice Location Address Telephone Number"],
  );
  const fax = row["Provider Business Practice Location Address Fax Number"] || undefined;

  return normalise({
    source: "npi",
    country: "US",
    sourceId: `npi:${npi}`,
    name,
    categoryKey: category,
    citySlug,
    phone,
    address: addressParts.length > 0 ? addressParts.join(", ") : undefined,
    licenseNumber: npi,
    metadata: {
      country: "US",
      state: state ?? undefined,
      npi,
      npi_taxonomy: tax?.code,
      npi_license: tax?.license,
      npi_license_state: tax?.state,
      entity_type: row["Entity Type Code"] === "2" ? "organization" : "individual",
      fax,
      is_sole_proprietor: row["Is Sole Proprietor"] || undefined,
      verified_by_authority: true,
      authority: "CMS NPI Registry",
    },
  });
}

// --- Download / extract ------------------------------------------------

async function downloadZip(url: string, label: string): Promise<Buffer | null> {
  console.log(`[npi] downloading ${label}: ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": POLITE_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    console.warn(`[npi] download ${label} failed: ${(e as Error).message}`);
    return null;
  }
  if (!res.ok) {
    console.warn(`[npi] download ${label} ${res.status}`);
    return null;
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  console.log(`[npi] ${label}: ${(buf.length / (1024 * 1024)).toFixed(1)} MB`);
  return buf;
}

function extractDataCsv(zipBuf: Buffer): Buffer | null {
  const entries = parseCentralDirectory(zipBuf);
  // Main data file matches npidata_pfile_*.csv (not _fileheader, not pl_/othername_/endpoint_).
  const dataEntry = entries.find(
    (e) =>
      /^npidata_pfile_.*\.csv$/i.test(e.name) &&
      !/_fileheader/i.test(e.name),
  );
  if (!dataEntry) {
    console.warn(
      `[npi] no npidata_pfile_*.csv in zip — entries=${entries.map((e) => e.name).join(", ")}`,
    );
    return null;
  }
  return readZipEntryData(zipBuf, dataEntry);
}

async function ingestZip(
  zipBuf: Buffer,
  cityIndex: Map<string, string>,
  limit: number,
  label: string,
): Promise<{ fetched: number; upserted: number; skipped: number; dropped: number }> {
  const csv = extractDataCsv(zipBuf);
  if (!csv) return { fetched: 0, upserted: 0, skipped: 0, dropped: 0 };

  const sink = getSink();
  let fetched = 0;
  let upserted = 0;
  let skipped = 0;
  let dropped = 0;
  let batch: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of iterCsvRows(csv)) {
    fetched += 1;
    if (upserted + batch.length >= limit) break;
    const rec = rowToScraped(row, cityIndex);
    if (!rec) {
      dropped += 1;
      continue;
    }
    if (seen.has(rec.sourceId)) continue;
    seen.add(rec.sourceId);
    batch.push(rec);
    if (batch.length >= UPSERT_BATCH_SIZE) {
      const r = await sink.upsert(batch);
      upserted += r.inserted + r.updated;
      skipped += r.skipped;
      batch = [];
    }
  }
  if (batch.length > 0) {
    const r = await sink.upsert(batch);
    upserted += r.inserted + r.updated;
    skipped += r.skipped;
  }
  console.log(
    `[npi] ${label}: fetched=${fetched} upserted=${upserted} skipped=${skipped} dropped=${dropped}`,
  );
  return { fetched, upserted, skipped, dropped };
}

// --- Public entrypoint -------------------------------------------------

export const npiSource: ScraperSource = {
  name: "npi",
  enabled() {
    return process.env.PROLIO_RUN_NPI === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNpi(): Promise<void> {
  if (!npiSource.enabled()) return;

  const limit = (() => {
    const raw = Number(process.env.PROLIO_NPI_LIMIT_PER_RUN ?? DEFAULT_LIMIT_PER_RUN);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT_PER_RUN;
  })();

  // Build US city slug index.
  const cityIndex = new Map<string, string>();
  try {
    const usCities = await getCities({ country: "US" });
    for (const c of usCities) cityIndex.set(c.name.trim().toLowerCase(), c.slug);
  } catch (e) {
    console.warn(`[npi] failed to load US cities: ${(e as Error).message}`);
    return;
  }
  if (cityIndex.size === 0) {
    console.warn(`[npi] no US cities loaded — aborting`);
    return;
  }

  // Discover URLs (env overrides win).
  const indexUrls =
    process.env.PROLIO_NPI_BULK_WEEKLY_URL || process.env.PROLIO_NPI_BASELINE_CSV_URL
      ? {}
      : await scrapeNppesIndex();
  const weeklyUrl = process.env.PROLIO_NPI_BULK_WEEKLY_URL ?? indexUrls.weekly;
  const baselineUrl = process.env.PROLIO_NPI_BASELINE_CSV_URL;
  const ingestFullMonthly = process.env.PROLIO_NPI_INGEST_FULL_MONTHLY === "true";

  let totalFetched = 0;
  let totalUpserted = 0;
  let totalSkipped = 0;
  let totalDropped = 0;

  // 1) Baseline (optional, pre-processed healthcare subset CSV).
  if (baselineUrl) {
    const buf = await downloadZip(baselineUrl, "baseline");
    if (buf) {
      // Baseline can be a plain CSV or a ZIP — sniff PK header.
      let csvBuf: Buffer | null;
      if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
        csvBuf = extractDataCsv(buf);
      } else {
        csvBuf = buf;
      }
      if (csvBuf) {
        const sink = getSink();
        let fetched = 0;
        let upserted = 0;
        let skipped = 0;
        let dropped = 0;
        let batch: ScrapedProfessional[] = [];
        const seen = new Set<string>();
        for (const row of iterCsvRows(csvBuf)) {
          fetched += 1;
          if (upserted + batch.length >= limit) break;
          const rec = rowToScraped(row, cityIndex);
          if (!rec) {
            dropped += 1;
            continue;
          }
          if (seen.has(rec.sourceId)) continue;
          seen.add(rec.sourceId);
          batch.push(rec);
          if (batch.length >= UPSERT_BATCH_SIZE) {
            const r = await sink.upsert(batch);
            upserted += r.inserted + r.updated;
            skipped += r.skipped;
            batch = [];
          }
        }
        if (batch.length > 0) {
          const r = await sink.upsert(batch);
          upserted += r.inserted + r.updated;
          skipped += r.skipped;
        }
        totalFetched += fetched;
        totalUpserted += upserted;
        totalSkipped += skipped;
        totalDropped += dropped;
        console.log(
          `[npi] baseline: fetched=${fetched} upserted=${upserted} skipped=${skipped} dropped=${dropped}`,
        );
      }
    }
  }

  // 2) Weekly diff (always cheap, ~6 MB).
  if (weeklyUrl && totalUpserted < limit) {
    const buf = await downloadZip(weeklyUrl, "weekly");
    if (buf) {
      const r = await ingestZip(buf, cityIndex, limit - totalUpserted, "weekly");
      totalFetched += r.fetched;
      totalUpserted += r.upserted;
      totalSkipped += r.skipped;
      totalDropped += r.dropped;
    }
  } else if (!weeklyUrl && !baselineUrl) {
    console.warn(
      `[npi] no weekly URL found on index and no PROLIO_NPI_BASELINE_CSV_URL set — nothing to ingest`,
    );
  }

  // 3) Full monthly (opt-in, dangerous in CI).
  if (ingestFullMonthly && totalUpserted < limit) {
    const monthlyUrl = indexUrls.monthly;
    if (!monthlyUrl) {
      console.warn(`[npi] PROLIO_NPI_INGEST_FULL_MONTHLY=true but no monthly URL found`);
    } else {
      console.warn(
        `[npi] PROLIO_NPI_INGEST_FULL_MONTHLY=true — downloading ~1 GB ZIP (~7M rows). This will not survive a stock GH runner without disk/memory tuning.`,
      );
      const buf = await downloadZip(monthlyUrl, "monthly");
      if (buf) {
        const r = await ingestZip(buf, cityIndex, limit - totalUpserted, "monthly");
        totalFetched += r.fetched;
        totalUpserted += r.upserted;
        totalSkipped += r.skipped;
        totalDropped += r.dropped;
      }
    }
  }

  console.log(
    `[npi] done — fetched=${totalFetched} upserted=${totalUpserted} ` +
      `skipped=${totalSkipped} dropped=${totalDropped} (cap ${limit})`,
  );
}
