import type { ScrapedProfessional } from "../../types.js";
import type { CcaaSource } from "./types.js";
import { normalise, slugify } from "../../normalise.js";

/**
 * Comunidad de Madrid — Registro de Talleres de Reparación de
 * Vehículos.
 *
 * Source: datos.comunidad.madrid. Default URL is a documented entry
 * point but **must be verified on first run**. Override with
 * `PROLIO_MADRID_TALLERES_CSV`.
 *
 * Madrid publishes a single CSV with all registered workshops
 * (matrícula, razón social, dirección, municipio, teléfono).
 */

const DEFAULT_URL =
  "https://datos.comunidad.madrid/catalogo/dataset/registro_talleres_reparacion_vehiculos/resource/talleres.csv";
const USER_AGENT = "Prolio/0.1 (ferranp.work@gmail.com)";

function parseCsv(text: string): Array<Record<string, string>> {
  const clean = text.replace(/^﻿/, "");
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
  const sep = line.includes(";") && !line.includes(",") ? ";" : ",";
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
      else if (c === sep) {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function pick(row: Record<string, string>, candidates: string[]): string {
  for (const k of candidates) if (row[k]) return row[k];
  for (const k of Object.keys(row)) {
    for (const c of candidates) {
      if (k.includes(c) && row[k]) return row[k];
    }
  }
  return "";
}

export const madridTalleres: CcaaSource = {
  name: "madrid-talleres",
  ccaaCode: "MD",
  categories: ["mecanica"],

  enabled() {
    return process.env.PROLIO_SCRAPE_CCAA === "true";
  },

  async fetch(): Promise<ScrapedProfessional[]> {
    const url = process.env.PROLIO_MADRID_TALLERES_CSV || DEFAULT_URL;
    let response: Response;
    try {
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (error) {
      console.error(
        `[madrid-talleres] network error: ${(error as Error).message}`,
      );
      return [];
    }
    if (!response.ok) {
      console.error(`[madrid-talleres] ${response.status} on ${url}`);
      return [];
    }
    const text = await response.text();
    const rows = parseCsv(text);
    const seen = new Set<string>();
    const out: ScrapedProfessional[] = [];

    for (const row of rows) {
      const matricula =
        pick(row, ["matricula", "matrícula", "n_registro", "num_registro"]) ||
        pick(row, ["cif", "nif"]);
      const nombre = pick(row, ["razon_social", "razón_social", "empresa", "nombre"]);
      if (!matricula || !nombre) continue;

      const municipio = pick(row, ["municipio", "poblacion", "población", "localidad"]);
      const citySlug = slugify(municipio);
      if (!citySlug) continue;

      if (seen.has(matricula)) continue;
      seen.add(matricula);

      const direccion = pick(row, ["domicilio", "direccion", "dirección"]);
      const cp = pick(row, ["cp", "codigo_postal", "código_postal"]);
      const address = [direccion, cp, municipio].filter(Boolean).join(", ");

      out.push(
        normalise({
          source: "ccaa_registry",
          sourceId: `madrid-taller:${matricula}`,
          name: nombre,
          categoryKey: "mecanica",
          citySlug,
          phone: pick(row, ["telefono", "teléfono"]) || undefined,
          address: address || undefined,
          licenseNumber: matricula,
          metadata: {
            ccaa: "MD",
            registry: "madrid-talleres",
            tipo: pick(row, ["tipo", "rama", "actividad"]),
          },
        }),
      );
    }
    return out;
  },
};
