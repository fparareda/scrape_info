/**
 * Sprint 1 — re-geocode A.2 / A.2-bis sources whose `metadata.raw_city`,
 * `metadata.practice_location`, or `address` carries a real city that the
 * sink ignored at scrape time.
 *
 * Sources handled (in priority order, biggest impact first):
 *   - apega                  CA  metadata.raw_city                 (71,516)
 *   - tsask                  CA  metadata.raw_city                 (42,488)
 *   - cpsns-ns-physicians    CA  metadata.practice_location        (6,728)
 *   - datos-gob-es           ES  address (last comma-segment)      (11,148)
 *   - rcdso                  CA  address (segment N-1)             (1,000)
 *   - oaq                    CA  address (segment N-2)             (1,491)
 *   - cofepris-farmacias     MX  address (token before state)      (7,711)
 *
 * Strategy:
 *   1. Build (country, slug) → cities row map.
 *   2. For each source, stream rows page-by-page (1000 per page).
 *   3. Extract candidate city, slugify, look up in country map.
 *   4. On match: update city_slug (and city_country if missing). On miss:
 *      record in audit file for later attention.
 *
 * Read-only by default. Pass --commit to actually write.
 */

import { createClient } from "@supabase/supabase-js";
import { appendFileSync, mkdirSync } from "node:fs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COMMIT = process.argv.includes("--commit");

mkdirSync("audit-output", { recursive: true });
const MISS_FILE = "audit-output/regeocode-misses.csv";

if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const client = createClient(url, key, { auth: { persistSession: false } });

function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "-and-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

/** Extract a candidate city string from a row, by source. */
function extractCity(source, row) {
  const md = row.metadata ?? {};
  if (source === "apega") return md.raw_city;
  if (source === "tsask") return md.raw_city;
  if (source === "cpsns-ns-physicians") return md.practice_location;
  if (source === "datos-gob-es") {
    // "C/ Alicante, s/n, Murcia" → "Murcia"
    return (row.address || "").split(",").map((s) => s.trim()).filter(Boolean).pop();
  }
  if (source === "rcdso") {
    // "1140 Burnhamthorpe Rd W #135/136, Mississauga, L5C 0A3" → "Mississauga"
    const parts = (row.address || "").split(",").map((s) => s.trim());
    return parts.length >= 2 ? parts[parts.length - 2] : null;
  }
  if (source === "oaq") {
    // "360, rue X, Montréal, Québec, H2Y 1P5" → "Montréal"
    const parts = (row.address || "").split(",").map((s) => s.trim());
    return parts.length >= 3 ? parts[parts.length - 3] : null;
  }
  if (source === "cofepris-farmacias") {
    // "Av. Azueta No. 173 21100 Mexicali Baja California" → "Mexicali"
    // Strategy: token before the last 1-2 tokens (state name).
    // metadata.municipio is cleaner when present.
    if (md.municipio) return md.municipio;
    const m = (row.address || "").match(/\d{5}\s+([A-Za-zÀ-ÿ\s.'-]+?)\s+[A-Z][a-zA-Záéíóúñ]+(?:\s+[A-Z][a-z]+)?$/);
    return m ? m[1].trim() : null;
  }
  return null;
}

const SOURCES = [
  { source: "apega", country: "CA" },
  { source: "tsask", country: "CA" },
  { source: "cpsns-ns-physicians", country: "CA" },
  { source: "datos-gob-es", country: "ES" },
  { source: "rcdso", country: "CA" },
  { source: "oaq", country: "CA" },
  { source: "cofepris-farmacias", country: "MX" },
];

async function loadCitiesByCountry() {
  const byCountry = new Map();
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("cities")
      .select("country, slug, name")
      .order("slug")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const c of data) {
      if (!byCountry.has(c.country)) byCountry.set(c.country, new Map());
      byCountry.get(c.country).set(c.slug, c.name);
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  return byCountry;
}

async function processSource(meta, citiesByCountry) {
  const { source, country } = meta;
  const valid = citiesByCountry.get(country);
  if (!valid) {
    console.error(`[${source}] no cities seeded for ${country} — skipping`);
    return;
  }
  let from = 0;
  let scanned = 0, matched = 0, missed = 0, updated = 0;
  for (;;) {
    const { data, error } = await client
      .from("professionals")
      .select("id, address, city_slug, metadata")
      .eq("source", source)
      .order("id")
      .range(from, from + 999);
    if (error) {
      console.error(`[${source}] fetch error: ${error.message}`);
      return;
    }
    if (!data || data.length === 0) break;
    for (const row of data) {
      scanned++;
      const candidate = extractCity(source, row);
      if (!candidate) {
        missed++;
        appendFileSync(MISS_FILE, `${source},${row.id},no-candidate,\n`);
        continue;
      }
      const slug = slugify(candidate);
      if (!valid.has(slug)) {
        missed++;
        appendFileSync(MISS_FILE, `${source},${row.id},unknown-slug,${slug}\n`);
        continue;
      }
      if (row.city_slug === slug) {
        matched++; // already correct, skip
        continue;
      }
      matched++;
      if (COMMIT) {
        const { error: upErr } = await client
          .from("professionals")
          .update({ city_slug: slug, city_country: country })
          .eq("id", row.id);
        if (upErr) {
          console.error(`[${source}] update ${row.id}: ${upErr.message}`);
          continue;
        }
        updated++;
      }
    }
    if (data.length < 1000) break;
    from += 1000;
    if (scanned % 5000 === 0)
      console.log(`  [${source}] scanned=${scanned} matched=${matched} updated=${updated} missed=${missed}`);
  }
  console.log(`[${source}] DONE: scanned=${scanned} matched=${matched} updated=${updated} missed=${missed}${COMMIT ? "" : " (DRY-RUN, use --commit to write)"}`);
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT" : "DRY-RUN (use --commit to write)"}`);
  console.log("Loading cities…");
  const citiesByCountry = await loadCitiesByCountry();
  for (const [c, m] of citiesByCountry) console.log(`  ${c}: ${m.size}`);

  // Truncate misses file
  appendFileSync(MISS_FILE, ""); // ensure file exists
  await import("node:fs").then((fs) =>
    fs.writeFileSync(MISS_FILE, "source,id,reason,candidate_slug\n"),
  );

  for (const meta of SOURCES) {
    console.log(`\n=== ${meta.source} (${meta.country}) ===`);
    await processSource(meta, citiesByCountry);
  }
  console.log(`\nMisses written to ${MISS_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
