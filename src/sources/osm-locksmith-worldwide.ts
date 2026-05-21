/**
 * Worldwide OSM locksmith bulk re-ingest.
 *
 * Why this exists separately from `osm.ts`:
 *   - `osm.ts` iterates `(city, category)` ScrapeTargets and queries
 *     Overpass per municipality (`area["name"=…]["admin_level"="8"]`).
 *     That works for the seeded 91-city catalogue but never touches the
 *     long tail of cities where locksmiths actually cluster, and it
 *     leaves the cerrajero category sitting at ~570 rows globally — well
 *     below OSM's true worldwide coverage of ~30-50k tagged locksmiths.
 *   - For cerrajero specifically, we want a single periodic sweep of
 *     every `craft=locksmith` and `shop=locksmith` element on the
 *     planet, and let the sink drop any whose `addr:city` doesn't slug
 *     into our seeded city set. Continental bboxes keep each Overpass
 *     query under the 900 s server timeout.
 *
 * Compatibility: emits rows with `source='osm'` and
 * `source_id='<type>/<id>'` — identical to `osm.ts` — so the
 * `(source, source_id)` unique index dedupes against the existing 570
 * rows on upsert; we don't create duplicates.
 *
 * Etiquette: sequential continent queries with a long inter-request
 * sleep, a descriptive User-Agent, conservative retries on 429/504.
 * The public Overpass endpoint is a shared resource — don't get banned.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { slugifyName } from "../lib/slug-id.js";
import { buildSlug } from "../normalise.js";

const ENDPOINT =
  process.env.PROLIO_OVERPASS_ENDPOINT ??
  "https://overpass-api.de/api/interpreter";

// Long server-side timeout (15 min). Continental sweeps return tens of
// thousands of elements; the default 25 s isn't enough.
const TIMEOUT_SEC = 900;
// Pause between continental queries. Overpass's fair-use guidance is
// "don't hammer it" — 30 s gives the server time to release the slot.
const SLEEP_BETWEEN_MS = 30_000;
const MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 60_000;

/**
 * Continental bboxes (south, west, north, east). The Earth is sliced
 * into chunks small enough that each Overpass response stays under the
 * server memory cap (~2 GB) while still completing inside TIMEOUT_SEC.
 *
 * Order matters: heaviest regions last so a mid-run failure still
 * yields useful data from the lighter ones.
 */
const REGIONS: Array<{ name: string; bbox: [number, number, number, number] }> =
  [
    { name: "oceania", bbox: [-50, 110, 10, 180] },
    { name: "south-america", bbox: [-60, -90, 15, -30] },
    { name: "africa", bbox: [-40, -20, 38, 55] },
    { name: "asia", bbox: [-10, 55, 60, 150] },
    { name: "north-america", bbox: [5, -170, 75, -50] },
    { name: "europe", bbox: [34, -25, 72, 45] },
  ];

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBboxQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  // Both shop=locksmith and craft=locksmith. Use `nwr` to capture
  // nodes/ways/relations in one go; emit `center` so areas get a
  // representative lat/lng.
  return `[out:json][timeout:${TIMEOUT_SEC}];
(
  nwr["shop"="locksmith"](${s},${w},${n},${e});
  nwr["craft"="locksmith"](${s},${w},${n},${e});
);
out center tags;`;
}

async function fetchRegion(
  region: { name: string; bbox: [number, number, number, number] },
): Promise<OverpassElement[]> {
  const query = buildBboxQuery(region.bbox);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Prolio-locksmith-bulk/0.1 (ferranp.work@gmail.com)",
        },
        body: new URLSearchParams({ data: query }).toString(),
      });
    } catch (error) {
      console.error(
        `[osm-locksmith] network error on ${region.name}:`,
        (error as Error).message,
      );
      if (attempt === MAX_RETRIES) return [];
      await delay(BACKOFF_BASE_MS * Math.pow(2, attempt));
      continue;
    }

    if (response.ok) {
      try {
        const data = (await response.json()) as OverpassResponse;
        return data.elements ?? [];
      } catch {
        console.error(`[osm-locksmith] invalid JSON on ${region.name}`);
        return [];
      }
    }

    // 429 = rate limit; 504 = slot exhausted; 503 = quota — all back off.
    if (
      response.status !== 429 &&
      response.status !== 503 &&
      response.status !== 504
    ) {
      const text = await response.text();
      console.error(
        `[osm-locksmith] ${response.status} on ${region.name}: ${text.slice(0, 200)}`,
      );
      return [];
    }
    if (attempt === MAX_RETRIES) {
      console.error(
        `[osm-locksmith] giving up on ${region.name} after ${MAX_RETRIES + 1} tries (last ${response.status})`,
      );
      return [];
    }
    const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
    console.warn(
      `[osm-locksmith] ${response.status} on ${region.name}, retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
    );
    await delay(backoff);
  }
  return [];
}

interface CityIndex {
  /** slugified city name → canonical seeded slug */
  bySlug: Map<string, { slug: string; name: string }>;
}

async function loadCityIndex(client: SupabaseClient): Promise<CityIndex> {
  const bySlug = new Map<string, { slug: string; name: string }>();
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await client
      .from("cities")
      .select("slug, name")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`loadCityIndex: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      bySlug.set(row.slug as string, {
        slug: row.slug as string,
        name: row.name as string,
      });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { bySlug };
}

function buildAddress(tags: Record<string, string>): string | null {
  const street = tags["addr:street"];
  if (!street) return null;
  const parts: string[] = [street];
  if (tags["addr:housenumber"]) parts.push(tags["addr:housenumber"]);
  let line = parts.join(" ");
  const postcode = tags["addr:postcode"];
  const city = tags["addr:city"];
  if (postcode || city) {
    line += `, ${[postcode, city].filter(Boolean).join(" ")}`;
  }
  return line;
}

interface UpsertPayload {
  source: "osm";
  source_id: string;
  slug: string;
  name: string;
  category_key: "cerrajero";
  city_slug: string;
  headline: string;
  description: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  opening_hours: string[] | null;
  metadata: Record<string, unknown>;
  is_published: boolean;
  tier: "free";
  claim_status: "unclaimed";
}

const UPSERT_BATCH = Number(process.env.PROLIO_SINK_BATCH ?? "2000");

async function upsertBatched(
  client: SupabaseClient,
  rows: UpsertPayload[],
): Promise<{ written: number }> {
  let written = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const slice = rows.slice(i, i + UPSERT_BATCH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (client.from("professionals") as any).upsert(
      slice,
      { onConflict: "source,source_id" },
    );
    if (error) {
      console.error(
        `[osm-locksmith] batch upsert failed (${slice.length} rows):`,
        error.message,
      );
      continue;
    }
    written += slice.length;
  }
  return { written };
}

export async function runOsmLocksmithWorldwide(
  client: SupabaseClient,
): Promise<{ fetched: number; accepted: number; written: number }> {
  console.log(`[osm-locksmith] worldwide sweep starting (${REGIONS.length} regions)`);
  const cities = await loadCityIndex(client);
  console.log(`[osm-locksmith] loaded ${cities.bySlug.size} city slugs`);

  // Dedup across overlapping bboxes (none should overlap, but cheap
  // insurance against future bbox edits).
  const seen = new Set<string>();
  const payloads: UpsertPayload[] = [];
  let fetched = 0;

  for (const region of REGIONS) {
    console.log(`[osm-locksmith] querying ${region.name}…`);
    const elements = await fetchRegion(region);
    fetched += elements.length;
    console.log(`[osm-locksmith]   ${region.name}: ${elements.length} elements`);

    for (const el of elements) {
      const tags = el.tags ?? {};
      const name = tags.name?.trim();
      if (!name) continue;

      const sourceId = `${el.type}/${el.id}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const cityRaw = tags["addr:city"]?.trim();
      if (!cityRaw) continue;
      const citySlug = slugifyName(cityRaw);
      const cityMatch = cities.bySlug.get(citySlug);
      if (!cityMatch) continue;

      const lat = el.lat ?? el.center?.lat ?? null;
      const lon = el.lon ?? el.center?.lon ?? null;
      const phone =
        tags.phone?.trim() ?? tags["contact:phone"]?.trim() ?? null;
      const email =
        tags.email?.trim().toLowerCase() ??
        tags["contact:email"]?.trim().toLowerCase() ??
        null;
      const website =
        tags.website?.trim() ??
        tags["contact:website"]?.trim() ??
        tags.url?.trim() ??
        null;

      payloads.push({
        source: "osm",
        source_id: sourceId,
        slug: buildSlug(name, cityMatch.slug),
        name,
        category_key: "cerrajero",
        city_slug: cityMatch.slug,
        headline: `Cerrajero en ${cityMatch.name}`,
        description: `${name} — datos públicos de OpenStreetMap (ODbL).`,
        phone,
        email,
        website,
        address: buildAddress(tags),
        lat,
        lng: lon,
        opening_hours: tags.opening_hours ? [tags.opening_hours] : null,
        metadata: {
          osm_type: el.type,
          region: region.name,
          tags,
        },
        is_published: true,
        tier: "free",
        claim_status: "unclaimed",
      });
    }

    // Be a good Overpass citizen — sleep between continents.
    if (region !== REGIONS[REGIONS.length - 1]) {
      await delay(SLEEP_BETWEEN_MS);
    }
  }

  console.log(
    `[osm-locksmith] fetched=${fetched} accepted=${payloads.length}; upserting…`,
  );
  const { written } = await upsertBatched(client, payloads);
  console.log(
    `[osm-locksmith] done — fetched=${fetched} accepted=${payloads.length} written=${written}`,
  );
  return { fetched, accepted: payloads.length, written };
}

export const osmLocksmithWorldwideSource = {
  name: "osm-locksmith-worldwide" as const,
  enabled(): boolean {
    return process.env.PROLIO_RUN_OSM_LOCKSMITH_WORLDWIDE === "true";
  },
};
