import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { getCities } from "../cities.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import {
  parseCsv,
  pick,
  normaliseNorthAmericanPhone,
} from "./_bulk-utils.js";

/**
 * College of Physiotherapists of Ontario — public register bulk CSV.
 *
 * Downloads the full registrant list (~19,305 records) from the CPO
 * public register endpoint. Maps physiotherapists to the `fisioterapia`
 * category for Ontario, Canada.
 *
 * Enable with `PROLIO_RUN_CPO_ON_PHYSIO=true`.
 * Override CSV URL with `PROLIO_CPO_ON_PHYSIO_CSV`.
 * Cap rows with `PROLIO_CPO_ON_PHYSIO_LIMIT` (default 5000).
 */

const DEFAULT_URL =
  "https://collegept.azurewebsites.net/PublicRegister/ContactSearchCSV";
const DEFAULT_LIMIT = 5000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// ---------------------------------------------------------------------------
// City index
// ---------------------------------------------------------------------------

let onCityCache: Map<string, string> | null = null;

async function loadOnCityIndex(): Promise<Map<string, string>> {
  if (onCityCache) return onCityCache;
  const cities = await getCities({ country: "CA" });
  const m = new Map<string, string>();
  for (const city of cities) {
    m.set(city.name.toLowerCase(), city.slug);
    m.set(city.slug.toLowerCase(), city.slug);
  }
  // Ontario-specific aliases (borough amalgamations + common variants)
  const aliases: [string, string][] = [
    ["north york", "toronto"],
    ["scarborough", "toronto"],
    ["etobicoke", "toronto"],
    ["york", "toronto"],
    ["east york", "toronto"],
    ["kanata", "ottawa"],
    ["nepean", "ottawa"],
    ["gloucester", "ottawa"],
    ["st catharines", "st-catharines"],
    ["saint catharines", "st-catharines"],
    ["greater sudbury", "sudbury"],
    ["thunder bay", "thunder-bay"],
    ["kingston", "kingston-ca"],
    ["burlington", "burlington-ca"],
    ["st. catharines", "st-catharines"],
  ];
  for (const [alias, slug] of aliases) m.set(alias, slug);
  onCityCache = m;
  return m;
}

function resolveCity(
  cityIndex: Map<string, string>,
  raw: string | undefined,
): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  return cityIndex.get(key) ?? cityIndex.get(slugify(raw));
}

// ---------------------------------------------------------------------------
// Status filter
// ---------------------------------------------------------------------------

const ACTIVE_TERMS = ["active", "registered"];
const INACTIVE_TERMS = ["revoked", "suspended", "resigned", "cancelled", "expired"];

function isActiveStatus(status: string): boolean {
  const s = status.toLowerCase();
  if (INACTIVE_TERMS.some((t) => s.includes(t))) return false;
  if (ACTIVE_TERMS.some((t) => s.includes(t))) return true;
  // Unknown status — skip to be conservative
  return false;
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------

async function fetchAll(
  client: SupabaseClient,
  cityIndex: Map<string, string>,
  limit: number,
): Promise<{
  rows: ScrapedProfessional[];
  droppedStatus: number;
  droppedNoName: number;
  droppedNoCity: number;
}> {
  const url = process.env.PROLIO_CPO_ON_PHYSIO_CSV ?? DEFAULT_URL;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(
      `[cpo-on-physio] network error: ${(error as Error).message}`,
    );
    return { rows: [], droppedStatus: 0, droppedNoName: 0, droppedNoCity: 0 };
  }

  if (!response.ok) {
    console.error(`[cpo-on-physio] ${response.status} fetching ${url}`);
    return { rows: [], droppedStatus: 0, droppedNoName: 0, droppedNoCity: 0 };
  }

  const csvText = await response.text();
  const parsed = parseCsv(csvText);

  const out: ScrapedProfessional[] = [];
  let droppedStatus = 0;
  let droppedNoName = 0;
  let droppedNoCity = 0;

  for (const row of parsed) {
    if (out.length >= limit) break;

    // Status filter
    const status = pick(row, [
      "registration_status",
      "status",
      "licence_status",
    ]);
    if (!isActiveStatus(status)) {
      droppedStatus += 1;
      continue;
    }

    // Name — try combined full-name field first, then first+last
    let name = pick(row, [
      "name",
      "full_name",
      "registrant_name",
      "registrant",
    ]);
    if (!name) {
      const first = pick(row, ["first_name"]);
      const last = pick(row, ["last_name", "surname", "family_name"]);
      name = [first, last].filter(Boolean).join(" ").trim();
    }
    if (!name) {
      droppedNoName += 1;
      continue;
    }

    // Registration number (used for stable sourceId)
    const regNumber = pick(row, [
      "registration_number",
      "reg_number",
      "registration_no",
      "regno",
      "id",
      "number",
    ]);

    // City resolution: prefer the pre-seeded CA index (canonical slugs +
    // Ontario amalgamation aliases); otherwise auto-seed the city by name so
    // long-tail ON municipalities are not dropped. Rows with no city at all
    // keep citySlug:"" so the sink preserves them with a NULL city.
    const rawCity = pick(row, ["city", "municipality", "town"]);
    let citySlug = resolveCity(cityIndex, rawCity) ?? "";
    if (!citySlug && rawCity) {
      const cityResult = await ensureCity(client, {
        name: rawCity,
        state: "ON",
        country: "CA",
      });
      if (cityResult) citySlug = cityResult.slug;
    }
    if (!citySlug) droppedNoCity += 1;

    // Address fields
    const street = pick(row, [
      "address",
      "street_address",
      "address_line1",
      "street",
    ]);
    const postalCode = pick(row, [
      "postal_code",
      "postalcode",
      "postcode",
      "zip",
      "pc",
    ]);
    const clinicName = pick(row, [
      "clinic_name",
      "employer",
      "practice_name",
      "organization",
      "clinic",
      "workplace",
    ]);
    const addressParts = [street, rawCity, "ON", postalCode]
      .map((p) => p?.trim())
      .filter(Boolean);
    const address = addressParts.length > 0 ? addressParts.join(", ") : undefined;

    const phone = normaliseNorthAmericanPhone(
      pick(row, ["phone", "telephone", "phone_number", "tel"]) || undefined,
    );

    const sourceId = regNumber
      ? `cpo-on-physio:${regNumber}`
      : `cpo-on-physio:${slugify(name)}-${citySlug}`;

    out.push(
      normalise({
        source: "cpo-on-physio" as ScrapeSource,
        country: "CA",
        sourceId,
        name,
        categoryKey: "fisioterapia",
        citySlug,
        phone,
        address,
        licenseNumber: regNumber || undefined,
        metadata: {
          country: "CA",
          province: "ON",
          authority: "College of Physiotherapists of Ontario",
          verified_by_authority: true,
          registration_status: status || undefined,
          clinic_name: clinicName || undefined,
        },
      }),
    );
  }

  const cs = getCityUpsertStats();
  console.log(
    `[cpo-on-physio] parsed=${out.length} droppedNoCity=${droppedNoCity} droppedStatus=${droppedStatus} droppedNoName=${droppedNoName} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );

  return { rows: out, droppedStatus, droppedNoName, droppedNoCity };
}

// ---------------------------------------------------------------------------
// Exported source object + run function
// ---------------------------------------------------------------------------

export const cpoOnPhysioSource: ScraperSource = {
  name: "cpo-on-physio" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CPO_ON_PHYSIO === "true";
  },
  async fetch(): Promise<ScrapedProfessional[]> {
    return [];
  },
};

export async function runCpoOnPhysio(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cpoOnPhysioSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(
    process.env.PROLIO_CPO_ON_PHYSIO_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const cityIndex = await loadOnCityIndex();
  const client = getSupabaseClient();

  return withScrapeRun("cpo-on-physio", async () => {
    const { rows, droppedStatus, droppedNoName, droppedNoCity } =
      await fetchAll(client, cityIndex, limit);

    if (rows.length === 0) {
      return {
        fetched: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        rowsFetched: 0,
        rowsUpserted: 0,
        rowsSkipped: 0,
      };
    }

    const sink = getSink({ trustCitySlugs: true });
    const { inserted, updated, skipped } = await sink.upsert(rows);

    console.log(
      `[cpo-on-physio] done — fetched=${rows.length} inserted=${inserted} updated=${updated} skipped=${skipped} ` +
        `droppedStatus=${droppedStatus} droppedNoCity=${droppedNoCity} droppedNoName=${droppedNoName}`,
    );

    return {
      fetched: rows.length,
      inserted,
      updated,
      skipped,
      rowsFetched: rows.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
    };
  });
}
