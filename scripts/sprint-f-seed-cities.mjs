/**
 * Sprint F — seed ~45k cities from GeoNames cities1000.
 *
 * Why this exists: `cities` had only 1,610 rows for 5 countries. Every
 * scraper that emits a slug not in this set has its rows dropped at the
 * sink. With ~45k seeded, the drop rate falls dramatically.
 *
 * Source: https://download.geonames.org/export/dump/cities1000.zip
 *   Tab-separated, columns: geonameid, name, asciiname, alternatenames,
 *   latitude, longitude, fclass, fcode, country, cc2, admin1, admin2, ...
 *
 * Strategy:
 *   1. Filter to ES, CA, US, FR, MX.
 *   2. Within a country, collapse duplicate slugs by appending
 *      `-<admin1>` to disambiguate (so 5 different "Springfield" in the
 *      US become springfield-il, springfield-mo, ...).
 *   3. Insert in chunks of 500 with ON CONFLICT (country, slug) DO
 *      NOTHING — keeps existing rows intact.
 *
 * Usage:
 *   node scripts/sprint-f-seed-cities.mjs /tmp/cities-seed/cities1000.txt
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const file = process.argv[2] ?? "/tmp/cities-seed/cities1000.txt";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }
const client = createClient(url, key, { auth: { persistSession: false } });

const TARGET = new Set(["ES", "CA", "US", "FR", "MX"]);

function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

console.log("Reading", file, "…");
const text = readFileSync(file, "utf8");
const lines = text.split("\n");
console.log("  ", lines.length.toLocaleString(), "lines total");

// Pass 1: collect rows, group by (country, slugify(name)) to spot duplicates.
const rowsByCountry = new Map();
for (const line of lines) {
  if (!line) continue;
  const f = line.split("\t");
  const country = f[8];
  if (!TARGET.has(country)) continue;
  const fclass = f[6];
  if (fclass !== "P") continue; // populated places only
  const name = f[1]?.trim();
  const ascii = f[2]?.trim() || name;
  const lat = parseFloat(f[4]);
  const lng = parseFloat(f[5]);
  const admin1 = f[10]?.trim() || null;
  if (!name) continue;
  const baseSlug = slugify(ascii);
  if (!baseSlug) continue;
  if (!rowsByCountry.has(country)) rowsByCountry.set(country, []);
  rowsByCountry.get(country).push({ baseSlug, name, lat, lng, admin1 });
}

for (const [country, rows] of rowsByCountry) {
  console.log(`  ${country}: ${rows.length.toLocaleString()} rows`);
}

// Pass 2: per country, count slug duplicates. If duplicate, append `-<admin1>`.
function finalizeSlugs(country, rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.baseSlug, (counts.get(r.baseSlug) ?? 0) + 1);
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    let slug = r.baseSlug;
    if (counts.get(slug) > 1) {
      const suffix = r.admin1 ? slugify(r.admin1) : null;
      slug = suffix ? `${r.baseSlug}-${suffix}` : `${r.baseSlug}-${slugify(r.name)}`;
    }
    if (seen.has(slug)) continue; // dedupe within the same country
    seen.add(slug);
    out.push({ country, slug, name: r.name, lat: r.lat, lng: r.lng, region: r.admin1 });
  }
  return out;
}

const finalRows = [];
for (const [country, rows] of rowsByCountry) {
  finalRows.push(...finalizeSlugs(country, rows));
}
console.log(`\nTotal to insert: ${finalRows.length.toLocaleString()}`);

// Pass 3: chunked INSERT ... ON CONFLICT DO NOTHING.
const CHUNK = 500;
let inserted = 0, conflicts = 0, errs = 0, errs_consec = 0;
const start = Date.now();
for (let i = 0; i < finalRows.length; i += CHUNK) {
  const chunk = finalRows.slice(i, i + CHUNK);
  const { error, count } = await client
    .from("cities")
    .upsert(chunk, { onConflict: "country,slug", ignoreDuplicates: true, count: "exact" });
  if (error) {
    errs++; errs_consec++;
    console.log(`chunk @${i}: ERROR ${error.message}`);
    if (errs_consec >= 10) { console.log("giving up"); break; }
    await new Promise(r => setTimeout(r, 2000));
    continue;
  }
  errs_consec = 0;
  const n = count ?? 0;
  inserted += n;
  conflicts += chunk.length - n;
  if ((i / CHUNK) % 20 === 0) {
    console.log(`  @${i}: ${inserted.toLocaleString()} inserted, ${conflicts.toLocaleString()} conflicts (${((Date.now()-start)/1000).toFixed(0)}s)`);
  }
}
console.log(`\nDONE: ${inserted.toLocaleString()} inserted, ${conflicts.toLocaleString()} existing skipped, ${errs} errors`);
