import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * Florida DBPR Board of Veterinary Medicine — Licensee Extract.
 *
 * The Florida Department of Business and Professional Regulation publishes
 * monthly bulk CSV extracts for each licensing board in the State Technology
 * Office (STO) file-download area.  Board 26 / license type `VM` is the
 * Board of Veterinary Medicine.
 *
 * Pre-flight 2026-06-12:
 *   URL: https://www2.myfloridalicense.com/sto/file_download/extracts/lic26vt.csv
 *   HTTP 200, Content-Type: text/csv, ~2.9 MB. Cloudflare CDN (no challenge —
 *   plain 200 from datacenter IP, __cf_bm bot-management cookie set but no
 *   JS challenge triggered). No auth, no captcha, no login.
 *   robots.txt at www2.myfloridalicense.com: only `/sto/file_download/` is
 *   not Disallowed; confirmed allowed.
 *   Record count: ~14,600 rows (active + inactive + limited).
 *
 * CSV format (no header row, 22 columns, quoted values):
 *   0  board code          e.g. "26"
 *   1  license type        e.g. "VM" (vet), "VC" (vet cert), "VT" (vet tech)
 *   2  name                "LAST, FIRST MIDDLE"
 *   3  business name
 *   4  address info
 *   5  street
 *   6  street2
 *   7  street3
 *   8  city
 *   9  state               e.g. "FL", "NY", "AL"
 *  10  zip
 *  11  county code
 *  12  license number      without prefix, e.g. "0003487"
 *  13  license class
 *  14  status              A=Active, I=Inactive, D=Delinquent, C=Cancelled, R=Revoked
 *  15  original license date
 *  16  renewal/status date
 *  17  expiration date
 *  18  (spare)
 *  19  (spare)
 *  20  full license number "VM3487"
 *  21  notes               e.g. "CE Exempt"
 *
 * We ingest only `VM` (licensed veterinarians, not vet techs `VT`) with
 * FL addresses and status not in {C, R} (Cancelled / Revoked).
 * Active (`A`) + Inactive (`I`) + Delinquent (`D`) rows are all included —
 * Inactive means the vet voluntarily chose non-practising status but the
 * licence remains valid; Delinquent means renewal fees unpaid but the licence
 * hasn't been formally cancelled.
 *
 * Existing FL sources do NOT cover vets:
 *   - `florida-dbpr` (stub) covers only construction/trades via wl11.asp
 *     (session-bound ASP form — not automatable without Playwright).
 *   - `fl-doh-mqa` covers FL Department of Health professions (MD, dentist,
 *     nurse, PT, psychologist, etc.) — veterinarians are licensed by DBPR,
 *     not DOH, so they are absent from that registry.
 *
 * Off by default. Enable via `PROLIO_RUN_FLORIDA_DBPR_VETS=true`.
 * Cap via `PROLIO_FLORIDA_DBPR_VETS_LIMIT` (default 20000).
 */

const CSV_URL =
  "https://www2.myfloridalicense.com/sto/file_download/extracts/lic26vt.csv";
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_LIMIT = 20_000;

const CATEGORY: CategoryKey = "veterinario";

// Status codes to include (exclude Cancelled and Revoked).
const INCLUDE_STATUSES = new Set(["A", "I", "D"]);

// CSV column indices (0-based, no header row).
const COL_TYPE = 1;
const COL_NAME = 2;
const COL_BUSINESS = 3;
const COL_STREET = 5;
const COL_CITY = 8;
const COL_STATE = 9;
const COL_ZIP = 10;
const COL_STATUS = 14;
const COL_FULL_LICENSE = 20;

// --- Florida city slug map --------------------------------------------

const FL_CITY: Record<string, string> = {
  jacksonville: "jacksonville",
  miami: "miami",
  orlando: "orlando",
  tampa: "tampa",
  tallahassee: "tallahassee",
  hialeah: "hialeah",
  "st. petersburg": "st-petersburg",
  "st petersburg": "st-petersburg",
  "saint petersburg": "st-petersburg",
  "port st. lucie": "port-st-lucie",
  "port st lucie": "port-st-lucie",
  "cape coral": "cape-coral",
  pembroke: "pembroke-pines",
  "pembroke pines": "pembroke-pines",
  "fort lauderdale": "fort-lauderdale",
  "ft lauderdale": "fort-lauderdale",
  miramar: "miramar",
  gainesville: "gainesville",
  coral: "coral-springs",
  "coral springs": "coral-springs",
  clearwater: "clearwater",
  "west palm beach": "west-palm-beach",
  "palm bay": "palm-bay",
  pomano: "pompano-beach",
  "pompano beach": "pompano-beach",
  "lakeland": "lakeland",
  "boca raton": "boca-raton",
  davie: "davie",
  "hollywood": "hollywood",
  sunrise: "sunrise",
  deltona: "deltona",
  "palm coast": "palm-coast",
  "fort myers": "fort-myers",
  "ft myers": "fort-myers",
  "kissimmee": "kissimmee",
  pensacola: "pensacola",
  daytona: "daytona-beach",
  "daytona beach": "daytona-beach",
  ocala: "ocala",
};

function mapFlCity(raw: string): string | undefined {
  const k = raw.toLowerCase().trim();
  return FL_CITY[k];
}

// --- CSV parser -------------------------------------------------------

/**
 * Minimal CSV row splitter. Handles RFC 4180 quoted fields.
 * Returns the raw column values without quotes.
 */
function parseRow(line: string): string[] {
  const cols: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // quoted field
      i += 1;
      let val = "";
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            val += '"';
            i += 2;
          } else {
            i += 1;
            break;
          }
        } else {
          val += line[i];
          i += 1;
        }
      }
      cols.push(val);
      if (line[i] === ",") i += 1;
    } else {
      // unquoted field
      const end = line.indexOf(",", i);
      if (end < 0) {
        cols.push(line.slice(i));
        break;
      }
      cols.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return cols;
}

function reorderName(lastFirst: string): string {
  const idx = lastFirst.indexOf(",");
  if (idx < 0) return lastFirst.trim();
  const last = lastFirst.slice(0, idx).trim();
  const rest = lastFirst.slice(idx + 1).trim();
  return rest ? `${rest} ${last}` : last;
}

// --- Entrypoint -------------------------------------------------------

export const floridaDbprVetsSource: ScraperSource = {
  name: "florida-dbpr-vets",
  enabled() {
    return process.env.PROLIO_RUN_FLORIDA_DBPR_VETS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runFloridaDbprVets(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
} | null> {
  if (!floridaDbprVetsSource.enabled()) return null;

  const limitRaw = Number(
    process.env.PROLIO_FLORIDA_DBPR_VETS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let csvText: string;
  try {
    const res = await fetch(CSV_URL, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*;q=0.9" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[florida-dbpr-vets] HTTP ${res.status} — skipping`);
      return null;
    }
    csvText = await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[florida-dbpr-vets] fetch error: ${(err as Error).message}`,
    );
    return null;
  }

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedType = 0;
  let droppedState = 0;
  let droppedStatus = 0;
  let droppedNoCity = 0;

  const lines = csvText.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (records.length >= cap) break;

    const cols = parseRow(raw);
    const licType = (cols[COL_TYPE] ?? "").trim();
    if (licType !== "VM") {
      droppedType += 1;
      continue;
    }
    const state = (cols[COL_STATE] ?? "").trim().toUpperCase();
    if (state !== "FL") {
      droppedState += 1;
      continue;
    }
    const status = (cols[COL_STATUS] ?? "").trim().toUpperCase();
    if (!INCLUDE_STATUSES.has(status)) {
      droppedStatus += 1;
      continue;
    }

    const rawCity = (cols[COL_CITY] ?? "").trim();
    const citySlug = mapFlCity(rawCity);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }

    const fullLicense = (cols[COL_FULL_LICENSE] ?? "").trim();
    if (!fullLicense) continue;
    const sourceId = `florida-dbpr-vets:${fullLicense}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const rawName = (cols[COL_NAME] ?? "").trim();
    if (!rawName) continue;
    const name = reorderName(rawName);
    const business = (cols[COL_BUSINESS] ?? "").trim() || undefined;
    const street = (cols[COL_STREET] ?? "").trim();
    const zip = (cols[COL_ZIP] ?? "").trim();
    const address = [street, rawCity, `FL ${zip}`]
      .filter(Boolean)
      .join(", ");

    records.push(
      normalise({
        source: "florida-dbpr-vets",
        country: "US",
        sourceId,
        name,
        categoryKey: CATEGORY,
        citySlug,
        address: address || undefined,
        licenseNumber: fullLicense,
        metadata: {
          country: "US",
          state: "FL",
          verified_by_authority: true,
          authority: "Florida DBPR Board of Veterinary Medicine",
          business_name: business,
          license_status: status,
          zip,
        },
      }),
    );
  }

  console.log(
    `[florida-dbpr-vets] parsed=${records.length} ` +
      `droppedType=${droppedType} droppedState=${droppedState} ` +
      `droppedStatus=${droppedStatus} droppedNoCity=${droppedNoCity}`,
  );

  if (records.length === 0) {
    console.warn(
      "[florida-dbpr-vets] 0 rows after filtering — check CSV format or column mapping",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[florida-dbpr-vets] done — fetched=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
