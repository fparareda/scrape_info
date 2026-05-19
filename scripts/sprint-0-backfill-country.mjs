/**
 * Sprint 0 phase 1b — backfill professionals.city_country.
 *
 * Strategy that survives PostgREST's ~8s statement_timeout:
 *   1. Load slug→country from cities.
 *   2. For each (country, slug) pair:
 *      a. Page through professional IDs for that slug.
 *      b. UPDATE city_country in batches of N ids — small enough to land
 *         in < 8s even under prod load. UPDATE WHERE id IN (...) uses the
 *         PK index, no sequential scan.
 *   3. Skip rows whose city_country is already set.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/sprint-0-backfill-country.mjs
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const client = createClient(url, key, { auth: { persistSession: false } });

const IDS_PER_UPDATE = 500;

async function fetchCities() {
  const map = new Map();
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("cities")
      .select("country, slug")
      .order("slug")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const c of data) {
      if (!map.has(c.country)) map.set(c.country, []);
      map.get(c.country).push(c.slug);
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  return map;
}

/** Fetch ALL ids for a given city_slug that still need city_country set. */
async function fetchIdsForSlug(slug) {
  const ids = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("professionals")
      .select("id")
      .eq("city_slug", slug)
      .is("city_country", null)
      .order("id")
      .range(from, from + 999);
    if (error) {
      console.error(`  fetchIds ${slug}: ${error.message}`);
      return ids;
    }
    if (!data || data.length === 0) break;
    for (const r of data) ids.push(r.id);
    if (data.length < 1000) break;
    from += 1000;
  }
  return ids;
}

async function updateChunk(ids, country) {
  const { error, count } = await client
    .from("professionals")
    .update({ city_country: country }, { count: "exact" })
    .in("id", ids);
  if (error) return { ok: false, err: error.message, count: 0 };
  return { ok: true, count: count ?? ids.length };
}

async function processSlug(slug, country) {
  const ids = await fetchIdsForSlug(slug);
  if (ids.length === 0) return 0;
  let written = 0;
  let retries = 0;
  for (let i = 0; i < ids.length; i += IDS_PER_UPDATE) {
    const chunk = ids.slice(i, i + IDS_PER_UPDATE);
    let attempt = 0;
    for (;;) {
      const res = await updateChunk(chunk, country);
      if (res.ok) {
        written += res.count;
        break;
      }
      attempt++;
      retries++;
      if (attempt >= 3) {
        console.error(`  ${slug}: chunk ${i} failed after 3 attempts: ${res.err}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  if (retries > 0) console.log(`  ${slug}: ${written}/${ids.length} (retries=${retries})`);
  return written;
}

async function main() {
  console.log("Loading city map…");
  const byCountry = await fetchCities();
  for (const [country, slugs] of byCountry)
    console.log(`  ${country}: ${slugs.length} cities`);

  for (const [country, slugs] of byCountry) {
    console.log(`\n=== ${country} ===`);
    let total = 0;
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      const written = await processSlug(slug, country);
      total += written;
      if (i % 20 === 0 || written > 0)
        console.log(`  ${country} ${i + 1}/${slugs.length} ${slug} +${written} (total=${total})`);
    }
    console.log(`${country}: DONE total=${total.toLocaleString()}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
