#!/usr/bin/env node
// Bulk ingest of Mexico's DENUE (INEGI business registry).
//
// Downloads the 32 state ZIPs from INEGI, parses the CSV (Latin-1, custom ZIP
// reader to avoid extra deps), filters by SCIAN code → Prolio category_key,
// resolves municipio → city slug (with state-capital fallback), and streams
// directly into Supabase `professionals` via REST.
//
// Run:
//   node scripts/bulk-ingest/denue-mx-bulk.mjs
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from .env.local).
// Disk: ~3GB for the 32 zips in $DOWNLOAD_DIR (default /tmp/denue).
// Expected: ~600k rows inserted, ~30-40 min wall time.
import { readFileSync, readdirSync, mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { resolve } from "node:path";
import { createUploader, buildPersonSlug } from "./_lib/rest-uploader.mjs";
import { loadCities } from "./_lib/cities.mjs";

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "/tmp/denue";
const SKIP_DOWNLOAD = process.env.SKIP_DOWNLOAD === "1";

// INEGI publishes one ZIP per state CVE (01..32). State 15 (Estado de Mexico)
// is split into 15_1 / 15_2 because of size. URLs are stable; if INEGI changes
// the path, update INEGI_BASE.
const INEGI_BASE = process.env.INEGI_BASE
  || "https://www.inegi.org.mx/contenidos/masiva/denue/denue_";
const ZIPS = [
  ...Array.from({ length: 14 }, (_, i) => String(i + 1).padStart(2, "0")),
  "15_1", "15_2",
  ...Array.from({ length: 17 }, (_, i) => String(i + 16).padStart(2, "0")),
];

// --- SCIAN → category_key mapping (high-volume codes; see src/sources/denue-mx-bulk.ts) ---
const SCIAN_EXACT = {
  "621111": "medicina", "621112": "medicina", "621211": "dentista",
  "621311": "psicologia", "621320": "psicologia", "621331": "psicologia",
  "621341": "medicina", "621398": "medicina", "621411": "medicina",
  "621511": "medicina", "621610": "medicina", "621910": "medicina",
  "621991": "medicina", "621392": "fisioterapia", "621312": "fisioterapia",
  "621399": "enfermeria",
  "621210": "dentista",
  "541940": "veterinario",
  "446110": "farmacia", "461160": "farmacia",
  "541110": "abogado", "541120": "abogado", "541211": "fiscal",
  "541219": "fiscal", "541190": "abogado",
  "541310": "arquitecto", "541320": "arquitecto", "541330": "ingenieria",
  "541340": "ingenieria", "541360": "ingenieria", "541370": "ingenieria",
  "541380": "ingenieria",
  "811111": "mecanica", "811112": "mecanica", "811113": "mecanica",
  "811114": "mecanica", "811115": "mecanica", "811116": "mecanica",
  "811119": "mecanica", "811121": "mecanica", "811122": "mecanica",
  "811191": "mecanica", "811192": "mecanica", "811219": "mecanica",
  "811311": "mecanica", "811312": "mecanica",
  "238210": "electricidad", "238211": "electricidad", "238219": "electricidad",
  "238221": "fontaneria", "238222": "fontaneria",
  "238290": "hvac", "238330": "carpinteria", "238340": "carpinteria",
  "337110": "carpinteria", "337120": "carpinteria",
  "811490": "cerrajero",
  "488490": "itv",
};
const SCIAN_PREFIXES = [
  ["6211", "medicina"], ["6212", "dentista"], ["6213", "psicologia"],
  ["6214", "medicina"], ["6215", "medicina"], ["6216", "medicina"],
  ["6219", "medicina"], ["622", "medicina"], ["623", "medicina"],
  ["5419", "fiscal"], ["5411", "abogado"], ["5413", "arquitecto"],
  ["5412", "fiscal"], ["8111", "mecanica"], ["2382", "electricidad"],
];

function categoryForScian(scian) {
  if (!scian) return null;
  if (SCIAN_EXACT[scian]) return SCIAN_EXACT[scian];
  for (const [prefix, cat] of SCIAN_PREFIXES) {
    if (scian.startsWith(prefix)) return cat;
  }
  return null;
}

// State CVE → canonical capital slug (fallback when municipio doesn't resolve).
// These must exist in the `cities` table; verify before running.
const STATE_CAPITAL = {
  "01": ["Aguascalientes", "aguascalientes"],
  "02": ["Baja California", "tijuana"],
  "03": ["Baja California Sur", "la-paz-mx"],
  "04": ["Campeche", "campeche"],
  "05": ["Coahuila", "saltillo"],
  "06": ["Colima", "colima"],
  "07": ["Chiapas", "tuxtla-gutierrez"],
  "08": ["Chihuahua", "chihuahua"],
  "09": ["Ciudad de Mexico", "cdmx"],
  "10": ["Durango", "durango"],
  "11": ["Guanajuato", "leon-mx"],
  "12": ["Guerrero", "acapulco"],
  "13": ["Hidalgo", "pachuca"],
  "14": ["Jalisco", "guadalajara"],
  "15": ["Estado de Mexico", "toluca"],
  "16": ["Michoacan", "morelia"],
  "17": ["Morelos", "cuernavaca"],
  "18": ["Nayarit", "tepic"],
  "19": ["Nuevo Leon", "monterrey"],
  "20": ["Oaxaca", "oaxaca"],
  "21": ["Puebla", "puebla"],
  "22": ["Queretaro", "queretaro"],
  "23": ["Quintana Roo", "cancun"],
  "24": ["San Luis Potosi", "san-luis-potosi"],
  "25": ["Sinaloa", "culiacan"],
  "26": ["Sonora", "hermosillo"],
  "27": ["Tabasco", "villahermosa"],
  "28": ["Tamaulipas", "reynosa"],
  "29": ["Tlaxcala", "tlaxcala-mun"],
  "30": ["Veracruz", "veracruz-mx"],
  "31": ["Yucatan", "merida-mx"],
  "32": ["Zacatecas", "zacatecas"],
};

function slugifyCity(name) {
  if (!name) return null;
  return name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---- Minimal ZIP parser (central-directory based, supports stored + deflate) ----
function parseZip(buf) {
  let eocdOff = -1;
  const maxSearch = Math.min(buf.length, 65557);
  for (let i = buf.length - 22; i >= buf.length - maxSearch; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error("EOCD not found");
  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const cdOff = buf.readUInt32LE(eocdOff + 16);
  const entries = [];
  let p = cdOff;
  while (p < cdOff + cdSize) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  const lh = entry.localOff;
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const compData = buf.slice(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return compData;
  if (entry.method === 8) return inflateRawSync(compData);
  throw new Error(`unsupported zip method ${entry.method}`);
}

// ---- CSV iterator (Latin-1 byte stream, quoted fields) ----
function iterateCsvRows(bytes, onRow) {
  let cur = ""; let inQuotes = false; let row = [];
  const finish = () => { row.push(cur); cur = ""; onRow(row); row = []; };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (inQuotes) {
      if (b === 0x22) {
        if (bytes[i + 1] === 0x22) { cur += '"'; i++; } else inQuotes = false;
      } else cur += String.fromCharCode(b);
    } else {
      if (b === 0x22) inQuotes = true;
      else if (b === 0x2c) { row.push(cur); cur = ""; }
      else if (b === 0x0a || b === 0x0d) {
        if (cur.length > 0 || row.length > 0) finish();
        if (b === 0x0d && bytes[i + 1] === 0x0a) i++;
      } else cur += String.fromCharCode(b);
    }
  }
  if (cur.length > 0 || row.length > 0) finish();
}

function normaliseHeader(c) {
  return c.replace(/^﻿/, "").trim().toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// ---- Download (idempotent, skip if file exists and > 1KB) ----
async function downloadZips() {
  if (!existsSync(DOWNLOAD_DIR)) mkdirSync(DOWNLOAD_DIR, { recursive: true });
  for (const cve of ZIPS) {
    const path = resolve(DOWNLOAD_DIR, `${cve}.zip`);
    if (existsSync(path) && statSync(path).size > 1024) {
      console.error(`  ${cve}.zip: cached`);
      continue;
    }
    const url = `${INEGI_BASE}${cve}_csv.zip`;
    console.error(`  ${cve}.zip: downloading ${url}`);
    const r = await fetch(url);
    if (!r.ok) {
      console.error(`    HTTP ${r.status} — skipping`);
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(path, buf);
    console.error(`    saved ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
  }
}

// ---- Main ----
async function main() {
  if (!SKIP_DOWNLOAD) await downloadZips();

  console.error("Loading MX city slugs from Supabase…");
  const cityIdx = (await loadCities(["MX"]))["MX"];
  console.error(`  ${cityIdx.slugs.size} MX city slugs cached`);

  const uploader = createUploader({ batchSize: 500, concurrency: 3 });
  const seen = new Set();

  const zipFiles = readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith(".zip")).sort();
  console.error(`\nProcessing ${zipFiles.length} zips`);

  for (const zipName of zipFiles) {
    const buf = readFileSync(resolve(DOWNLOAD_DIR, zipName));
    if (buf.length < 1000) { console.error(`  ${zipName}: too small, skip`); continue; }
    let entries;
    try { entries = parseZip(buf); } catch (e) {
      console.error(`  ${zipName}: parse err ${e.message}, skip`); continue;
    }
    const cve = zipName.match(/^(\d{2})/)?.[1] ?? "00";
    const stateInfo = STATE_CAPITAL[cve];
    if (!stateInfo) { console.error(`  ${zipName}: unknown CVE ${cve}`); continue; }
    const [stateName, stateCapitalSlug] = stateInfo;

    const csvs = entries
      .filter(e => /\.csv$/i.test(e.name) && !/diccionario/i.test(e.name))
      .sort((a, b) => b.uncompSize - a.uncompSize);
    if (csvs.length === 0) { console.error(`  ${zipName}: no CSV`); continue; }
    const csvData = readEntry(buf, csvs[0]);
    console.error(`  ${zipName}: parsing ${csvs[0].name} (${(csvData.length / 1024 / 1024).toFixed(1)}MB)`);

    let header = null; let colMap = null; let stateKept = 0;
    const pending = [];

    iterateCsvRows(csvData, (row) => {
      if (!header) {
        header = row.map(normaliseHeader);
        const find = (names) => {
          for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; }
          return -1;
        };
        colMap = {
          clee: find(["clee"]), id: find(["id"]),
          nom_estab: find(["nom_estab", "nombre"]),
          codigo_act: find(["codigo_act", "codigo_actividad"]),
          nom_vial: find(["nom_vial", "nom_v_e"]),
          num_ext: find(["numero_ext", "num_ext"]),
          cod_postal: find(["cod_postal", "cp"]),
          municipio: find(["municipio", "nom_mun"]),
          telefono: find(["telefono", "tel"]),
          correoelec: find(["correoelec", "correo_elec"]),
          www: find(["www", "sitio_internet"]),
          latitud: find(["latitud"]), longitud: find(["longitud"]),
        };
        return;
      }
      const scian = colMap.codigo_act >= 0 ? row[colMap.codigo_act] : "";
      const cat = categoryForScian(scian);
      if (!cat) return;
      const clee = (colMap.clee >= 0 ? row[colMap.clee] : "") || (colMap.id >= 0 ? row[colMap.id] : "");
      if (!clee || seen.has(clee)) return;
      seen.add(clee);
      const name = (colMap.nom_estab >= 0 ? row[colMap.nom_estab] : "")?.trim();
      if (!name) return;
      const municipio = (colMap.municipio >= 0 ? row[colMap.municipio] : "")?.trim();
      const guessSlug = municipio ? slugifyCity(municipio) : null;
      let citySlug = guessSlug && cityIdx.slugs.has(guessSlug) ? guessSlug : null;
      if (!citySlug && cityIdx.slugs.has(stateCapitalSlug)) citySlug = stateCapitalSlug;
      if (!citySlug) return;

      const street = (colMap.nom_vial >= 0 ? row[colMap.nom_vial] : "")?.trim() || "";
      const num = (colMap.num_ext >= 0 ? row[colMap.num_ext] : "")?.trim() || "";
      const cp = (colMap.cod_postal >= 0 ? row[colMap.cod_postal] : "")?.trim() || "";
      const address = [street && num ? `${street} ${num}` : street, municipio, cp].filter(Boolean).join(", ");
      const lat = colMap.latitud >= 0 ? parseFloat(row[colMap.latitud]?.replace(",", ".")) : null;
      const lng = colMap.longitud >= 0 ? parseFloat(row[colMap.longitud]?.replace(",", ".")) : null;

      pending.push({
        slug: buildPersonSlug(name, citySlug),
        name,
        category_key: cat,
        city_slug: citySlug,
        city_country: "MX",
        headline: "",
        description: "",
        email: (colMap.correoelec >= 0 ? row[colMap.correoelec] : "")?.trim() || null,
        phone: (colMap.telefono >= 0 ? row[colMap.telefono] : "")?.trim() || null,
        website: (colMap.www >= 0 ? row[colMap.www] : "")?.trim() || null,
        address: address || null,
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        source: "denue-mx-bulk",
        source_id: `denue-bulk:${clee}`,
        metadata: {
          cve_ent: cve, state: stateName, municipio, scian,
          ingest_method: "local-bulk-rest",
        },
      });
      stateKept++;
    });

    // Flush this state's rows before moving on (keeps memory bounded).
    for (const p of pending) await uploader.push(p);
    await uploader.flush();
    console.error(`  ${zipName}: kept=${stateKept}`);
  }

  await uploader.done();
}

main().catch(e => { console.error(e); process.exit(1); });
