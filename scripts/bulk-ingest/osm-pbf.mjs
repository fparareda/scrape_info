#!/usr/bin/env node
// OpenStreetMap PBF bulk ingest, per country.
//
// Pipeline:
//   1. Download Geofabrik regional PBF (cached).
//   2. `osmium tags-filter` → only POIs with relevant amenity / healthcare / office / shop / craft tags.
//   3. `osmium export -f geojsonseq` → newline-delimited GeoJSON features.
//   4. Stream-parse JSON-seq → resolve city (name match → slug → lat/lng proximity within ~55km) → REST upload.
//
// Run:
//   node scripts/bulk-ingest/osm-pbf.mjs ES         # one country
//   node scripts/bulk-ingest/osm-pbf.mjs ES CA MX   # several
//
// Prereqs: osmium-tool (`brew install osmium-tool`), ~8GB free disk.
// PBF URLs default to Geofabrik regional extracts; override via OSM_PBF_URL_<CC>.
//
// Expected:
//   * ES: ~80k POIs kept
//   * CA: ~50k
//   * MX: ~40k
//   * US: ~600k (PBF ~9GB — large)
//   * FR: ~120k
import { createReadStream, mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { createUploader, buildPersonSlug } from "./_lib/rest-uploader.mjs";
import { loadCities, resolveCity, nearestCity } from "./_lib/cities.mjs";

const WORK_DIR = process.env.WORK_DIR || "/tmp/osm";
const COUNTRIES = process.argv.slice(2).map(s => s.toUpperCase());
if (COUNTRIES.length === 0) {
  console.error("Usage: osm-pbf.mjs <CC> [CC ...]   e.g. ES CA MX");
  process.exit(1);
}

// Geofabrik regional PBF URLs. Override per-country with OSM_PBF_URL_XX env.
const DEFAULT_PBF_URL = {
  ES: "https://download.geofabrik.de/europe/spain-latest.osm.pbf",
  FR: "https://download.geofabrik.de/europe/france-latest.osm.pbf",
  CA: "https://download.geofabrik.de/north-america/canada-latest.osm.pbf",
  MX: "https://download.geofabrik.de/north-america/mexico-latest.osm.pbf",
  US: "https://download.geofabrik.de/north-america/us-latest.osm.pbf",
};

// OSM tag → Prolio category. Order matters (first match wins).
const TAG_MAP = [
  ["amenity=dentist", "dentista"],
  ["amenity=doctors", "medicina"],
  ["amenity=clinic", "medicina"],
  ["amenity=hospital", "medicina"],
  ["amenity=pharmacy", "farmacia"],
  ["amenity=veterinary", "veterinario"],
  ["amenity=vehicle_inspection", "itv"],
  ["amenity=car_repair", "mecanica"],
  ["healthcare=dentist", "dentista"],
  ["healthcare=doctor", "medicina"],
  ["healthcare=clinic", "medicina"],
  ["healthcare=pharmacy", "farmacia"],
  ["healthcare=physiotherapist", "fisioterapia"],
  ["healthcare=psychotherapist", "psicologia"],
  ["healthcare=psychology", "psicologia"],
  ["healthcare=nurse", "enfermeria"],
  ["healthcare=nursing", "enfermeria"],
  ["healthcare=optometrist", "medicina"],
  ["healthcare=podiatrist", "medicina"],
  ["office=lawyer", "abogado"],
  ["office=notary", "notario"],
  ["office=architect", "arquitecto"],
  ["office=engineer", "ingenieria"],
  ["office=accountant", "fiscal"],
  ["office=tax_advisor", "fiscal"],
  ["office=psychologist", "psicologia"],
  ["shop=car_repair", "mecanica"],
  ["shop=locksmith", "cerrajero"],
  ["shop=chemist", "farmacia"],
  ["shop=optician", "medicina"],
  ["craft=carpenter", "carpinteria"],
  ["craft=electrician", "electricidad"],
  ["craft=plumber", "fontaneria"],
  ["craft=locksmith", "cerrajero"],
  ["craft=hvac", "hvac"],
];

// The list of "tag=value" expressions for osmium tags-filter.
const OSMIUM_TAG_FILTERS = TAG_MAP.map(([kv]) => kv);

function categoryFromProps(p) {
  for (const [kv, cat] of TAG_MAP) {
    const [k, v] = kv.split("=");
    if (p[k] === v) return cat;
  }
  return null;
}

function pbfPath(cc) { return resolve(WORK_DIR, `${cc.toLowerCase()}.pbf`); }
function filteredPath(cc) { return resolve(WORK_DIR, `${cc.toLowerCase()}-filtered.pbf`); }
function jsonseqPath(cc) { return resolve(WORK_DIR, `${cc.toLowerCase()}.jsonseq`); }

async function downloadPbf(cc) {
  const url = process.env[`OSM_PBF_URL_${cc}`] || DEFAULT_PBF_URL[cc];
  if (!url) throw new Error(`No PBF URL for ${cc}. Set OSM_PBF_URL_${cc}.`);
  const path = pbfPath(cc);
  if (existsSync(path) && statSync(path).size > 1024 * 1024) {
    console.error(`  ${cc}: PBF cached`); return;
  }
  console.error(`  ${cc}: downloading ${url}`);
  // curl is more reliable than fetch for multi-GB files.
  execSync(`curl -fL --retry 3 -o "${path}" "${url}"`, { stdio: "inherit" });
}

function runOsmium(cc) {
  const inP = pbfPath(cc);
  const filt = filteredPath(cc);
  const jsq = jsonseqPath(cc);

  if (!existsSync(filt) || statSync(filt).size < 1024) {
    console.error(`  ${cc}: osmium tags-filter`);
    const tagsArg = OSMIUM_TAG_FILTERS.map(t => `nwr/${t}`).join(" ");
    execSync(`osmium tags-filter --overwrite -o "${filt}" "${inP}" ${tagsArg}`, {
      stdio: "inherit",
    });
  } else {
    console.error(`  ${cc}: filtered PBF cached`);
  }

  if (!existsSync(jsq) || statSync(jsq).size < 1024) {
    console.error(`  ${cc}: osmium export -f geojsonseq`);
    execSync(`osmium export --overwrite -f geojsonseq -o "${jsq}" "${filt}"`, {
      stdio: "inherit",
    });
  } else {
    console.error(`  ${cc}: jsonseq cached`);
  }
}

async function uploadCountry(cc, cityIdx) {
  const jsq = jsonseqPath(cc);
  if (!existsSync(jsq)) { console.error(`  ${cc}: no jsonseq`); return; }

  const uploader = createUploader({ batchSize: 500, concurrency: 3 });
  const dropped = { noName: 0, noCity: 0 };
  let inspected = 0;

  const rl = createInterface({ input: createReadStream(jsq) });
  for await (const rawLine of rl) {
    // GeoJSON-seq prefixes each record with \x1e (RS); strip it.
    const line = rawLine.replace(/^\x1e+/, "").trim();
    if (!line || line.length < 5) continue;
    inspected++;
    let f;
    try { f = JSON.parse(line); } catch { continue; }
    const p = f.properties || {};
    const cat = categoryFromProps(p);
    if (!cat) continue;
    const name = (p.name || p["name:es"] || p["name:en"] || p["name:fr"] || "").trim();
    if (!name) { dropped.noName++; continue; }

    let lat = null, lng = null;
    const g = f.geometry || {};
    if (g.type === "Point" && Array.isArray(g.coordinates)) {
      [lng, lat] = g.coordinates;
    } else if (g.coordinates) {
      const c = Array.isArray(g.coordinates[0]?.[0]) ? g.coordinates[0][0] : g.coordinates[0];
      if (Array.isArray(c)) [lng, lat] = c;
    }

    const cityName = p["addr:city"] || p["addr:town"] || p["addr:village"] || p["addr:suburb"];
    let citySlug = resolveCity(cityIdx, cityName);
    if (!citySlug) citySlug = nearestCity(cityIdx.geo, lat, lng);
    if (!citySlug) { dropped.noCity++; continue; }

    const street = p["addr:street"];
    const num = p["addr:housenumber"];
    const cp = p["addr:postcode"];
    const addr = [
      street ? (num ? `${street} ${num}` : street) : null,
      cp,
      cityName,
    ].filter(Boolean).join(", ");
    const osmId = f.id || `${p["@type"] || "node"}/${p["@id"] || ""}`;

    await uploader.push({
      slug: buildPersonSlug(name, citySlug),
      name,
      category_key: cat,
      city_slug: citySlug,
      city_country: cc,
      headline: "",
      description: "",
      email: p.email || p["contact:email"] || null,
      phone: p.phone || p["contact:phone"] || null,
      website: p.website || p["contact:website"] || p.url || null,
      address: addr || null,
      lat: typeof lat === "number" && isFinite(lat) ? lat : null,
      lng: typeof lng === "number" && isFinite(lng) ? lng : null,
      opening_hours: p.opening_hours ? [p.opening_hours] : null,
      source: "osm",
      source_id: `osm:${osmId}`,
      metadata: { osm_id: osmId, ingest_method: "local-osm-pbf" },
    });
  }
  await uploader.done();
  console.error(`${cc}: inspected=${inspected} dropped=${JSON.stringify(dropped)}`);
}

async function main() {
  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
  try { execSync("osmium --version", { stdio: "pipe" }); }
  catch { console.error("osmium not installed. brew install osmium-tool"); process.exit(1); }

  console.error(`Loading city slugs for: ${COUNTRIES.join(", ")}`);
  const allCities = await loadCities(COUNTRIES);

  for (const cc of COUNTRIES) {
    console.error(`\n=== ${cc} ===`);
    await downloadPbf(cc);
    runOsmium(cc);
    await uploadCountry(cc, allCities[cc]);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
