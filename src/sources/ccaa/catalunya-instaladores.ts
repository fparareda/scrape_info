import type { ScrapedProfessional } from "../../types.js";
import type { CcaaSource } from "./types.js";
import { normalise, slugify } from "../../normalise.js";

/**
 * Cataluña — Registre d'Agents de la Seguretat Industrial (RASIC) ·
 * Empreses d'instal·lació, manteniment, reparació i operació.
 *
 * Dataset: qcrr-stew on transparenciacatalunya (Socrata).
 * Docs:    https://analisi.transparenciacatalunya.cat/Economia/Empreses-d-instal-laci-manteniment-reparaci-i-oper/qcrr-stew
 *
 * The registry is a single CSV with one row per empresa and **one boolean
 * column per specialty** (AT Línies, BT Instal·lacions, ITE Climatització,
 * Gas, Fred Industrial, etc. — value = "Sí"/"No"). A single empresa can
 * hold multiple authorisations; we emit one pro row per category it
 * qualifies for, with a distinct sourceId per (empresa, category) pair so
 * the sink doesn't collapse them.
 *
 * No env var required — URL is baked in because it's a stable public
 * Socrata endpoint. Override via PROLIO_CAT_INSTALADORES_CSV if needed.
 */

const DEFAULT_URL =
  "https://analisi.transparenciacatalunya.cat/api/views/qcrr-stew/rows.csv?accessType=DOWNLOAD";
const USER_AGENT = "Prolio/0.1 (ferranp.work@gmail.com)";
// Hard ceiling on the request. Node's global fetch has NO default
// timeout: a stalled endpoint would hang the await forever and the
// whole ccaa run would never terminate.
const FETCH_TIMEOUT_MS = 120_000;

// Columns that signal the pro installs electricity (AT = alta tensión,
// BT = baja tensión). Any "Sí" triggers electricidad.
const ELECTRICITY_COLS = [
  "at línies",
  "at instal·lacions",
  "at installacions",
  "bt instal·lacions",
  "bt installacions",
];

// Columns that signal thermal / gas / refrigeration — we bucket all into
// fontanería since it's the closest Prolio category (home comfort
// installers: heating, hot water, gas, refrigeration).
const PLUMBING_COLS = [
  "ite calefacció i acs",
  "ite calefaccio i acs",
  "ite climatització",
  "ite climatitzacio",
  "ite instal·lacions tèrmiques",
  "ite installacions termiques",
  "fred industrial",
  "gas",
];

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = (cells[j] ?? "").trim();
    }
    out.push(row);
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') inQuotes = false;
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function hasSi(row: Record<string, string>, cols: string[]): boolean {
  for (const c of cols) {
    const v = row[c];
    if (v && v.toLowerCase().startsWith("sí")) return true;
    if (v && v.toLowerCase() === "si") return true;
  }
  return false;
}

export const catalunyaInstaladores: CcaaSource = {
  name: "catalunya-instaladores",
  ccaaCode: "CT",
  categories: ["electricidad", "fontaneria"],

  enabled() {
    return process.env.PROLIO_SCRAPE_CCAA === "true";
  },

  async fetch(): Promise<ScrapedProfessional[]> {
    const url = process.env.PROLIO_CAT_INSTALADORES_CSV || DEFAULT_URL;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      console.error(
        `[catalunya-instaladores] network error: ${(error as Error).message}`,
      );
      return [];
    }
    if (!response.ok) {
      console.error(`[catalunya-instaladores] ${response.status} on ${url}`);
      return [];
    }
    const text = await response.text();
    const rows = parseCsv(text);
    const out: ScrapedProfessional[] = [];

    for (const row of rows) {
      const estat = (row["estat registre"] ?? "").toLowerCase();
      if (estat && estat !== "alta") continue;

      const nombre = row["titular"];
      if (!nombre) continue;

      const registro = row["número rasic registre"] ?? "";
      const municipio = row["municipi"] ?? "";
      const citySlug = slugify(municipio);
      if (!citySlug) continue;

      const direccion = row["adreça agrupada"];
      const cp = row["codi postal"];
      const telefono = row["telèfon fix"] || row["telèfon mòbil"];
      const email = row["correu electrònic"];
      const address = [direccion, cp, municipio].filter(Boolean).join(", ");

      const categories: Array<"electricidad" | "fontaneria"> = [];
      if (hasSi(row, ELECTRICITY_COLS)) categories.push("electricidad");
      if (hasSi(row, PLUMBING_COLS)) categories.push("fontaneria");

      // Record the pro under each category it's authorised for. Distinct
      // sourceIds keep the sink from collapsing them.
      for (const category of categories) {
        out.push(
          normalise({
            source: "ccaa_registry",
            country: "ES",
            sourceId: `cat-instalador:${registro || slugify(nombre)}:${category}`,
            name: nombre,
            categoryKey: category,
            citySlug,
            phone: telefono,
            email,
            address: address || undefined,
            licenseNumber: registro || undefined,
            metadata: {
              ccaa: "CT",
              registry: "catalunya-instaladores",
              comarca: row["comarca"],
              provincia: row["província"] ?? row["provincia"],
            },
          }),
        );
      }
    }
    return out;
  },
};
