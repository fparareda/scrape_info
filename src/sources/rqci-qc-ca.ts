import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * RQCI — Registre québécois des consultants en immigration.
 * (Quebec Register of Immigration Consultants)
 *
 * Open data published by the Ministère de l'Immigration, de la
 * Francisation et de l'Intégration (MIFI) under CC-BY 4.0.
 *
 * Dataset URL (open.canada.ca):
 *   https://open.canada.ca/data/en/dataset/23f8d075-4574-4238-a3d1-f3ba5674fce0
 *
 * Direct CSV resource (donneesquebec.ca):
 *   https://www.donneesquebec.ca/recherche/dataset/
 *     23f8d075-4574-4238-a3d1-f3ba5674fce0/resource/
 *     26d1f57f-1f1d-4856-af54-d7b3cdb57954/download/<date>.csv
 *
 * Pre-flight 2026-06-14:
 *   donneesquebec.ca robots.txt: Crawl-Delay 10; /recherche/api/ disallowed
 *   but the direct download path is NOT disallowed. Confirmed HTTP 200
 *   on the CSV download URL.
 *
 *   CSV columns (UTF-8 BOM, comma-delimited):
 *     STATUT | NOINSCRIPTION | NOM | PRENOM | DATERECONNAISSANCE |
 *     ENTREPRISEADRESSE1 | ENTREPRISEADRESSE2 | ENTREPRISEADRESSE3 |
 *     ENTREPRISEVILLE | ENTREPRISEPROVINCE | ENTREPRISECODEPOSTAL | COURRIEL
 *
 *   STATUT values:
 *     REC = Reconnu (recognized / active licence)
 *     REV = Révoqué (revoked)
 *
 *   Record count (2026-06-14 snapshot): 726 total — 682 REC + 44 REV.
 *
 * City resolution strategy:
 *   The ENTREPRISEVILLE field uses French accented names (e.g. "Montréal",
 *   "Québec", "Trois-Rivières"). We normalise to lowercase + remove
 *   accents for slug lookup, then fall back to "montreal" (the dominant
 *   city, ~44 % of records) for unresolvable cities. Montreal boroughs
 *   (Saint-Laurent, Verdun, Côte-des-Neiges, etc.) are mapped to
 *   "montreal".
 *
 * The resource URL includes a date in the filename. We discover the
 * current download URL at runtime via the open.canada.ca CKAN API
 * (robots.txt: only /core/ and /libraries/ disallowed) using a GET to
 *   https://open.canada.ca/data/api/3/action/package_show?id=<uuid>
 * This avoids hardcoding a dated filename that would break on each
 * MIFI update (monthly cadence).
 *
 * Category: extranjeria — immigration consultants. Country: CA.
 * Off by default; set PROLIO_RUN_RQCI_QC_CA=true to enable.
 */

const OPEN_CA_PACKAGE_ID = "23f8d075-4574-4238-a3d1-f3ba5674fce0";
const RESOURCE_ID = "26d1f57f-1f1d-4856-af54-d7b3cdb57954";
// Stable fallback URL (keeps working if CKAN API is slow)
const FALLBACK_CSV_URL =
  "https://www.donneesquebec.ca/recherche/dataset/" +
  "23f8d075-4574-4238-a3d1-f3ba5674fce0/resource/" +
  "26d1f57f-1f1d-4856-af54-d7b3cdb57954/download/consultants20260527.csv";

const AUTHORITY = "MIFI-Québec";
const PROVINCE = "QC";
const REQUEST_TIMEOUT_MS = 60_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// --- Source definition --------------------------------------------------

export const rqciQcCaSource: ScraperSource = {
  name: "rqci-qc-ca" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_RQCI_QC_CA === "true";
  },
  async fetch() {
    return [];
  },
};

// --- City mapping -------------------------------------------------------

/** Normalise a French city name to a slug candidate. */
function normCity(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Map a Quebec city name to a city slug known to the Prolio DB.
 * Returns "montreal" as fallback for any unrecognised address
 * (safe because ~44 % of records are actually in Montréal and the
 * rest are distributed across QC cities where we'd rather have a
 * montreal landing than no landing at all).
 */
function resolveCity(raw: string | undefined): string {
  if (!raw) return "montreal";
  const key = normCity(raw.trim());
  if (!key) return "montreal";

  // Direct matches for known slugs
  const directMap: Record<string, string> = {
    montreal: "montreal",
    laval: "laval",
    quebec: "quebec-city",
    gatineau: "gatineau",
    longueuil: "longueuil",
    sherbrooke: "sherbrooke",
    terrebonne: "terrebonne",
    "trois-rivieres": "trois-rivieres",
    levis: "levis",
    drummondville: "drummondville",
    "saint-jerome": "saint-jerome",
    granby: "granby",
    blainville: "blainville",
    "saint-hyacinthe": "saint-hyacinthe",
    repentigny: "repentigny",
    shawinigan: "shawinigan",
    brossard: "longueuil", // Brossard is part of the Longueuil agglomeration
    // Montreal boroughs / communities → montreal
    "saint-laurent": "montreal",
    verdun: "montreal",
    "cote-des-neiges": "montreal",
    "cote-saint-luc": "montreal",
    "saint-leonard": "montreal",
    "rosemont": "montreal",
    "outremont": "montreal",
    "westmount": "montreal",
    "mont-royal": "montreal",
    "saint-jean-sur-richelieu": "saint-jean-sur-richelieu",
    // Fallback for common misspellings
    "ville-saint-laurent": "montreal",
  };

  if (directMap[key]) return directMap[key];

  // Partial prefix matches for long variants
  if (key.startsWith("montreal")) return "montreal";
  if (key.startsWith("laval")) return "laval";
  if (key.startsWith("trois-rivi")) return "trois-rivieres";
  if (key.startsWith("levis") || key.startsWith("levy")) return "levis";
  if (key.startsWith("longueuil")) return "longueuil";
  if (key.startsWith("saint-jerome") || key.startsWith("st-jerome"))
    return "saint-jerome";
  if (key.startsWith("saint-hyacinthe") || key.startsWith("st-hyacinthe"))
    return "saint-hyacinthe";
  if (key.startsWith("saint-jean-sur-richelieu") || key.startsWith("st-jean-sur-richelieu"))
    return "saint-jean-sur-richelieu";

  // Default fallback — QC capital or montreal depending on prefix
  if (key.startsWith("quebec")) return "quebec-city";

  return "montreal";
}

// --- CSV helpers --------------------------------------------------------

function stripBom(s: string): string {
  // UTF-8 BOM is U+FEFF — strip from start of string
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

interface RqciRow {
  statut: string;
  noInscription: string;
  nom: string;
  prenom: string;
  dateReconnaissance: string;
  adresse1: string;
  ville: string;
  province: string;
  codePostal: string;
  courriel: string;
}

/**
 * Minimal CSV parser for the MIFI dataset.
 * Handles RFC 4180 quoted fields (double-quote escaping).
 */
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      let val = "";
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          val += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          val += line[i];
          i++;
        }
      }
      fields.push(val);
      if (line[i] === ",") i++;
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      } else {
        fields.push(line.slice(i, end));
        i = end + 1;
      }
    }
  }
  return fields;
}

function parseCsv(text: string): RqciRow[] {
  const clean = stripBom(text);
  const lines = clean.split(/\r?\n/);
  const rows: RqciRow[] = [];
  // Skip header (line 0)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvRow(line);
    // Expected columns:
    // 0:STATUT  1:NOINSCRIPTION  2:NOM  3:PRENOM  4:DATERECONNAISSANCE
    // 5:ENTREPRISEADRESSE1  6:ENTREPRISEADRESSE2  7:ENTREPRISEADRESSE3
    // 8:ENTREPRISEVILLE  9:ENTREPRISEPROVINCE  10:ENTREPRISECODEPOSTAL
    // 11:COURRIEL
    if (cols.length < 4) continue;
    rows.push({
      statut: (cols[0] ?? "").trim(),
      noInscription: (cols[1] ?? "").trim(),
      nom: (cols[2] ?? "").trim(),
      prenom: (cols[3] ?? "").trim(),
      dateReconnaissance: (cols[4] ?? "").trim(),
      adresse1: (cols[5] ?? "").trim(),
      ville: (cols[8] ?? "").trim(),
      province: (cols[9] ?? "").trim(),
      codePostal: (cols[10] ?? "").trim(),
      courriel: (cols[11] ?? "").trim(),
    });
  }
  return rows;
}

// --- Network helpers ----------------------------------------------------

async function httpGet(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/csv,application/json,*/*;q=0.8",
        "Accept-Language": "fr-CA,fr;q=0.9,en;q=0.5",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[rqci-qc-ca] HTTP ${res.status} on ${url}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(`[rqci-qc-ca] fetch error on ${url}: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discover the current CSV download URL via the open.canada.ca CKAN API.
 * Falls back to the hardcoded URL if the API is unavailable.
 */
async function discoverCsvUrl(): Promise<string> {
  const apiUrl = `https://open.canada.ca/data/api/3/action/package_show?id=${OPEN_CA_PACKAGE_ID}`;
  const body = await httpGet(apiUrl);
  if (!body) {
    console.warn("[rqci-qc-ca] CKAN API unavailable — using fallback CSV URL");
    return FALLBACK_CSV_URL;
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(body);
  } catch {
    console.warn("[rqci-qc-ca] CKAN API response is not JSON — using fallback");
    return FALLBACK_CSV_URL;
  }
  const result = (pkg as { result?: { resources?: { id?: string; url?: string; format?: string }[] } }).result;
  if (!result?.resources) {
    console.warn("[rqci-qc-ca] no resources in CKAN package — using fallback");
    return FALLBACK_CSV_URL;
  }
  const csvResource = result.resources.find(
    (r) => r.id === RESOURCE_ID && (r.format ?? "").toUpperCase() === "CSV",
  );
  if (csvResource?.url) {
    console.log(`[rqci-qc-ca] discovered CSV URL: ${csvResource.url}`);
    return csvResource.url;
  }
  // Fallback: first CSV resource found
  const anycsv = result.resources.find((r) => (r.format ?? "").toUpperCase() === "CSV");
  if (anycsv?.url) {
    console.log(`[rqci-qc-ca] using first CSV resource: ${anycsv.url}`);
    return anycsv.url;
  }
  console.warn("[rqci-qc-ca] no CSV resource found in CKAN package — using fallback");
  return FALLBACK_CSV_URL;
}

// --- Main runner --------------------------------------------------------

export async function runRqciQcCa(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!rqciQcCaSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  // Step 1: discover download URL
  const csvUrl = await discoverCsvUrl();

  // Step 2: download CSV
  const csvText = await httpGet(csvUrl);
  if (!csvText) {
    console.warn("[rqci-qc-ca] could not download CSV");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  // Step 3: parse
  const allRows = parseCsv(csvText);
  console.log(`[rqci-qc-ca] CSV rows parsed: ${allRows.length}`);

  // Step 4: filter to active (REC = Reconnu) only
  const activeRows = allRows.filter((r) => r.statut === "REC");
  console.log(`[rqci-qc-ca] active (REC) rows: ${activeRows.length}`);

  if (activeRows.length === 0) {
    console.warn("[rqci-qc-ca] no active rows — CSV format may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  // Step 5: normalise
  const records: ScrapedProfessional[] = [];
  let droppedNoName = 0;
  let droppedNoId = 0;

  for (const row of activeRows) {
    const nom = row.nom.trim();
    const prenom = row.prenom.trim();
    if (!nom) {
      droppedNoName++;
      continue;
    }
    if (!row.noInscription) {
      droppedNoId++;
      continue;
    }
    const name = prenom ? `${prenom} ${nom}` : nom;
    const sourceId = `rqci-qc:${row.noInscription}`;
    const citySlug = resolveCity(row.ville);

    const address = [row.adresse1, row.ville, row.province, row.codePostal]
      .filter(Boolean)
      .join(", ");

    records.push(
      normalise({
        source: "rqci-qc-ca" as ScrapeSource,
        country: "CA",
        sourceId,
        name,
        categoryKey: "extranjeria",
        citySlug,
        address: address || undefined,
        email: row.courriel || undefined,
        licenseNumber: row.noInscription || undefined,
        metadata: {
          country: "CA",
          province: PROVINCE,
          authority: AUTHORITY,
          verified_by_authority: true,
          registration_status: "REC",
          date_recognized: row.dateReconnaissance || null,
          postal_code: row.codePostal || null,
        },
      }),
    );
  }

  console.log(
    `[rqci-qc-ca] normalised=${records.length} ` +
      `droppedNoName=${droppedNoName} droppedNoId=${droppedNoId}`,
  );

  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[rqci-qc-ca] done — fetched=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
