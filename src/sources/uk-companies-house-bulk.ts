import { createReadStream } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { parseCsvRow } from "../lib/bulk-csv-loader.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * UK Companies House — free bulk snapshot (full-register ingest).
 *
 * Source: the "Free Company Data Product" at
 *   https://download.companieshouse.gov.uk/en_output.html
 * A monthly snapshot of EVERY company on the UK register (~5M), published as
 * a single 470MB ZIP (BasicCompanyDataAsOneFile-YYYY-MM-01.zip) or 7 split
 * part ZIPs. CSV inside, 55 columns, Open Government Licence (Crown
 * Copyright). This is distinct from src/sources/uk-companies-house.ts, which
 * hits the rate-limited authenticated API (600 req/5min, 5,000-result cap)
 * and only does enrichment — the bulk product is the only free path to the
 * whole register.
 *
 * What the file has / lacks (verified live 2026-06-22, header in spike):
 *  - Identity + registered-office address (PostTown/County/Country/PostCode),
 *    CompanyStatus, CompanyCategory, IncorporationDate, up to 4 SIC codes,
 *    up to 10 previous names, the CH record URI.
 *  - NO website / email / phone. It's registry data, not contact data — value
 *    is volume + legal identity, not leads. (`URI` is the CH record link, not
 *    the company's own site.)
 *
 * Premises (per request 2026-06-22):
 *  1. Extract all possible info → every useful column is mapped into the row
 *     or metadata; no category filter (unmapped SIC → generic `empresa`), no
 *     status filter by default (dissolved/liquidation ingested too).
 *  2. Never drop a company for lacking a whitelisted/seeded city → ensureCity()
 *     auto-seeds the PostTown + getSink({ trustCitySlugs: true }); a town-less
 *     row falls back County → Country → province-granularity (city_slug NULL),
 *     never `continue`.
 *
 * Bulk/throughput: streamed line-by-line (memory-bounded), batched upsert, and
 * a resume cursor (public.scrape_cursor) keyed on the global data-row index so
 * a CI-killed run continues where it left off — same contract as
 * rues-registro-mercantil-co / secop-proveedores-co.
 */

const SOURCE_NAME = "uk-companies-house-bulk" as const;
const DEFAULT_LIMIT = 10_000_000; // whole register (~5M) — effectively no cap.

// UK SIC 2007 (5-digit) → our profession verticals. Anything not here →
// generic `empresa` (kept, never dropped). Codes verified against the ONS
// SIC 2007 condensed list.
const SIC_TO_CATEGORY: Record<string, CategoryKey> = {
  "45200": "mecanica", // maintenance and repair of motor vehicles
  "43210": "electricidad", // electrical installation
  "43220": "fontaneria", // plumbing, heat and air-conditioning installation
  "43320": "carpinteria", // joinery installation
  "43341": "carpinteria", // painting (close trade; kept under carpentry vertical)
  "71111": "arquitecto", // architectural activities
  "71112": "ingenieria", // urban planning / landscape architecture
  "71121": "ingenieria", // engineering design for industrial process/production
  "71122": "ingenieria", // engineering related scientific/technical consulting
  "71129": "ingenieria", // other engineering activities
  "69101": "abogado", // barristers
  "69102": "abogado", // solicitors
  "69109": "abogado", // other legal activities
  "69201": "fiscal", // accounting and auditing activities
  "69202": "fiscal", // bookkeeping activities
  "69203": "fiscal", // tax consultancy
  "75000": "veterinario", // veterinary activities
  "47730": "farmacia", // dispensing chemist in specialised stores
  "86210": "medicina", // general medical practice activities
  "86220": "medicina", // specialist medical practice activities
  "86900": "medicina", // other human health activities
};

/** SicText is "43220 - Plumbing, heat and air-conditioning installation". */
function sicCode(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.trim().match(/^(\d{4,5})/);
  return m ? m[1] : undefined;
}

function mapSic(text: string | undefined): CategoryKey {
  const code = sicCode(text);
  if (!code) return "empresa";
  return SIC_TO_CATEGORY[code] ?? "empresa";
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase())
    .trim();
}

function clean(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Companies House dates are DD/MM/YYYY → ISO YYYY-MM-DD (or undefined). */
function parseUkDate(v: string | undefined): string | undefined {
  const t = clean(v);
  if (!t) return undefined;
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return undefined;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

/** RegAddress.Country → UK nation code, matching the seeded GB cities
 *  (region ∈ {ENG, SCO, WAL, NIR}). Unknown/foreign → undefined. */
function nation(country: string | undefined): string | undefined {
  const t = (country ?? "").trim().toUpperCase();
  if (t === "ENGLAND") return "ENG";
  if (t === "WALES") return "WAL";
  if (t === "SCOTLAND") return "SCO";
  if (t === "NORTHERN IRELAND") return "NIR";
  return undefined;
}

function buildAddress(row: Record<string, string>): string | undefined {
  const parts = [
    clean(row["RegAddress.AddressLine1"]),
    clean(row["RegAddress.AddressLine2"]),
    clean(row["RegAddress.PostTown"]),
    clean(row["RegAddress.County"]),
    clean(row["RegAddress.PostCode"]),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** Collect the up-to-10 previous names as [{date, name}], skipping blanks. */
function previousNames(row: Record<string, string>): Array<{ date?: string; name: string }> {
  const out: Array<{ date?: string; name: string }> = [];
  for (let i = 1; i <= 10; i += 1) {
    const name = clean(row[`PreviousName_${i}.CompanyName`]);
    if (!name) continue;
    out.push({ date: parseUkDate(row[`PreviousName_${i}.CONDATE`]), name: titleCase(name) });
  }
  return out;
}

interface RunOptions {
  /** Absolute paths of the extracted BasicCompanyData CSV files, in order. */
  csvPaths: string[];
  maxRows?: number;
  batchSize?: number;
  /** Heartbeat after each page checkpoint (see telemetry.ts). */
  onProgress?: (p: { fetched: number; upserted: number; skipped: number }) => Promise<void> | void;
}

// ── Resume cursor (public.scrape_cursor) ────────────────────────────────────
// 5M rows don't finish in one CI window. We checkpoint the global data-row
// index (across all part files, header rows excluded) and resume from it.
async function readCursor(client: SupabaseClient): Promise<number> {
  const { data } = await client
    .from("scrape_cursor")
    .select("next_offset")
    .eq("source", SOURCE_NAME)
    .maybeSingle();
  const v = (data as { next_offset?: number | string } | null)?.next_offset;
  return Number(v ?? 0) || 0;
}

async function writeCursor(client: SupabaseClient, nextOffset: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (client.from("scrape_cursor") as any).upsert(
    {
      source: SOURCE_NAME,
      next_offset: nextOffset,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "source" },
  );
}

/** Stream a single CSV file row-by-row as header→value maps. Memory-bounded:
 *  never holds more than one line plus the trailing chunk fragment. */
async function* streamCsv(path: string): AsyncGenerator<Record<string, string>> {
  let header: string[] | null = null;
  let buf = "";
  let bomStripped = false;
  const emit = function* (line: string): Generator<Record<string, string>> {
    if (line.length === 0) return;
    if (header === null) {
      // Trim header keys — Companies House ships several with a leading space
      // (e.g. " CompanyNumber"), which would otherwise break row[key] lookups.
      header = parseCsvRow(line, ",").map((h) => h.trim());
      return;
    }
    const cells = parseCsvRow(line, ",");
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) row[header[i] ?? `col${i}`] = cells[i] ?? "";
    yield row;
  };
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (!bomStripped) {
      if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
      bomStripped = true;
    }
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      yield* emit(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    }
  }
  if (buf.length > 0) yield* emit(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
}

export async function runUkCompaniesHouseBulk(
  client: SupabaseClient,
  opts: RunOptions,
): Promise<{ scanned: number; accepted: number; written: number }> {
  const batchSize = opts.batchSize ?? 1000;
  const maxRows = opts.maxRows ?? DEFAULT_LIMIT;
  const activeOnly = process.env.PROLIO_UK_CH_ACTIVE_ONLY === "true";
  const sink = getSink({ trustCitySlugs: true });
  let scanned = 0; // global data-row index across all files
  let accepted = 0;
  let written = 0;
  let buffer: ScrapedProfessional[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const res = await sink.upsert(buffer);
    written += res.inserted + res.updated;
    buffer = [];
  };

  const startCursor = await readCursor(client);
  if (startCursor > 0) console.log(`[uk-ch-bulk] resuming from row=${startCursor}`);
  let processedThisRun = 0;
  let reachedEnd = true;

  for (const path of opts.csvPaths) {
    console.log(`[uk-ch-bulk] reading ${path}`);
    for await (const row of streamCsv(path)) {
      scanned += 1;
      // Skip rows already ingested in a previous run (resume).
      if (scanned <= startCursor) continue;

      if (processedThisRun >= maxRows) {
        reachedEnd = false; // stopped at the per-run cap, not end-of-data
        break;
      }
      processedThisRun += 1;

      const status = clean(row["CompanyStatus"]);
      if (activeOnly && status && status.toLowerCase() !== "active") continue;

      const companyNumber = clean(row["CompanyNumber"]);
      if (!companyNumber) continue; // no stable id → unusable (never happens in practice)
      // Premise: never drop for a missing name — fall back to the number.
      const name = clean(row["CompanyName"]) ?? companyNumber;

      // No-drop city resolution: PostTown → County → Country → province
      // granularity (city_slug NULL). ensureCity auto-seeds GB municipalities.
      const town = clean(row["RegAddress.PostTown"]);
      const county = clean(row["RegAddress.County"]);
      const regCountry = clean(row["RegAddress.Country"]);
      const reg = nation(regCountry);
      const cityName = town ?? county ?? regCountry;
      let citySlug = "";
      if (cityName) {
        const cityResult = await ensureCity(client, { name: titleCase(cityName), state: reg, country: "GB" });
        citySlug = cityResult?.slug ?? "";
      }

      const sicTexts = [
        clean(row["SICCode.SicText_1"]),
        clean(row["SICCode.SicText_2"]),
        clean(row["SICCode.SicText_3"]),
        clean(row["SICCode.SicText_4"]),
      ].filter(Boolean);
      const prevNames = previousNames(row);

      buffer.push({
        source: SOURCE_NAME as ScrapeSource,
        sourceId: `uk-ch:${companyNumber}`,
        name: titleCase(name),
        categoryKey: mapSic(row["SICCode.SicText_1"]),
        country: "GB",
        citySlug,
        address: buildAddress(row),
        foundedAt: parseUkDate(row["IncorporationDate"]),
        legalForm: clean(row["CompanyCategory"]),
        metadata: {
          company_number: companyNumber,
          company_status: status,
          company_category: clean(row["CompanyCategory"]),
          country_of_origin: clean(row["CountryOfOrigin"]),
          dissolution_date: parseUkDate(row["DissolutionDate"]),
          post_town: town,
          county,
          reg_country: regCountry,
          postcode: clean(row["RegAddress.PostCode"]),
          ...(citySlug ? {} : { province_slug: (reg ?? "gb").toLowerCase() }),
          sic_codes: sicTexts,
          previous_names: prevNames.length > 0 ? prevNames : undefined,
          uri: clean(row["URI"]),
          country: "GB",
          verified_by_authority: true,
          authority: "Companies House — UK (Free Company Data Product)",
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) {
        await flush();
        await writeCursor(client, scanned);
        await opts.onProgress?.({ fetched: accepted, upserted: written, skipped: scanned - accepted });
      }
    }
    if (!reachedEnd) break;
  }
  await flush();
  await writeCursor(client, reachedEnd ? 0 : scanned);
  if (reachedEnd) console.log("[uk-ch-bulk] all files consumed — cursor reset to 0 for next month");
  else console.log(`[uk-ch-bulk] stopped at cap/kill — cursor parked at row=${scanned}`);

  const cs = getCityUpsertStats();
  console.log(
    `[uk-ch-bulk] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ──────────────────────────────────────────────────────

export const ukCompaniesHouseBulkSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_UK_CH_BULK === "true";
  },
  async fetch() {
    return [];
  },
};

/** Resolve the CSV paths from env. Either a directory holding the extracted
 *  BasicCompanyData-*.csv files (PROLIO_UK_CH_BULK_DIR) or an explicit
 *  comma-separated list (PROLIO_UK_CH_BULK_FILES). */
export function resolveCsvPaths(): string[] {
  const files = process.env.PROLIO_UK_CH_BULK_FILES;
  if (files) return files.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}
