/**
 * Generate a queries.txt for the gosom/google-maps-scraper to fill
 * the city × category coverage gaps for a given country.
 *
 * Inputs:
 *   - cities table → list of all (slug, name) for the country.
 *   - coverage: by default a LIVE read from the
 *     `coverage_matrix_city` materialized view (one row per
 *     (country, city, category) with a count). The view is
 *     refreshed at the start of each run so consecutive cron
 *     shards see the cities earlier shards already filled. Pass
 *     `--coverage <csv>` to fall back to a static aggregated CSV
 *     (country,city_slug,category_key,n) — useful for offline runs
 *     or when the matview is unavailable.
 *
 * Why live: when daily cron shards run sequentially, an earlier
 * shard fills its 200 cities and the next shard should see those
 * as already covered. A static CSV snapshot makes later shards
 * re-scrape the same (city, category) pairs.
 *
 * Output: queries.txt — one line per (city, missing category) pair,
 * each tagged `#!#{city_slug}|{cat}` so the loader can attribute
 * Maps results back without re-geocoding.
 *
 * Volume guard: ES ola 1 (1-oficio + 0-oficio cities × 13 cats) is
 * ~108k queries; at -c 2 -depth 1 that's many hours. The CLI takes
 * --max to cap and --offset to shard for GitHub Actions matrices.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFile, writeFile } from "node:fs/promises";
import { CATEGORY_SYNONYMS } from "./queries/synonyms.js";
import type { CategoryKey } from "./prolio-types.js";

interface CliArgs {
  country: string;
  coverageCsv: string | null;
  output: string;
  offset: number;
  max: number;
  topN: number;
  cityOffset: number;
  includeZero: boolean;
  includeOneOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const arg = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    return argv[i + 1];
  };
  // --coverage <path> opts into the static CSV fallback. Default is
  // live Supabase load.
  const coverageArg = arg("coverage");
  return {
    country: (arg("country", "ES") ?? "ES").toUpperCase(),
    coverageCsv: coverageArg ?? null,
    output: arg("output", "queries.txt") ?? "queries.txt",
    offset: Number(arg("offset", "0")),
    max: Number(arg("max", "0")), // 0 = no cap
    topN: Number(arg("top-n", "0")), // 0 = no ranking; emit all matching cities
    cityOffset: Number(arg("city-offset", "0")), // skip N highest-ranked cities
    includeZero: arg("zero", "true") !== "false",
    includeOneOnly: arg("one-only", "true") !== "false",
  };
}

const LOCALE_BY_COUNTRY: Record<string, "es" | "en" | "fr"> = {
  ES: "es",
  MX: "es",
  US: "en",
  CA: "en",
  FR: "fr",
};

const CONNECTOR: Record<"es" | "en" | "fr", string> = {
  es: "en",
  en: "in",
  fr: "à",
};

async function loadCities(
  client: SupabaseClient<any, any, any>,
  country: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from("cities")
      .select("slug, name")
      .eq("country", country)
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      out.set(row.slug as string, row.name as string);
    }
    if (data.length < 1000) break;
  }
  return out;
}

/**
 * Live coverage load — reads from the `coverage_matrix_city`
 * materialized view (one row per (country, city, category) with a
 * count). Server-side it's a single index range scan filtered by
 * `city_country = $country` — milliseconds to a couple of seconds.
 *
 * The materialized view is refreshed *here* before reading so each
 * cron shard sees the cities that earlier shards already filled.
 * The refresh runs as a SECURITY DEFINER RPC with a 5-minute
 * statement_timeout (the underlying aggregate is ~60s for ES).
 *
 * Why a matview + RPC instead of a client-side aggregate or a
 * direct RPC each call:
 *   - PostgREST has a 60s statement_timeout and the aggregate
 *     scan takes ~65s on prod for ES.
 *   - Paginating raw professionals rows via the REST API timed
 *     out too (OFFSET-style at 50k+; per-batch IN(...) keyset
 *     forced scans the planner couldn't accelerate).
 *   - A matview pushes the cost to the refresh boundary (once per
 *     shard) and makes reads cheap and bounded.
 *
 * `candidateSlugs` filters out rows whose city_slug doesn't appear
 * in `cities` (stale / typo'd slugs).
 */
async function loadCoverageLive(
  client: SupabaseClient<any, any, any>,
  country: string,
  candidateSlugs: Set<string>,
): Promise<{
  pairs: Map<string, Set<CategoryKey>>;
  totalByCity: Map<string, number>;
}> {
  console.error("  → refreshing coverage_matrix_city (may take ~60s)...");
  const refreshStart = Date.now();
  const { error: refreshErr } = await client.rpc("refresh_coverage_matrix_city");
  if (refreshErr) {
    // Refresh failure is non-fatal: stale data is still useful. Log loudly.
    console.error(
      `  ! refresh failed (${refreshErr.message}) — proceeding with stale matview`,
    );
  } else {
    console.error(`    … refreshed in ${((Date.now() - refreshStart) / 1000).toFixed(1)}s`);
  }

  const pairs = new Map<string, Set<CategoryKey>>();
  const totalByCity = new Map<string, number>();
  const PAGE = 1000;
  let dropped = 0;
  let total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await (client.from("coverage_matrix_city") as any)
      .select("city_slug, category_key, n")
      .eq("city_country", country)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data as Array<{
      city_slug: string;
      category_key: string;
      n: number;
    }>) {
      if (!candidateSlugs.has(row.city_slug)) {
        dropped++;
        continue;
      }
      let set = pairs.get(row.city_slug);
      if (!set) {
        set = new Set();
        pairs.set(row.city_slug, set);
      }
      set.add(row.category_key as CategoryKey);
      totalByCity.set(
        row.city_slug,
        (totalByCity.get(row.city_slug) ?? 0) + Number(row.n),
      );
    }
    total += data.length;
    if (data.length < PAGE) break;
  }
  console.error(
    `  → live coverage: ${total} (city,category) pairs (dropped ${dropped} unknown-slug rows)`,
  );
  return { pairs, totalByCity };
}

async function loadCoverageFromCsv(
  csvPath: string,
  country: string,
): Promise<{
  pairs: Map<string, Set<CategoryKey>>;
  totalByCity: Map<string, number>;
}> {
  const text = await readFile(csvPath, "utf-8");
  const pairs = new Map<string, Set<CategoryKey>>();
  const totalByCity = new Map<string, number>();
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const [c, slug, cat, nStr] = line.split(",");
    if (c !== country || !slug) continue;
    let set = pairs.get(slug);
    if (!set) {
      set = new Set();
      pairs.set(slug, set);
    }
    set.add(cat as CategoryKey);
    const n = Number(nStr) || 0;
    totalByCity.set(slug, (totalByCity.get(slug) ?? 0) + n);
  }
  return { pairs, totalByCity };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.error(`Loading cities for ${args.country}...`);
  const cities = await loadCities(client, args.country);
  console.error(`  → ${cities.size} cities`);

  const { pairs: existing, totalByCity } = args.coverageCsv
    ? await (async () => {
        console.error(`Loading coverage from ${args.coverageCsv} (static)...`);
        return loadCoverageFromCsv(args.coverageCsv!, args.country);
      })()
    : await (async () => {
        console.error(`Loading coverage live from Supabase (country=${args.country})...`);
        const candidateSlugs = new Set(cities.keys());
        return loadCoverageLive(client, args.country, candidateSlugs);
      })();
  const coveredCities = existing.size;
  console.error(`  → ${coveredCities} cities have ≥1 category`);

  const locale = LOCALE_BY_COUNTRY[args.country] ?? "en";
  const connector = CONNECTOR[locale];
  const cats = Object.keys(CATEGORY_SYNONYMS) as CategoryKey[];

  // Determine eligible categories for this country: those that already
  // have at least one professional anywhere (so we don't ask Maps for
  // categories the country doesn't recognise, e.g. ITV in US).
  const eligibleCats = new Set<CategoryKey>();
  for (const set of existing.values()) {
    for (const c of set) eligibleCats.add(c);
  }
  console.error(`  → ${eligibleCats.size} categories with ≥1 row in ${args.country}: ${[...eligibleCats].sort().join(", ")}`);

  // Rank cities for --top-n. Cities with high pro totals = larger / more
  // commercially relevant. Cities with 0 oficios have no signal so they
  // sink to the bottom of the ranking; --top-n therefore favours
  // 1-oficio cities with substantial existing presence (= real cities).
  let orderedCities = Array.from(cities.entries());
  if (args.topN > 0 || args.cityOffset > 0) {
    orderedCities.sort(([a], [b]) => (totalByCity.get(b) ?? 0) - (totalByCity.get(a) ?? 0));
    const start = args.cityOffset;
    const end = args.topN > 0 ? start + args.topN : orderedCities.length;
    orderedCities = orderedCities.slice(start, end);
    console.error(
      `  → ranking by existing-pro count, slice [${start}..${end}) = ${orderedCities.length} cities`,
    );
  }

  const lines: string[] = [];
  const stats = { zeroCities: 0, oneOnlyCities: 0, multiCities: 0, queries: 0 };

  for (const [slug, name] of orderedCities) {
    const have = existing.get(slug);
    const haveCount = have?.size ?? 0;
    if (haveCount === 0) stats.zeroCities++;
    else if (haveCount === 1) stats.oneOnlyCities++;
    else stats.multiCities++;

    if (haveCount === 0 && !args.includeZero) continue;
    if (haveCount === 1 && !args.includeOneOnly) continue;
    // When --top-n ranks cities we fill any missing category they have,
    // because the goal is "complete the most relevant cities" rather
    // than "only ola-1 cities". Without --top-n we stick to ola-1.
    if (args.topN === 0 && haveCount > 1) continue;

    for (const cat of cats) {
      if (!eligibleCats.has(cat)) continue;
      if (have?.has(cat)) continue;
      // Emit up to 3 synonym variants per (city, category) to widen
      // Maps coverage for the same scrape budget — the loader dedups
      // by place_id so duplicate hits across synonyms just refresh
      // the same row.
      const syns = (CATEGORY_SYNONYMS[cat]?.[locale] ?? []).slice(0, 3);
      if (syns.length === 0) continue;
      for (const syn of syns) {
        lines.push(`${syn} ${connector} ${name}#!#${args.country}|${slug}|${cat}`);
        stats.queries++;
      }
    }
  }

  // Shard
  let sliced = lines;
  if (args.offset > 0) sliced = sliced.slice(args.offset);
  if (args.max > 0) sliced = sliced.slice(0, args.max);

  await writeFile(args.output, sliced.join("\n") + "\n", "utf-8");

  const multiNote = args.topN > 0 ? "included in top-N" : "skipped (not ola 1)";
  console.error(`\nCity breakdown:`);
  console.error(`  0 oficios:    ${stats.zeroCities}`);
  console.error(`  1 oficio:     ${stats.oneOnlyCities}`);
  console.error(`  2+ oficios:   ${stats.multiCities} (${multiNote})`);
  console.error(`\nQueries generated: ${stats.queries}`);
  console.error(`Written ${sliced.length} lines → ${args.output}`);
  if (args.offset || args.max) {
    console.error(`(offset=${args.offset}, max=${args.max || "∞"})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
