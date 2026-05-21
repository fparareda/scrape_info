#!/usr/bin/env node
// Overture Places bulk ingest for ES, CA, FR, US, MX (any combination).
//
// Strategy: DuckDB queries Overture's S3-hosted parquet directly (no full
// download), emits a wide CSV, then we stream-parse it and upload via REST.
//
// Run:
//   node scripts/bulk-ingest/overture.mjs              # all 5 countries
//   node scripts/bulk-ingest/overture.mjs US           # just US
//   COUNTRIES=ES,CA node scripts/bulk-ingest/overture.mjs
//
// Prereqs: duckdb installed (`brew install duckdb`), ~4GB free disk for CSVs.
// Expected:
//   * US: ~800k rows kept
//   * CA: ~80k
//   * ES: ~120k
//   * FR: ~150k
//   * MX: ~50k (Overture coverage is weaker here; DENUE is the primary source)
import { createReadStream, mkdirSync, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { createUploader, buildPersonSlug } from "./_lib/rest-uploader.mjs";
import { loadCities, resolveCity } from "./_lib/cities.mjs";

const WORK_DIR = process.env.WORK_DIR || "/tmp/overture";
const ALL_COUNTRIES = ["US", "CA", "ES", "FR", "MX"];
const COUNTRIES = (
  process.argv[2]
    ? [process.argv[2]]
    : (process.env.COUNTRIES?.split(",") ?? ALL_COUNTRIES)
).map(c => c.toUpperCase());

// Heap headroom: large CSVs + buffered batches push v8 past default.
if (!process.execArgv.some(a => a.startsWith("--max-old-space-size"))) {
  // Re-exec with 4GB heap if not already set.
  if (!process.env.__BULK_REEXEC) {
    const args = ["--max-old-space-size=4096", process.argv[1], ...process.argv.slice(2)];
    const r = spawnSync(process.argv[0], args, {
      stdio: "inherit",
      env: { ...process.env, __BULK_REEXEC: "1" },
    });
    process.exit(r.status ?? 1);
  }
}

// Overture → Prolio category_key. Keep wide so we don't lose rows.
const CAT = {
  doctor: "medicina", medical_clinic: "medicina", health_clinic: "medicina",
  medical_center: "medicina", health_and_medical: "medicina", hospital: "medicina",
  urgent_care_clinic: "medicina", pediatrician: "medicina", family_doctor: "medicina",
  general_practitioner: "medicina", dermatologist: "medicina",
  obstetrician_gynecologist: "medicina", cardiologist: "medicina",
  psychiatrist: "medicina", podiatrist: "medicina",
  eyewear_and_optician: "medicina", optometrist: "medicina",
  dentist: "dentista", dental_clinic: "dentista", general_dentistry: "dentista",
  orthodontist: "dentista", endodontist: "dentista", periodontist: "dentista",
  pharmacy: "farmacia",
  veterinary: "veterinario", veterinarian: "veterinario",
  animal_hospital: "veterinario", pet_services: "veterinario",
  psychologist: "psicologia", psychotherapist: "psicologia",
  therapist: "psicologia", counseling_mental_health: "psicologia",
  chiropractor: "fisioterapia", physical_therapist: "fisioterapia",
  physiotherapy_clinic: "fisioterapia", physical_therapy: "fisioterapia",
  massage_therapy: "fisioterapia", massage: "fisioterapia",
  acupuncture: "fisioterapia", osteopath: "fisioterapia",
  nurse: "enfermeria", nursing_home: "enfermeria",
  retirement_home: "enfermeria", senior_care_services: "enfermeria",
  lawyer: "abogado", attorney: "abogado", law_firm: "abogado",
  legal_services: "abogado",
  immigration_attorney: "extranjeria", immigration_lawyer: "extranjeria",
  immigration_services: "extranjeria",
  architect: "arquitecto", architectural_firm: "arquitecto",
  engineer: "ingenieria", engineering_consultant: "ingenieria",
  engineering_services: "ingenieria",
  accountant: "fiscal", accounting: "fiscal", bookkeeping: "fiscal",
  tax_advisor: "fiscal", tax_law: "fiscal", tax_services: "fiscal",
  financial_planning: "fiscal", financial_service: "fiscal",
  financial_planning_services: "fiscal", accounting_services: "fiscal",
  notary: "notario", notaries: "notario", notary_public: "notario",
  auto_repair: "mecanica", automotive_repair: "mecanica",
  car_repair: "mecanica", garage: "mecanica", tire_shop: "mecanica",
  mechanic: "mecanica", automotive_services_and_repair: "mecanica",
  motorcycle_repair: "mecanica", auto_body_shop: "mecanica",
  tire_dealer_and_repair: "mecanica",
  electrician: "electricidad", electrical_supply: "electricidad",
  electrical_contractor: "electricidad",
  plumber: "fontaneria", plumbing_supply: "fontaneria",
  plumbing_services: "fontaneria",
  carpenter: "carpinteria", contractor: "carpinteria",
  general_contractor: "carpinteria", construction_services: "carpinteria",
  painting: "carpinteria", painters: "carpinteria",
  hvac: "hvac", heating_and_air_conditioning_hvac: "hvac",
  locksmith: "cerrajero", locks_safes: "cerrajero",
  key_and_locksmith: "cerrajero", key_cutter: "cerrajero",
};

// Overture release path; bump as Overture publishes new monthly releases.
const OVERTURE_RELEASE = process.env.OVERTURE_RELEASE || "2024-12-18.0";
const OVERTURE_S3 = `s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=places/type=place/`;

function csvPath(cc) { return resolve(WORK_DIR, `${cc.toLowerCase()}_wide.csv`); }

function extractCountry(cc) {
  const out = csvPath(cc);
  if (existsSync(out) && statSync(out).size > 1024) {
    console.error(`  ${cc}: CSV exists, skip extract`);
    return;
  }
  console.error(`  ${cc}: extracting from Overture S3 → ${out}`);
  const sql = `
    INSTALL httpfs; LOAD httpfs;
    SET s3_region='us-west-2';
    COPY (
      SELECT
        id,
        names.primary AS name,
        categories.primary AS cat,
        categories.alternate::VARCHAR AS cat_alt,
        addresses[1].locality AS city,
        addresses[1].country AS country,
        addresses[1].freeform AS address,
        addresses[1].postcode AS postcode,
        websites[1] AS website,
        phones[1] AS phone,
        emails[1] AS email,
        ST_Y(geometry) AS lat,
        ST_X(geometry) AS lng
      FROM read_parquet('${OVERTURE_S3}*', filename=true, hive_partitioning=1)
      WHERE addresses[1].country = '${cc}'
        AND names.primary IS NOT NULL
    ) TO '${out}' (HEADER, DELIMITER ',');
  `.trim();
  execSync(`duckdb -c "${sql.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, {
    stdio: "inherit",
  });
}

function parseCsvRow(line) {
  const out = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

async function uploadCountry(cc, cityIdx) {
  const path = csvPath(cc);
  if (!existsSync(path)) { console.error(`  ${cc}: no CSV at ${path}`); return; }

  const uploader = createUploader({ batchSize: 500, concurrency: 6 });
  const dropped = { noCat: 0, noName: 0, noCity: 0 };
  let total = 0;

  const rl = createInterface({ input: createReadStream(path) });
  let header = null;
  for await (const line of rl) {
    total++;
    if (!header) { header = parseCsvRow(line); continue; }
    const cells = parseCsvRow(line);
    const r = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
    let cat = CAT[r.cat];
    if (!cat && r.cat_alt) {
      for (const alt of r.cat_alt.split(/[,\[\]\s]+/).filter(Boolean)) {
        if (CAT[alt]) { cat = CAT[alt]; break; }
      }
    }
    if (!cat) { dropped.noCat++; continue; }
    const name = r.name?.trim();
    if (!name) { dropped.noName++; continue; }
    const citySlug = resolveCity(cityIdx, r.city);
    if (!citySlug) { dropped.noCity++; continue; }
    await uploader.push({
      slug: buildPersonSlug(name, citySlug),
      name,
      category_key: cat,
      city_slug: citySlug,
      city_country: cc,
      headline: "",
      description: "",
      email: r.email || null,
      phone: r.phone || null,
      website: r.website || null,
      address: r.address || null,
      source: "overture",
      source_id: `overture:${r.id}`,
      metadata: {
        overture_category: r.cat,
        postcode: r.postcode || undefined,
        ingest_method: "local-overture",
      },
    });
  }
  await uploader.done();
  console.error(`${cc}: scanned=${total} dropped=${JSON.stringify(dropped)}`);
}

async function main() {
  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });

  // Verify duckdb available
  try { execSync("duckdb --version", { stdio: "pipe" }); }
  catch { console.error("duckdb not installed. brew install duckdb"); process.exit(1); }

  console.error(`Extracting Overture for: ${COUNTRIES.join(", ")}`);
  for (const cc of COUNTRIES) extractCountry(cc);

  console.error("\nLoading city slugs from Supabase…");
  const allCities = await loadCities(COUNTRIES);
  for (const cc of COUNTRIES) {
    console.error(`  ${cc}: ${allCities[cc].slugs.size} city slugs`);
  }

  for (const cc of COUNTRIES) {
    console.error(`\n=== ${cc} ===`);
    await uploadCountry(cc, allCities[cc]);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
