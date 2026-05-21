/**
 * Generate a queries.txt for the gosom/google-maps-scraper to fill
 * the city × category coverage gaps for a given country.
 *
 * Inputs:
 *   - cities table → list of all (slug, name) for the country.
 *   - aggregated coverage CSV (country,city_slug,category_key,n)
 *     produced by `SELECT … GROUP BY 1,2,3` against `professionals`.
 *     Direct GROUP BY of `professionals` times out for high-volume
 *     categories (e.g. ES medicina has 73k rows); the CSV is the
 *     pragmatic input. Regenerate it whenever a fresh snapshot is
 *     needed.
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
  coverageCsv: string;
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
  return {
    country: (arg("country", "ES") ?? "ES").toUpperCase(),
    coverageCsv: arg("coverage", "data/coverage.csv") ?? "data/coverage.csv",
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

  console.error(`Loading coverage from ${args.coverageCsv}...`);
  const { pairs: existing, totalByCity } = await loadCoverageFromCsv(
    args.coverageCsv,
    args.country,
  );
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
      const syn = CATEGORY_SYNONYMS[cat]?.[locale]?.[0];
      if (!syn) continue;
      lines.push(`${syn} ${connector} ${name}#!#${args.country}|${slug}|${cat}`);
      stats.queries++;
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
