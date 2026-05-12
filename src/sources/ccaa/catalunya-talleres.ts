import type { ScrapedProfessional } from "../../types.js";
import type { CcaaSource } from "./types.js";
import { normalise, slugify } from "../../normalise.js";

/**
 * Cataluña — Tallers de reparació de vehicles (RASIC).
 *
 * Dataset: ebyt-8dme on transparenciacatalunya (Socrata).
 * Columns verified against the live CSV:
 *   Número de RASIC | Nom titular actual | Adreça | Població | Municipi |
 *   Codi postal | Email | Web de l'establiment | + specialty booleans
 *   (Carrosseria, Electricitat, Mecànica, Pintura, Manipulacio Gas, …)
 *
 * Every row is a vehicle repair workshop regardless of specialty, so we
 * tag all as `mecanica` and stash the specialties in metadata for later
 * filtering.
 */

const DEFAULT_URL =
  "https://analisi.transparenciacatalunya.cat/api/views/ebyt-8dme/rows.csv?accessType=DOWNLOAD";
const USER_AGENT = "Prolio/0.1 (ferranp.work@gmail.com)";

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

export const catalunyaTalleres: CcaaSource = {
  name: "catalunya-talleres",
  ccaaCode: "CT",
  categories: ["mecanica"],

  enabled() {
    return process.env.PROLIO_SCRAPE_CCAA === "true";
  },

  async fetch(): Promise<ScrapedProfessional[]> {
    const url = process.env.PROLIO_CAT_TALLERES_CSV || DEFAULT_URL;
    let response: Response;
    try {
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (error) {
      console.error(
        `[catalunya-talleres] network error: ${(error as Error).message}`,
      );
      return [];
    }
    if (!response.ok) {
      console.error(`[catalunya-talleres] ${response.status} on ${url}`);
      return [];
    }
    const text = await response.text();
    const rows = parseCsv(text);
    const out: ScrapedProfessional[] = [];
    for (const row of rows) {
      const nombre = row["nom titular actual"];
      if (!nombre) continue;
      const registro = row["número de rasic"] ?? "";
      const municipio = row["municipi"] ?? row["població"] ?? "";
      const citySlug = slugify(municipio);
      if (!citySlug) continue;
      const direccion = row["adreça"];
      const cp = row["codi postal"];
      const email = row["email"];
      const website = row["web de l'establiment"];
      const address = [direccion, cp, municipio].filter(Boolean).join(", ");

      const specialties: string[] = [];
      for (const s of [
        "carrosseria",
        "electricitat",
        "mecànica",
        "mecanica",
        "pintura",
        "manipulacio gas",
        "especialitat motos i ciclomotors",
        "especialitat reparació pneumàtics",
        "especialitat reparacio pneumatics",
        "especialitat radiadors",
        "especialitat equips d'injecció",
      ]) {
        const v = row[s];
        if (v && (v.toLowerCase().startsWith("sí") || v.toLowerCase() === "si")) {
          specialties.push(s);
        }
      }

      out.push(
        normalise({
          source: "ccaa_registry",
          sourceId: `cat-taller:${registro || slugify(nombre)}`,
          name: nombre,
          categoryKey: "mecanica",
          citySlug,
          email,
          website,
          address: address || undefined,
          licenseNumber: registro || undefined,
          metadata: {
            ccaa: "CT",
            registry: "catalunya-talleres",
            specialties,
            comarca: row["comarca"],
            provincia: row["província"] ?? row["provincia"],
          },
        }),
      );
    }
    return out;
  },
};
