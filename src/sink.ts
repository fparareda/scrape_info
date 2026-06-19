import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Category, CategoryKey, Locale } from "./prolio-types.js";
import type { ScrapedProfessional } from "./types.js";
import { buildSlug } from "./normalise.js";
import { generateProfileCopy } from "./seo-copy.js";

// `country` is required on ScrapedProfessional (enforced by TS). No
// fallback map: every scraper has to declare its country explicitly.
function resolveCountry(
  record: ScrapedProfessional,
): "ES" | "CA" | "US" | "FR" | "MX" | "GB" | "CO" {
  return record.country;
}

const SEO_LOCALES: Locale[] = ["es", "en", "fr"];

interface Sink {
  upsert(records: ScrapedProfessional[]): Promise<{
    inserted: number;
    updated: number;
    skipped: number;
  }>;
}

export function getSink(opts: { trustCitySlugs?: boolean } = {}): Sink {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Scraper requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Lazy-loaded lookups for seo-copy generation. We need city_name and
  // category names/plurals keyed by slug/key — neither are in the
  // ScrapedProfessional payload. Load once per process run.
  let lookupsPromise: Promise<{
    cityNameBySlug: Map<string, string>;
    categoryByKey: Map<CategoryKey, Pick<Category, "names" | "pluralNames">>;
  }> | undefined;
  async function loadLookups(): Promise<{
    cityNameBySlug: Map<string, string>;
    categoryByKey: Map<CategoryKey, Pick<Category, "names" | "pluralNames">>;
  }> {
    if (!lookupsPromise) {
      lookupsPromise = (async () => {
        const cityNameBySlug = new Map<string, string>();
        // Paginate without a hardcoded upper bound — the cities table
        // grew past 17.5k rows (ES alone is ~8k) and the previous 10k
        // cap caused half of cities to be invisible to the sink.
        for (let from = 0; ; from += 1000) {
          const { data, error } = await client
            .from("cities")
            .select("slug, name")
            .range(from, from + 999);
          if (error || !data || data.length === 0) break;
          for (const row of data) {
            cityNameBySlug.set(row.slug as string, row.name as string);
          }
          if (data.length < 1000) break;
        }
        const categoryByKey = new Map<
          CategoryKey,
          Pick<Category, "names" | "pluralNames">
        >();
        const { data: catRows } = await client
          .from("categories")
          .select(
            "key, name_es, name_en, name_fr, plural_name_es, plural_name_en, plural_name_fr",
          );
        for (const row of catRows ?? []) {
          categoryByKey.set(row.key as CategoryKey, {
            names: {
              es: row.name_es as string,
              en: row.name_en as string,
              fr: row.name_fr as string,
            },
            pluralNames: {
              es: row.plural_name_es as string,
              en: row.plural_name_en as string,
              fr: row.plural_name_fr as string,
            },
          });
        }
        return { cityNameBySlug, categoryByKey };
      })();
    }
    return lookupsPromise;
  }

  // Lazy-loaded set of valid (country, slug) keys. Keyed by
  // `${country}::${slug}` so a slug present in multiple countries (eg
  // `guadalajara` in both ES and MX once both rows are seeded) is a hit
  // only when the source's declared country matches. Without this check
  // ~5,500 rows from MX/FR sources were silently landing on ES/CA rows
  // with the same slug. Migration 0084-0088 + `source-country.ts` made
  // the country dimension authoritative.
  let cityKeysPromise: Promise<Set<string>> | undefined;
  async function loadCityKeys(): Promise<Set<string>> {
    if (!cityKeysPromise) {
      cityKeysPromise = (async () => {
        const keys = new Set<string>();
        // Paginate so we're not bitten by PostgREST's 1000-row cap.
        // No upper bound: the table has grown past 17.5k rows (ES alone
        // is ~8k). The previous `from < 10_000` cap silently dropped
        // every gmaps row whose (country, slug) lived past row 10k,
        // which surfaced as the `[sink] dropped N/200 rows with
        // unseeded (country, city_slug)` warning.
        for (let from = 0; ; from += 1000) {
          const { data, error } = await client
            .from("cities")
            .select("country, slug")
            .range(from, from + 999);
          if (error || !data || data.length === 0) break;
          for (const row of data)
            keys.add(`${row.country as string}::${row.slug as string}`);
          if (data.length < 1000) break;
        }
        return keys;
      })();
    }
    return cityKeysPromise;
  }

  return {
    upsert: async (records) => {
      // trustCitySlugs (bulk opt-in): the source guarantees every
      // citySlug already exists in `cities` — it called ensureCity()
      // per row to auto-seed unknown municipalities. So we SKIP the
      // drop filter entirely; bulk national sources must not lose rows
      // for cities that weren't pre-seeded. Contract: a trusted source
      // that emits a slug with no matching cities row will hit an FK
      // violation at upsert (that's the source's bug to fix, not a
      // silent drop). Search-by-city sources omit the flag and keep the
      // strict drop, where an unseeded slug signals a bad target.
      const validKeys = opts.trustCitySlugs ? null : await loadCityKeys();
      let droppedSlug = 0;
      const filtered =
        validKeys === null
          ? records
          : records.filter((r) => {
              // Empty citySlug = province-granularity row (sink writes
              // city_slug=NULL, populates metadata.province_slug instead).
              if (r.citySlug === "") return true;
              if (!validKeys.has(`${r.country}::${r.citySlug}`)) {
                droppedSlug += 1;
                return false;
              }
              return true;
            });
      if (droppedSlug > 0) {
        console.log(
          `[sink] dropped ${droppedSlug}/${records.length} rows with unseeded (country, city_slug)`,
        );
      }
      const lookups = await loadLookups();
      const result = await upsertBatch(client, filtered, lookups);
      // Surface slug-drops in the skipped counter so callers log an
      // accurate total. Previously they disappeared silently between
      // the source's fetched= and inserted+updated+skipped= numbers.
      return { ...result, skipped: result.skipped + droppedSlug };
    },
  };
}

interface SeoLookups {
  cityNameBySlug: Map<string, string>;
  categoryByKey: Map<CategoryKey, Pick<Category, "names" | "pluralNames">>;
}

// Bulk ingest can skip per-row SEO copy generation (3 large TEXT columns +
// CPU per row). Pages fall back to generating copy at request time when
// seo_copy_* is null, so this is lossless for the reader and a big write
// saving for million-row registries. Toggle via PROLIO_SINK_SKIP_SEOCOPY.
const SKIP_SEO_COPY = process.env.PROLIO_SINK_SKIP_SEOCOPY === "true";

function seoCopyFields(
  record: ScrapedProfessional,
  lookups: SeoLookups,
): Record<string, string | null> {
  if (SKIP_SEO_COPY) {
    return { seo_copy_es: null, seo_copy_en: null, seo_copy_fr: null };
  }
  const cityName = lookups.cityNameBySlug.get(record.citySlug);
  const category = lookups.categoryByKey.get(record.categoryKey);
  // If either lookup misses we skip SEO copy for this row rather than
  // emit garbled strings. The page will fall back to generating copy at
  // request time from in-memory category/city data.
  if (!cityName || !category) {
    return {
      seo_copy_es: null,
      seo_copy_en: null,
      seo_copy_fr: null,
    };
  }
  const out: Record<string, string | null> = {};
  for (const locale of SEO_LOCALES) {
    out[`seo_copy_${locale}`] = generateProfileCopy(
      {
        name: record.name,
        licenseNumber: record.licenseNumber,
        openingHours: record.openingHours,
        rating: record.rating,
        reviewCount: record.reviewCount,
      },
      category,
      { name: cityName },
      locale,
    );
  }
  return out;
}

// Tunable at runtime via env (default 2000). At 500 the CCAA run hit
// the 45min CI timeout — each slice does one SELECT + one UPSERT and
// the network round-trip dominates, so larger slices = fewer
// round-trips = much faster total. Supabase tolerates up to ~5k rows
// per upsert before URL size issues.
// `||` (not `??`) so empty-string env vars passed by GH Actions when
// the source-specific override is unset fall through to the default
// instead of becoming Number("") = 0 → instant empty-batch loop.
const BATCH_SIZE = Number(process.env.PROLIO_SINK_BATCH || "2000");
const EXISTING_LOOKUP_CHUNK = Number(
  process.env.PROLIO_SINK_LOOKUP_CHUNK || "500",
);

/**
 * Batch upsert backed by the (source, source_id) unique index
 * (migration 0019). Flow per batch:
 *
 *   1. SELECT existing (id, source_id, claim_status, slug) for every
 *      (source, source_id) in the batch. One round-trip.
 *   2. Filter out rows whose claim_status is not `unclaimed` — those
 *      are owner-curated, don't touch.
 *   3. Build Insert payloads. New rows get a generated slug; updates
 *      keep the row's existing slug.
 *   4. Single `upsert({ onConflict: "source,source_id" })` call. One
 *      round-trip.
 *
 * Slug collisions still happen (two different source rows normalising
 * to the same slug). We detect 23505 at the batch boundary and retry
 * those specific rows with a numeric suffix.
 */
async function upsertBatch(
  client: SupabaseClient,
  records: ScrapedProfessional[],
  lookups: SeoLookups,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const slice = records.slice(i, i + BATCH_SIZE);
    const res = await upsertSlice(client, slice, lookups);
    inserted += res.inserted;
    updated += res.updated;
    skipped += res.skipped;
  }
  return { inserted, updated, skipped };
}

interface ExistingRow {
  id: string;
  source: string;
  source_id: string;
  slug: string;
  claim_status: string;
}

async function upsertSlice(
  client: SupabaseClient,
  slice: ScrapedProfessional[],
  lookups: SeoLookups,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  // FAST-PATH (PROLIO_SINK_SKIP_LOOKUP=true): skip the SELECT-existing
  // round-trips entirely and just rely on the (source,source_id) unique
  // index + ON CONFLICT DO NOTHING. Use this for bulk-ingest sources
  // where we know rows are brand new (e.g. denue-mx-bulk first import).
  // Loses the "skip claimed rows" guarantee, but the brand-new source
  // can't have claimed anything yet, so it's safe. Reduces 50+ select
  // round-trips per slice to 0 → unblocks parallel shards.
  if (process.env.PROLIO_SINK_SKIP_LOOKUP === "true") {
    return upsertSliceFastPath(client, slice, lookups);
  }
  // 1. Fetch every (source, source_id) already in DB for this slice.
  //    We OR the filter across sources in a single request — PostgREST
  //    handles this via .or() with a list of and() clauses.
  const sources = new Set(slice.map((r) => r.source));
  const existingBySrcId = new Map<string, ExistingRow>();
  for (const source of sources) {
    const sourceIds = slice
      .filter((r) => r.source === source)
      .map((r) => r.sourceId);
    // Chunk the IN(...) to stay under PostgREST URL limits. With 500-
    // id chunks PostgREST tolerates URLs up to ~30kb which is well
    // under Vercel's 32kb header cap for inbound URLs.
    for (let i = 0; i < sourceIds.length; i += EXISTING_LOOKUP_CHUNK) {
      const ids = sourceIds.slice(i, i + EXISTING_LOOKUP_CHUNK);
      const { data, error } = await client
        .from("professionals")
        .select("id, source, source_id, slug, claim_status")
        .eq("source", source)
        .in("source_id", ids);
      if (error) {
        console.error("[sink] lookup failed:", error.message);
        continue;
      }
      for (const row of data ?? []) {
        existingBySrcId.set(`${row.source}::${row.source_id}`, row as ExistingRow);
      }
    }
  }

  // 2. Build payloads, skipping claimed/verified rows.
  const payloads: Array<Record<string, unknown>> = [];
  const wasUpdate: boolean[] = [];
  for (const record of slice) {
    const key = `${record.source}::${record.sourceId}`;
    const existing = existingBySrcId.get(key);
    if (existing && existing.claim_status !== "unclaimed") {
      skipped += 1;
      continue;
    }
    const slug = existing?.slug ?? buildSlug(record.name, record.citySlug);
    payloads.push({
      slug,
      name: record.name,
      category_key: record.categoryKey,
      city_country: resolveCountry(record),
      city_slug: record.citySlug === "" ? null : record.citySlug,
      headline: record.headline ?? "",
      description: record.description ?? "",
      email: record.email,
      phone: record.phone,
      website: record.website,
      address: record.address,
      lat: record.lat,
      lng: record.lng,
      license_number: record.licenseNumber,
      rating: record.rating,
      review_count: record.reviewCount,
      photo_url: record.photoUrl,
      opening_hours: record.openingHours ?? null,
      source: record.source,
      source_id: record.sourceId,
      metadata: record.metadata ?? {},
      ...seoCopyFields(record, lookups),
    });
    wasUpdate.push(Boolean(existing));
  }

  if (payloads.length === 0) return { inserted: 0, updated: 0, skipped };

  // 3. Batch upsert.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (client.from("professionals") as any).upsert(
    payloads,
    { onConflict: "source,source_id" },
  );

  if (error) {
    // 4. Slug collision fallback. Retry offending rows one-by-one with
    //    numeric suffixes. We don't know which rows collided, so the
    //    simplest safe fallback is to re-attempt the whole slice
    //    row-by-row.
    if (error.code === "23505") {
      return upsertSliceRowByRow(client, slice, lookups);
    }
    console.error("[sink] batch upsert failed:", error.message);
    return { inserted: 0, updated: 0, skipped };
  }

  for (const was of wasUpdate) {
    if (was) updated += 1;
    else inserted += 1;
  }
  return { inserted, updated, skipped };
}

/**
 * Fast path for first-time bulk ingest. No SELECT lookup — relies on
 * the (source,source_id) unique index + onConflict to dedupe. Doesn't
 * touch already-claimed rows by design (you should NEVER use this for
 * a source that may already have rows in the DB).
 */
async function upsertSliceFastPath(
  client: SupabaseClient,
  slice: ScrapedProfessional[],
  lookups: SeoLookups,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const payloads: Array<Record<string, unknown>> = [];
  for (const record of slice) {
    payloads.push({
      slug: buildSlug(record.name, record.citySlug),
      name: record.name,
      category_key: record.categoryKey,
      city_country: resolveCountry(record),
      city_slug: record.citySlug === "" ? null : record.citySlug,
      headline: record.headline ?? "",
      description: record.description ?? "",
      email: record.email,
      phone: record.phone,
      website: record.website,
      address: record.address,
      lat: record.lat,
      lng: record.lng,
      license_number: record.licenseNumber,
      rating: record.rating,
      review_count: record.reviewCount,
      photo_url: record.photoUrl,
      opening_hours: record.openingHours ?? null,
      source: record.source,
      source_id: record.sourceId,
      metadata: record.metadata ?? {},
      ...seoCopyFields(record, lookups),
    });
  }
  if (payloads.length === 0) return { inserted: 0, updated: 0, skipped: 0 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (client.from("professionals") as any).upsert(
    payloads,
    { onConflict: "source,source_id", ignoreDuplicates: true },
  );
  if (error) {
    // Slug collision: degrade to row-by-row (rare on first import).
    if (error.code === "23505") {
      return upsertSliceRowByRow(client, slice, lookups);
    }
    console.error("[sink] fast-path upsert error:", error.message);
    return { inserted: 0, updated: 0, skipped: payloads.length };
  }
  return { inserted: payloads.length, updated: 0, skipped: 0 };
}

/**
 * Fallback path when batch upsert hits a slug collision. Re-inserts
 * each row on its own, appending -2, -3… to the slug until it fits.
 */
async function upsertSliceRowByRow(
  client: SupabaseClient,
  slice: ScrapedProfessional[],
  lookups: SeoLookups,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const record of slice) {
    const baseSlug = buildSlug(record.name, record.citySlug);
    const payload = {
      name: record.name,
      category_key: record.categoryKey,
      city_country: resolveCountry(record),
      city_slug: record.citySlug === "" ? null : record.citySlug,
      headline: record.headline ?? "",
      description: record.description ?? "",
      email: record.email,
      phone: record.phone,
      website: record.website,
      address: record.address,
      lat: record.lat,
      lng: record.lng,
      license_number: record.licenseNumber,
      rating: record.rating,
      review_count: record.reviewCount,
      photo_url: record.photoUrl,
      opening_hours: record.openingHours ?? null,
      source: record.source,
      source_id: record.sourceId,
      metadata: record.metadata ?? {},
      ...seoCopyFields(record, lookups),
    };
    let suffix = 1;
    while (suffix < 20) {
      const slug = suffix === 1 ? baseSlug : `${baseSlug}-${suffix}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (client.from("professionals") as any).upsert(
        { ...payload, slug },
        { onConflict: "source,source_id" },
      );
      if (!error) {
        // Heuristic: upsert returns data on both insert+update without
        // a clean flag. We conservatively count as "inserted" here.
        inserted += 1;
        break;
      }
      if (error.code !== "23505") {
        console.error("[sink] row upsert failed:", error.message);
        break;
      }
      suffix += 1;
    }
  }
  return { inserted, updated, skipped };
}
