import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";
import { parseCsv } from "./_bulk-utils.js";

/**
 * CPO — College of Physiotherapists of Ontario.
 *
 * Pre-flight 2026-05-18:
 *
 *   Public register: https://collegept.org/public-register
 *   Backend:         https://collegept.azurewebsites.net/PublicRegister/
 *   robots.txt:
 *     - collegept.org: only Disallows /wp-admin/ → all register paths open.
 *     - collegept.azurewebsites.net: HTTP 404 → no file → all paths allowed.
 *   Auth / captcha: none — fully public, no login required.
 *   Cloudflare: not detected.
 *
 * Strategy: single bulk CSV download (~19k rows, ~11k active).
 * The CSV endpoint returns all registered physiotherapists in Ontario
 * with columns: NAME, REGISTRATION STATUS, CLINIC NAME, ADDRESS,
 * POSTAL CODE, CITY, PHONE, ADDITIONAL PRACTICE LOCATIONS.
 *
 * We filter to active-status rows only and map city to the closest
 * seeded Ontario/CA city slug.
 *
 * Category: `fisioterapia`. CPO fills the Ontario gap — previous
 * fisioterapia CA coverage was Manitoba (CPM) and BC (CPTBC PR open);
 * Ontario has the largest physiotherapy workforce in Canada.
 *
 * Off by default. Enable via PROLIO_RUN_CPO_PHYSIO=true.
 * Cap via PROLIO_CPO_PHYSIO_LIMIT (default 20000 — full roster ~19k).
 * Cron: monthly (college rolls update monthly).
 */

const CSV_URL =
  process.env.PROLIO_CPO_CSV_URL ||
  "https://collegept.azurewebsites.net/PublicRegister/ContactSearchCsv" +
    "?o=fullName&p=1&asi=False&sm=False&pfi=False&acu=False&wc=False" +
    "&ts=False&dftph=False&bccf=False&ctn=False&pcl=False&ppc=False" +
    "&anp=False&wwa=False&ohip=False&st=False&docs=0";

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 120_000; // bulk CSV download
const DEFAULT_LIMIT = 20_000;

// Active-status substrings — CPO uses "Active" and variants.
const ACTIVE_STATUSES = ["active", "general"];

export const cpoPhysioSource: ScraperSource = {
  name: "cpo-physio",
  enabled() {
    return process.env.PROLIO_RUN_CPO_PHYSIO === "true";
  },
  async fetch() {
    return [];
  },
};

// --- HTTP helper --------------------------------------------------------

async function downloadCsv(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(CSV_URL, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/csv,text/plain,*/*",
        "Accept-Language": "en-CA,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(`[cpo-physio] HTTP ${response.status} on CSV endpoint`);
      return null;
    }
    return await response.text();
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[cpo-physio] CSV fetch failed: ${(e as Error).message}`);
    return null;
  }
}

// --- City mapping (ON/CA) -----------------------------------------------

interface CaOntarioCityIndex {
  exact: Map<string, string>;
  aliases: Map<string, string>;
}

let ontarioCityIndexCache: CaOntarioCityIndex | null = null;

async function loadOntarioCityIndex(): Promise<CaOntarioCityIndex> {
  if (ontarioCityIndexCache) return ontarioCityIndexCache;
  const cities = await getCities({ country: "CA" });
  const exact = new Map<string, string>();
  for (const c of cities) {
    exact.set(c.name.toLowerCase(), c.slug);
    exact.set(c.slug, c.slug);
  }
  // Toronto-area municipal name aliases (post-1998 amalgamation).
  const aliases = new Map<string, string>([
    ["scarborough", "toronto"],
    ["etobicoke", "toronto"],
    ["north york", "toronto"],
    ["east york", "toronto"],
    ["york", "toronto"],
    ["woodbridge", "vaughan"],
    ["concord", "vaughan"],
    ["thornhill", "vaughan"],
    ["stoney creek", "hamilton-ca"],
    ["ancaster", "hamilton-ca"],
    ["dundas", "hamilton-ca"],
    ["flamborough", "hamilton-ca"],
    ["greater sudbury", "sudbury"],
    ["saint catharines", "st-catharines"],
    ["nepean", "ottawa"],
    ["kanata", "ottawa"],
    ["gloucester", "ottawa"],
    ["orleans", "ottawa"],
    ["barrie", "barrie"],
    ["guelph", "guelph"],
    ["kingston", "kingston-ca"],
    ["st catharines", "st-catharines"],
    ["st. catharines", "st-catharines"],
  ]);
  ontarioCityIndexCache = { exact, aliases };
  return ontarioCityIndexCache;
}

function mapCity(idx: CaOntarioCityIndex, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  if (idx.aliases.has(key)) return idx.aliases.get(key);
  if (idx.exact.has(key)) return idx.exact.get(key);
  return undefined;
}

function normaliseCaPhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

// --- CSV row → record ---------------------------------------------------

function isActiveStatus(status: string): boolean {
  const lower = status.toLowerCase();
  return ACTIVE_STATUSES.some((a) => lower.includes(a));
}

function pick(row: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = (row[k] ?? "").trim();
    if (v) return v;
  }
  return undefined;
}

// --- Main scrape --------------------------------------------------------

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const csvText = await downloadCsv();
  if (!csvText) return [];

  const rows = parseCsv(csvText);
  console.log(`[cpo-physio] parsed ${rows.length} CSV rows`);

  const cityIndex = await loadOntarioCityIndex();
  const out: ScrapedProfessional[] = [];
  let droppedStatus = 0;
  let droppedNoCity = 0;
  let droppedNoName = 0;
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;

    const name = pick(row, "name", "full_name", "fullname") ?? "";
    if (!name) {
      droppedNoName += 1;
      continue;
    }

    const status = pick(row, "registration_status", "status", "registration status") ?? "";
    if (status && !isActiveStatus(status)) {
      droppedStatus += 1;
      continue;
    }

    const rawCity = pick(row, "city", "municipality") ?? "";
    const citySlug = mapCity(cityIndex, rawCity);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }

    // Build a stable sourceId from name + city + postal code (no ID in CSV).
    const postalCode = pick(row, "postal_code", "postalcode", "postal code") ?? "";
    const sourceId = `cpo-physio:${name.toLowerCase().replace(/\s+/g, "_")}:${postalCode}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const clinicName = pick(row, "clinic_name", "clinicname", "clinic name") ?? "";
    const rawAddress = pick(row, "address") ?? "";
    const fullAddress = [rawAddress, rawCity, postalCode].filter(Boolean).join(", ");
    const rawPhone = pick(row, "phone") ?? "";

    out.push(
      normalise({
        source: "cpo-physio",
        sourceId,
        name,
        categoryKey: "fisioterapia",
        citySlug,
        phone: normaliseCaPhone(rawPhone),
        address: fullAddress || undefined,
        licenseNumber: undefined,
        metadata: {
          country: "CA",
          province: "ON",
          authority: "CPO",
          verified_by_authority: true,
          registration_status: status || undefined,
          clinic_name: clinicName || undefined,
          postal_code: postalCode || undefined,
        },
      }),
    );
  }

  console.log(
    `[cpo-physio] done: yielded=${out.length} ` +
      `droppedStatus=${droppedStatus} droppedNoCity=${droppedNoCity} ` +
      `droppedNoName=${droppedNoName}`,
  );
  return out;
}

export async function runCpoPhysio(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cpoPhysioSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const limitRaw = Number(process.env.PROLIO_CPO_PHYSIO_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

  const rows = await fetchAll(limit);
  if (rows.length === 0) {
    console.log(`[cpo-physio] 0 rows — nothing to upsert`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(rows);
  console.log(
    `[cpo-physio] upserted: inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: rows.length, inserted, updated, skipped };
}
