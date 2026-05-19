import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { US_CITIES } from "../cities.js";
import { getSink } from "../sink.js";

/**
 * HIFLD — Homeland Infrastructure Foundation-Level Data (DHS).
 *
 * Aggregates four HIFLD ArcGIS FeatureServers into the `medicina`
 * category: Hospitals (~7.5k), Urgent Care (~4.8k), Nursing Homes
 * (~53k), EMS Stations (~43k). All datasets are open, no auth, no
 * CAPTCHA — standard ArcGIS REST `query` endpoints with paginated
 * `resultOffset`/`resultRecordCount`.
 *
 * Pre-flight (2026-05-14):
 *   FeatureServer URLs (verified via /query?returnCountOnly=true):
 *     Hospitals     → services.arcgis.com/XG15cJAlne2vxtgt/.../Hospitals_hifld/FeatureServer/0           7,570 rows
 *     Urgent Care   → services.arcgis.com/XG15cJAlne2vxtgt/.../Urgent_Care_Facilities_RAPT/FeatureServer/11  4,810 rows
 *     Nursing Homes → services.arcgis.com/XG15cJAlne2vxtgt/.../Nursing_Homes_RAPT/FeatureServer/7        53,129 rows
 *     EMS Stations  → services5.arcgis.com/HDRa0B57OVrv2E1q/.../Emergency_Medical_Service_Stations/FeatureServer/0  42,812 rows
 *   Auth / WAF  — none. Public anonymous access on all four layers.
 *
 * Records are filtered to known US city slugs (case-insensitive
 * CITY+STATE match against `US_CITIES`). Anything outside the seeded
 * 20-city set is dropped — the sink would reject for missing FK.
 *
 * All four datasets map to category `medicina` (Prolio's medical
 * bucket). Off by default. Enable with `PROLIO_RUN_HIFLD_US=true`.
 * Cap with `PROLIO_HIFLD_US_LIMIT` (default 100000) — total across
 * all four datasets combined.
 *
 * Monthly cron — HIFLD updates the layers a few times per year; data
 * is slow-moving. See `.github/workflows/scrape-hifld-us.yml`.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 45_000;
const REQUEST_DELAY_MS = 600;
const PAGE_SIZE = 2000;
const DEFAULT_LIMIT = 100_000;

interface HifldDataset {
  /** Label for logs + metadata. */
  label: string;
  /** Full ArcGIS layer URL (without /query). */
  layerUrl: string;
  /** Field name aliases — lower/upper case varies per dataset. */
  fields: {
    id: string[];
    name: string[];
    address: string[];
    city: string[];
    state: string[];
    zip: string[];
    phone: string[];
    website?: string[];
    lat: string[];
    lng: string[];
    type?: string[];
    status?: string[];
  };
}

const HIFLD_DATASETS: readonly HifldDataset[] = [
  {
    label: "hospitals",
    layerUrl:
      "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_hifld/FeatureServer/0",
    fields: {
      id: ["ID"],
      name: ["NAME"],
      address: ["ADDRESS"],
      city: ["CITY"],
      state: ["STATE"],
      zip: ["ZIP"],
      phone: ["TELEPHONE"],
      website: ["WEBSITE"],
      lat: ["LATITUDE"],
      lng: ["LONGITUDE"],
      type: ["TYPE"],
      status: ["STATUS"],
    },
  },
  {
    label: "urgent-care",
    layerUrl:
      "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Urgent_Care_Facilities_RAPT/FeatureServer/11",
    fields: {
      id: ["id", "ID"],
      name: ["name", "NAME"],
      address: ["address", "ADDRESS"],
      city: ["city", "CITY"],
      state: ["state", "STATE"],
      zip: ["zip", "ZIP"],
      phone: ["telephone", "TELEPHONE"],
      lat: ["y", "LATITUDE"],
      lng: ["x", "LONGITUDE"],
    },
  },
  {
    label: "nursing-homes",
    layerUrl:
      "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Nursing_Homes_RAPT/FeatureServer/7",
    fields: {
      id: ["ID"],
      name: ["NAME"],
      address: ["ADDRESS"],
      city: ["CITY"],
      state: ["STATE"],
      zip: ["ZIP"],
      phone: ["TELEPHONE"],
      website: ["WEBSITE"],
      lat: ["LATITUDE"],
      lng: ["LONGITUDE"],
      type: ["TYPE"],
      status: ["STATUS"],
    },
  },
  {
    label: "ems-stations",
    layerUrl:
      "https://services5.arcgis.com/HDRa0B57OVrv2E1q/arcgis/rest/services/Emergency_Medical_Service_Stations/FeatureServer/0",
    fields: {
      id: ["ID", "PERM_ID"],
      name: ["NAME"],
      address: ["ADDRESS"],
      city: ["CITY"],
      state: ["STATE"],
      zip: ["ZIP"],
      phone: ["TELEPHONE", "EMERGTEL"],
      lat: ["LATITUDE"],
      lng: ["LONGITUDE"],
      type: ["SPECIALTY", "LEVEL_"],
    },
  },
];

// --- City matching ----------------------------------------------------

/**
 * Build a (city-name-lower, state-abbr) → city-slug lookup. HIFLD
 * stores city in uppercase ASCII (e.g. "NEW YORK") and state as a
 * two-letter abbreviation (e.g. "NY"). We need to disambiguate
 * Columbus-OH and Brooklyn-NY style cases, so we encode the state
 * for collision-prone slugs.
 */
const CITY_SLUG_LOOKUP: Map<string, string> = (() => {
  const map = new Map<string, string>();
  // Most US_CITIES slugs match cleanly; a couple have known state
  // suffixes. Encode the cities we want to keep and the state most
  // likely to host them.
  const cityState: Array<[string, string, string]> = [
    ["new york", "NY", "new-york"],
    ["los angeles", "CA", "los-angeles"],
    ["chicago", "IL", "chicago"],
    ["houston", "TX", "houston"],
    ["phoenix", "AZ", "phoenix"],
    ["philadelphia", "PA", "philadelphia"],
    ["san antonio", "TX", "san-antonio"],
    ["san diego", "CA", "san-diego"],
    ["dallas", "TX", "dallas"],
    ["san jose", "CA", "san-jose"],
    ["austin", "TX", "austin"],
    ["jacksonville", "FL", "jacksonville"],
    ["fort worth", "TX", "fort-worth"],
    ["columbus", "OH", "columbus-oh"],
    ["charlotte", "NC", "charlotte"],
    ["indianapolis", "IN", "indianapolis"],
    ["san francisco", "CA", "san-francisco"],
    ["seattle", "WA", "seattle"],
    ["denver", "CO", "denver"],
    ["washington", "DC", "washington-dc"],
  ];
  // Guard: only accept slugs that actually exist in US_CITIES.
  const slugs = new Set(US_CITIES.map((c) => c.slug));
  for (const [city, state, slug] of cityState) {
    if (slugs.has(slug)) {
      map.set(`${city}|${state}`, slug);
    }
  }
  return map;
})();

function mapHifldCity(
  rawCity: string | null | undefined,
  rawState: string | null | undefined,
): string | undefined {
  if (!rawCity || !rawState) return undefined;
  const city = String(rawCity).trim().toLowerCase();
  const state = String(rawState).trim().toUpperCase();
  return CITY_SLUG_LOOKUP.get(`${city}|${state}`);
}

// --- ArcGIS helpers ---------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normaliseUsPhone(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

function pickField(
  attrs: Record<string, unknown>,
  candidates: string[] | undefined,
): unknown {
  if (!candidates) return undefined;
  for (const k of candidates) {
    if (k in attrs && attrs[k] !== null && attrs[k] !== "" && attrs[k] !== "NOT AVAILABLE") {
      return attrs[k];
    }
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s || s === "NOT AVAILABLE" || s === "-999") return undefined;
  return s;
}

function asNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

async function fetchPage(
  layerUrl: string,
  offset: number,
): Promise<ArcgisFeature[] | null> {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    orderByFields: "OBJECTID ASC",
  });
  const url = `${layerUrl}/query?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": POLITE_UA, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(`[hifld-us] offset=${offset} status=${response.status}`);
      return null;
    }
    const json = (await response.json()) as {
      features?: ArcgisFeature[];
      error?: { message?: string };
    };
    if (json.error) {
      console.warn(`[hifld-us] offset=${offset} api-error=${json.error.message}`);
      return null;
    }
    return json.features ?? [];
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[hifld-us] offset=${offset} error=${(err as Error).message}`);
    return null;
  }
}

// --- Public API -------------------------------------------------------

export const hifldUsSource: ScraperSource = {
  name: "hifld-us" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_HIFLD_US === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runHifldUs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!hifldUsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(process.env.PROLIO_HIFLD_US_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const sink = getSink();
  const seen = new Set<string>();
  const category: CategoryKey = "medicina";

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let droppedNoCity = 0;
  let droppedNoName = 0;
  let droppedClosed = 0;

  for (const ds of HIFLD_DATASETS) {
    if (totalFetched >= limit) break;
    console.log(`[hifld-us] fetching ${ds.label} → ${ds.layerUrl}`);
    let offset = 0;
    let dsCount = 0;

    for (;;) {
      if (totalFetched >= limit) break;
      const page = await fetchPage(ds.layerUrl, offset);
      if (!page) break;
      if (page.length === 0) break;

      const batch: ScrapedProfessional[] = [];
      for (const feat of page) {
        if (totalFetched >= limit) break;
        const attrs = feat.attributes ?? {};

        const status = asString(pickField(attrs, ds.fields.status));
        if (status && /CLOSE|CLOSED/i.test(status)) {
          droppedClosed += 1;
          continue;
        }

        const rawId = asString(pickField(attrs, ds.fields.id));
        const sourceId = `hifld-us:${ds.label}:${rawId ?? attrs.OBJECTID ?? attrs.OBJECTID_1 ?? offset}`;
        if (seen.has(sourceId)) continue;

        const name = asString(pickField(attrs, ds.fields.name));
        if (!name) {
          droppedNoName += 1;
          continue;
        }

        const cityRaw = asString(pickField(attrs, ds.fields.city));
        const stateRaw = asString(pickField(attrs, ds.fields.state));
        const citySlug = mapHifldCity(cityRaw, stateRaw);
        if (!citySlug) {
          droppedNoCity += 1;
          continue;
        }

        seen.add(sourceId);
        totalFetched += 1;
        dsCount += 1;

        const addressParts = [
          asString(pickField(attrs, ds.fields.address)),
          cityRaw,
          stateRaw,
          asString(pickField(attrs, ds.fields.zip)),
        ].filter(Boolean) as string[];

        const lat =
          asNumber(pickField(attrs, ds.fields.lat)) ??
          (typeof feat.geometry?.y === "number" ? feat.geometry.y : undefined);
        const lng =
          asNumber(pickField(attrs, ds.fields.lng)) ??
          (typeof feat.geometry?.x === "number" ? feat.geometry.x : undefined);

        const websiteRaw = asString(pickField(attrs, ds.fields.website));
        const facilityType = asString(pickField(attrs, ds.fields.type));

        batch.push(
          normalise({
            source: "hifld-us" as ScrapeSource,
            country: "US",
            sourceId,
            name: name
              .split(" ")
              .map((w) => (w.length > 1 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
              .join(" "),
            categoryKey: category,
            citySlug,
            phone: normaliseUsPhone(pickField(attrs, ds.fields.phone)),
            website: websiteRaw && /^https?:\/\//i.test(websiteRaw) ? websiteRaw : undefined,
            address: addressParts.length > 0 ? addressParts.join(", ") : undefined,
            lat,
            lng,
            metadata: {
              country: "US",
              state: stateRaw,
              city: cityRaw,
              hifld_dataset: ds.label,
              hifld_id: rawId,
              facility_type: facilityType,
              facility_status: status,
              verified_by_authority: true,
              authority: "DHS HIFLD",
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
          `[hifld-us] ${ds.label} offset=${offset} ` +
            `kept=${batch.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
        );
      }

      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      await delay(REQUEST_DELAY_MS);
    }

    console.log(`[hifld-us] ${ds.label} done — kept=${dsCount}`);
  }

  console.log(
    `[hifld-us] done — fetched=${totalFetched} inserted=${totalInserted} ` +
      `updated=${totalUpdated} skipped=${totalSkipped} ` +
      `droppedNoCity=${droppedNoCity} droppedNoName=${droppedNoName} droppedClosed=${droppedClosed}`,
  );
  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    skipped: totalSkipped,
  };
}
