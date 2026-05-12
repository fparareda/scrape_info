import type { CategoryKey } from "../../prolio-types.js";
import type { ScrapedProfessional } from "../../types.js";
import type { CcaaSource } from "./types.js";
import { normalise, slugify } from "../../normalise.js";

/**
 * RII — Registro Integrado Industrial (Ministerio de Industria).
 *
 * National registry of active industrial companies. Covers **all 17
 * CCAAs + Ceuta/Melilla** in a single ~37MB CSV. Data is sparse
 * (no phone / email / website) but carries name + nº de identificación
 * oficial + municipio + CNAE code, which is enough to create a trusted
 * pre-filled ficha that a pro can later claim and enrich.
 *
 * Dataset page: https://datos.gob.es/en/catalogo/e05024301-consulta-registro-integrado-industrial-division-a
 * CSV endpoint: https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20A.csv
 *
 * We filter rows by CNAE code to a handful of Prolio categories. CNAE
 * values in the CSV are 3-digit groups (not 4-digit classes), so our
 * buckets are inevitably wider than we'd like — but the upsert dedupes
 * and claimed listings stay claimed, so a bit of noise is fine.
 */

const DEFAULT_URL =
  "https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20A.csv";
const USER_AGENT = "Prolio/0.1 (ferranp.work@gmail.com)";

/**
 * Map CNAE 3-digit group → Prolio category.
 *
 *  432 = Instalaciones eléctricas, fontanería y otras en obras (mixed)
 *        → we send to electricidad and fontaneria; a pro can be both
 *  433 = Acabado de edificios (incluye carpintería) → carpinteria
 *  452 = Mantenimiento y reparación de vehículos → mecanica
 *  712 = Ensayos y análisis técnicos (incluye ITV) → itv (noisy)
 */
const CNAE_CATEGORIES: Record<string, CategoryKey[]> = {
  "432": ["electricidad", "fontaneria"],
  "433": ["carpinteria"],
  "452": ["mecanica"],
  "712": ["itv"],
};

// CCAA name (as it appears in the CSV) → 2-letter code we carry in
// metadata. Mostly informational — nothing else depends on it.
const CCAA_NAME_TO_CODE: Record<string, string> = {
  ANDALUCÍA: "AN",
  ANDALUCIA: "AN",
  ARAGÓN: "AR",
  ARAGON: "AR",
  "PRINCIPADO DE ASTURIAS": "AS",
  ASTURIAS: "AS",
  "ILLES BALEARS": "IB",
  "ISLAS BALEARES": "IB",
  BALEARES: "IB",
  CANARIAS: "CN",
  CANTABRIA: "CB",
  "CASTILLA-LA MANCHA": "CM",
  "CASTILLA LA MANCHA": "CM",
  "CASTILLA Y LEÓN": "CL",
  "CASTILLA Y LEON": "CL",
  CATALUÑA: "CT",
  CATALUNYA: "CT",
  "COMUNIDAD VALENCIANA": "VC",
  "COMUNITAT VALENCIANA": "VC",
  EXTREMADURA: "EX",
  "GALICIA": "GA",
  "COMUNIDAD DE MADRID": "MD",
  MADRID: "MD",
  "REGIÓN DE MURCIA": "MC",
  MURCIA: "MC",
  "COMUNIDAD FORAL DE NAVARRA": "NC",
  NAVARRA: "NC",
  "PAÍS VASCO": "PV",
  "PAIS VASCO": "PV",
  EUSKADI: "PV",
  "LA RIOJA": "RI",
  "CIUDAD AUTÓNOMA DE CEUTA": "CE",
  CEUTA: "CE",
  "CIUDAD AUTÓNOMA DE MELILLA": "ML",
  MELILLA: "ML",
};

function ccaaCode(name: string): string {
  return CCAA_NAME_TO_CODE[name.toUpperCase()] ?? "XX";
}

function parseCsv(text: string): Array<Record<string, string>> {
  // Strip BOM if present.
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
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

/**
 * Municipios come in multiple formats in this CSV:
 *   "Elche/Elx"     ← bilingual
 *   "Alicante/Alacant"
 *   "Barcelona"
 * We normalise to the first half (Spanish name) for slug purposes,
 * which matches the cities table better.
 */
function normaliseMunicipio(raw: string): string {
  if (!raw) return "";
  return raw.split("/")[0].trim();
}

export const riiNational: CcaaSource = {
  name: "rii-national",
  ccaaCode: "ES",
  categories: ["electricidad", "fontaneria", "carpinteria", "mecanica", "itv"],

  enabled() {
    return process.env.PROLIO_SCRAPE_CCAA === "true";
  },

  async fetch(): Promise<ScrapedProfessional[]> {
    const url = process.env.PROLIO_RII_CSV || DEFAULT_URL;
    let response: Response;
    try {
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (error) {
      console.error(
        `[rii-national] network error: ${(error as Error).message}`,
      );
      return [];
    }
    if (!response.ok) {
      console.error(`[rii-national] ${response.status} on ${url}`);
      return [];
    }
    const text = await response.text();
    const rows = parseCsv(text);
    console.log(`[rii-national] downloaded ${rows.length} rows`);
    const out: ScrapedProfessional[] = [];
    let kept = 0;

    for (const row of rows) {
      const estado = (row["estado"] ?? "").toUpperCase();
      if (estado && estado !== "ACTIVO") continue;

      const cnae = row["cnae_zzz"] ?? "";
      const categories = CNAE_CATEGORIES[cnae];
      if (!categories) continue;

      const nombre =
        row["denominación"] || row["denominacion"] || row["empresa"];
      if (!nombre) continue;

      const identificacion =
        row["número identificación"] ||
        row["numero identificacion"] ||
        row["identificación"] ||
        row["identificacion"];
      if (!identificacion) continue;

      const ccaa = row["comunidad autónoma"] || row["comunidad autonoma"] || "";
      const provincia = row["provincia"] ?? "";
      const municipioRaw = row["municipio - localidad"] ?? "";
      const municipio = normaliseMunicipio(municipioRaw);
      const citySlug = slugify(municipio);
      if (!citySlug) continue;

      for (const category of categories) {
        kept += 1;
        out.push(
          normalise({
            source: "ccaa_registry",
            sourceId: `rii:${identificacion}:${category}`,
            name: nombre.replace(/\s+/g, " ").trim(),
            categoryKey: category,
            citySlug,
            licenseNumber: identificacion,
            metadata: {
              registry: "rii-national",
              ccaa: ccaaCode(ccaa),
              ccaa_name: ccaa,
              provincia,
              cnae: cnae,
            },
          }),
        );
      }
    }
    console.log(`[rii-national] kept ${kept} rows across Prolio categories`);
    return out;
  },
};
