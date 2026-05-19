/**
 * Coverage audit (Phase 0 of the city × category coverage plan).
 *
 * Read-only. Inspects `professionals` × `cities` × `categories` and classifies
 * every (country, category) cell into one of three gap types:
 *
 *   TYPE_A  Pathological concentration. We have the rows but they all collapse
 *           into 1-3 cities because the source returns a registry/college HQ
 *           address as fallback. Fix = re-geocode from metadata, not scrape.
 *
 *   TYPE_B  True empty cells. 0 (or near-0) pros in the country. Fix = new
 *           scraper.
 *
 *   TYPE_C  Partial geographic coverage. The category exists but is missing
 *           whole provinces/states. Fix = add more provincial sources OR
 *           backfill via Overture/OSM.
 *
 * For TYPE_A cells we additionally sample `metadata` to see which fields are
 * present (practice_address, domicilio_profesional, address, etc.) — that is
 * what tells us whether re-geocoding is feasible without rescraping.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/audit-city-concentration.mjs
 *
 * Outputs in ./audit-output/:
 *   - summary.md
 *   - tipo-a-concentration.csv
 *   - tipo-b-empty.csv
 *   - tipo-c-partial.csv
 *   - metadata-fields-by-source.json
 *   - source-breakdown.csv
 */

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "audit-output";

// ---- thresholds ---------------------------------------------------------

// A cell is TYPE_A (pathological concentration) when:
//   - it has at least MIN_ROWS_FOR_TYPE_A rows AND
//   - top-1 city holds >= TOP1_SHARE_THRESHOLD of them, OR
//   - distinct cities < MIN_CITIES_EXPECTED for that row volume
const MIN_ROWS_FOR_TYPE_A = 50;
const TOP1_SHARE_THRESHOLD = 0.4;
const MIN_CITIES_EXPECTED = 5;

// TYPE_B = empty or near-empty per country.
const TYPE_B_MAX_ROWS = 20;

// TYPE_C = real but partial. >TYPE_B_MAX_ROWS, but distinct cities below this.
const TYPE_C_MIN_CITIES = 30;

// Sample size when inspecting metadata fields per source.
const METADATA_SAMPLE_PER_SOURCE = 50;

// ---- bootstrap ----------------------------------------------------------

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

mkdirSync(OUT_DIR, { recursive: true });

// ---- helpers ------------------------------------------------------------

async function rpc(sql) {
  // The Supabase JS client cannot run arbitrary SQL without an RPC. We avoid
  // that dependency by using the REST endpoint with PostgREST-compatible
  // queries. For the aggregations we need, plain table reads are enough.
  throw new Error("not used");
}

// Supabase default REST max rows per request is 1000.
const PAGE = 1000;

/** Build slug → {country, name} map from `cities`. */
async function fetchCityMap() {
  const map = new Map();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("cities")
      .select("slug, name, country")
      .order("slug")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const c of data) map.set(c.slug, { country: c.country, name: c.name });
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

/**
 * Stream professionals page by page WITHOUT joins. Uses keyset pagination by
 * id (ascending) — `range()` past offset ~1M is slow / capped, so we iterate
 * with `gt('id', lastId)`.
 */
async function* streamProfessionals() {
  let lastId = "00000000-0000-0000-0000-000000000000";
  let totalSeen = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("professionals")
      .select("id, category_key, city_slug, source")
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) yield r;
    lastId = data[data.length - 1].id;
    totalSeen += data.length;
    if (totalSeen % 50_000 === 0)
      console.log(`  …${totalSeen.toLocaleString()} rows`);
    if (data.length < PAGE) break;
  }
}

/** Same but for rows without a city_slug (orphans). */
async function fetchOrphans() {
  const { data, error } = await supabase
    .from("professionals")
    .select("category_key, source", { count: "exact" })
    .is("city_slug", null);
  if (error) throw error;
  return data ?? [];
}

async function fetchCategories() {
  const { data, error } = await supabase
    .from("categories")
    .select("key, name_es");
  if (error) throw error;
  return data ?? [];
}

/** Sample metadata for N rows of a (category, source) cell. */
async function sampleMetadata(categoryKey, source) {
  const { data, error } = await supabase
    .from("professionals")
    .select("metadata, address, city_slug")
    .eq("category_key", categoryKey)
    .eq("source", source)
    .limit(METADATA_SAMPLE_PER_SOURCE);
  if (error) throw error;
  return data ?? [];
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, header, rows) {
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => csvEscape(r[h])).join(","));
  writeFileSync(join(OUT_DIR, file), lines.join("\n") + "\n");
}

// ---- main --------------------------------------------------------------

const COUNTRIES = ["ES", "FR", "MX", "US", "CA"];

async function main() {
  console.log("Fetching categories…");
  const categories = await fetchCategories();
  const allCategoryKeys = categories.map((c) => c.key);
  console.log(`  ${allCategoryKeys.length} categories: ${allCategoryKeys.join(", ")}`);

  // (country, category) → { total, byCity:Map, bySource:Map<source,{total, byCity:Map}> }
  const cells = new Map();
  const ck = (country, cat) => `${country}::${cat}`;

  console.log("Fetching city map…");
  const cityMap = await fetchCityMap();
  console.log(`  ${cityMap.size.toLocaleString()} cities`);

  console.log("Streaming professionals…");
  let seen = 0;
  for await (const r of streamProfessionals()) {
    seen++;
    const city = r.city_slug ? cityMap.get(r.city_slug) : null;
    const country = city?.country ?? null;
    if (!country || !COUNTRIES.includes(country)) continue;
    const cat = r.category_key ?? "_null_";
    const k = ck(country, cat);
    let cell = cells.get(k);
    if (!cell) {
      cell = { total: 0, byCity: new Map(), bySource: new Map() };
      cells.set(k, cell);
    }
    cell.total++;
    const cityName = city.name ?? r.city_slug ?? "(unknown)";
    cell.byCity.set(cityName, (cell.byCity.get(cityName) ?? 0) + 1);
    const src = r.source ?? "(no-source)";
    let s = cell.bySource.get(src);
    if (!s) {
      s = { total: 0, byCity: new Map() };
      cell.bySource.set(src, s);
    }
    s.total++;
    s.byCity.set(cityName, (s.byCity.get(cityName) ?? 0) + 1);
  }
  console.log(`  ${seen.toLocaleString()} rows scanned`);

  // Orphans (city_slug IS NULL) — should be ~0 today but worth recording.
  const orphans = await fetchOrphans();
  console.log(`Orphans (city_slug NULL): ${orphans.length}`);

  // ---- Classify every (country, category) ----
  const typeA = [];
  const typeB = [];
  const typeC = [];
  const sourceRows = [];

  for (const country of COUNTRIES) {
    for (const cat of allCategoryKeys) {
      const cell = cells.get(ck(country, cat));
      const total = cell?.total ?? 0;

      if (total <= TYPE_B_MAX_ROWS) {
        typeB.push({ country, category: cat, total });
        continue;
      }

      const byCitySorted = [...(cell.byCity.entries() ?? [])].sort(
        (a, b) => b[1] - a[1]
      );
      const nCities = byCitySorted.length;
      const top1Share = byCitySorted[0][1] / total;
      const top3Share =
        byCitySorted.slice(0, 3).reduce((s, [, n]) => s + n, 0) / total;

      const isTypeA =
        total >= MIN_ROWS_FOR_TYPE_A &&
        (top1Share >= TOP1_SHARE_THRESHOLD || nCities < MIN_CITIES_EXPECTED);

      if (isTypeA) {
        typeA.push({
          country,
          category: cat,
          total,
          n_cities: nCities,
          top1_city: byCitySorted[0][0],
          top1_count: byCitySorted[0][1],
          top1_share_pct: (top1Share * 100).toFixed(1),
          top3_share_pct: (top3Share * 100).toFixed(1),
          sources: [...cell.bySource.keys()].join("|"),
        });
      } else if (nCities < TYPE_C_MIN_CITIES) {
        typeC.push({
          country,
          category: cat,
          total,
          n_cities: nCities,
          top1_city: byCitySorted[0][0],
          top1_share_pct: (top1Share * 100).toFixed(1),
        });
      }

      // Source breakdown (always emit, useful for both fix decisions).
      for (const [src, s] of cell.bySource) {
        const sSorted = [...s.byCity.entries()].sort((a, b) => b[1] - a[1]);
        sourceRows.push({
          country,
          category: cat,
          source: src,
          total: s.total,
          n_cities: sSorted.length,
          top1_city: sSorted[0][0],
          top1_share_pct: ((sSorted[0][1] / s.total) * 100).toFixed(1),
        });
      }
    }
  }

  // ---- Sample metadata for every (country, cat, source) flagged TYPE_A ----
  console.log(`Sampling metadata for ${typeA.length} TYPE_A cells…`);
  const metadataFields = {}; // source -> { count, fields:{name:count}, sample:[…] }
  for (const a of typeA) {
    for (const source of a.sources.split("|")) {
      if (metadataFields[source]) continue; // sample each source once
      const rows = await sampleMetadata(a.category, source);
      const fields = {};
      const addressLike = {
        has_address_col: 0,
        practice_address: 0,
        domicilio_profesional: 0,
        direccion_consulta: 0,
        address: 0,
        addr: 0,
        street: 0,
        postal_code: 0,
        cp: 0,
        province: 0,
        state: 0,
        latitude_in_metadata: 0,
      };
      for (const r of rows) {
        if (r.address) addressLike.has_address_col++;
        const md = r.metadata ?? {};
        for (const k of Object.keys(md)) {
          fields[k] = (fields[k] ?? 0) + 1;
          const lk = k.toLowerCase();
          if (lk.includes("practice")) addressLike.practice_address++;
          if (lk.includes("domicilio")) addressLike.domicilio_profesional++;
          if (lk.includes("direccion") || lk.includes("dirección"))
            addressLike.direccion_consulta++;
          if (lk === "address") addressLike.address++;
          if (lk === "addr") addressLike.addr++;
          if (lk.includes("street")) addressLike.street++;
          if (lk.includes("postal") || lk.includes("zip"))
            addressLike.postal_code++;
          if (lk === "cp") addressLike.cp++;
          if (lk.includes("province") || lk.includes("provincia"))
            addressLike.province++;
          if (lk === "state" || lk.includes("estado")) addressLike.state++;
          if (lk === "lat" || lk.includes("latitude"))
            addressLike.latitude_in_metadata++;
        }
      }
      metadataFields[source] = {
        sample_size: rows.length,
        seen_address_signals: addressLike,
        all_metadata_keys: fields,
      };
    }
  }

  // ---- Write outputs ----
  writeCsv(
    "tipo-a-concentration.csv",
    [
      "country",
      "category",
      "total",
      "n_cities",
      "top1_city",
      "top1_count",
      "top1_share_pct",
      "top3_share_pct",
      "sources",
    ],
    typeA.sort(
      (a, b) =>
        Number(b.top1_share_pct) - Number(a.top1_share_pct) || b.total - a.total
    )
  );

  writeCsv(
    "tipo-b-empty.csv",
    ["country", "category", "total"],
    typeB.sort(
      (a, b) => a.country.localeCompare(b.country) || a.category.localeCompare(b.category)
    )
  );

  writeCsv(
    "tipo-c-partial.csv",
    ["country", "category", "total", "n_cities", "top1_city", "top1_share_pct"],
    typeC.sort((a, b) => a.n_cities - b.n_cities)
  );

  writeCsv(
    "source-breakdown.csv",
    [
      "country",
      "category",
      "source",
      "total",
      "n_cities",
      "top1_city",
      "top1_share_pct",
    ],
    sourceRows.sort(
      (a, b) =>
        a.country.localeCompare(b.country) ||
        a.category.localeCompare(b.category) ||
        b.total - a.total
    )
  );

  writeFileSync(
    join(OUT_DIR, "metadata-fields-by-source.json"),
    JSON.stringify(metadataFields, null, 2)
  );

  // ---- Summary ----
  const totalPros = [...cells.values()].reduce((s, c) => s + c.total, 0);
  const typeATotal = typeA.reduce((s, a) => s + a.total, 0);
  const typeAFixable = Object.entries(metadataFields)
    .filter(([, m]) => {
      const sig = m.seen_address_signals;
      return (
        sig.has_address_col / Math.max(m.sample_size, 1) >= 0.5 ||
        sig.practice_address + sig.domicilio_profesional + sig.direccion_consulta +
          sig.address + sig.addr + sig.street >=
          m.sample_size * 0.3
      );
    })
    .map(([s]) => s);

  const md = [
    "# Coverage audit — Phase 0",
    "",
    `- **Countries inspected:** ${COUNTRIES.join(", ")}`,
    `- **Categories:** ${allCategoryKeys.length}`,
    `- **Total professionals seen:** ${totalPros.toLocaleString()}`,
    `- **Orphans (\`city_slug IS NULL\`):** ${orphans.length}`,
    "",
    "## TYPE_A — pathological concentration",
    "",
    `- Cells flagged: **${typeA.length}**`,
    `- Pros affected: **${typeATotal.toLocaleString()}** (${((typeATotal / totalPros) * 100).toFixed(1)}% of all)`,
    `- Sources where metadata likely has a real address (re-geocode feasible without rescrape): **${typeAFixable.length}**`,
    `  - ${typeAFixable.join(", ") || "(none)"}`,
    "",
    "See `tipo-a-concentration.csv` and `metadata-fields-by-source.json`.",
    "",
    "## TYPE_B — empty / near-empty cells (true coverage gaps)",
    "",
    `- Cells: **${typeB.length}**`,
    "",
    "See `tipo-b-empty.csv`. These need new scrapers.",
    "",
    "## TYPE_C — partial geographic coverage",
    "",
    `- Cells: **${typeC.length}**`,
    "",
    "See `tipo-c-partial.csv`. Either add provincial sources or backfill via",
    "Overture/OSM once TYPE_A is resolved.",
    "",
    "## Next step",
    "",
    "1. Open `tipo-a-concentration.csv` sorted by top1_share desc.",
    "2. For each source that appears in `metadata-fields-by-source.json` with",
    "   a real address signal, write a re-geocoder job that reads",
    "   `metadata.<field>`, resolves to `(city_slug, lat, lng)` using the",
    "   `cities` table + Nominatim, and updates the row. If the only address",
    "   is the registry HQ, set `city_slug = NULL`, `metadata.province_slug`,",
    "   `metadata.location_granularity = 'province'` so the matrix tells the",
    "   truth instead of a concentrated lie.",
    "3. Re-run this audit. TYPE_A should shrink; TYPE_B/C remain → drive",
    "   Phase 1+2 of the plan.",
    "",
  ].join("\n");

  writeFileSync(join(OUT_DIR, "summary.md"), md);

  console.log("");
  console.log(`Done. Outputs in ./${OUT_DIR}/`);
  console.log(`  TYPE_A cells: ${typeA.length} (${typeATotal.toLocaleString()} pros)`);
  console.log(`  TYPE_B cells: ${typeB.length}`);
  console.log(`  TYPE_C cells: ${typeC.length}`);
  console.log(`  Likely re-geocodable sources: ${typeAFixable.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
