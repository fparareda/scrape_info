import type { ScrapedProfessional } from "../../types.js";
import type { CcaaSource } from "./types.js";
import { normalise, slugify } from "../../normalise.js";

/**
 * Galicia — Rexistro de Talleres de Reparación de Vehículos.
 *
 * Source: abertos.xunta.gal. Default URL is a documented entry point
 * but **must be verified on first run** — the Xunta open-data portal
 * rotates filenames per release. Override at runtime with
 * `PROLIO_GALICIA_TALLERES_CSV`.
 *
 * Talleres feed `mecanica`. Headers may be Galician or Spanish; we
 * accept both via the `pick()` helper.
 */

const DEFAULT_URL =
  "https://abertos.xunta.gal/catalogo/economia-empresa/-/dataset/0210/rexistro-talleres/talleres.csv";
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

export const galiciaTalleres: CcaaSource = {
  name: "galicia-talleres",
  ccaaCode: "GA",
  categories: ["mecanica"],

  enabled() {
    return process.env.PROLIO_SCRAPE_CCAA === "true";
  },

  async fetch(): Promise<ScrapedProfessional[]> {
    const url = process.env.PROLIO_GALICIA_TALLERES_CSV || DEFAULT_URL;
    let response: Response;
    try {
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (error) {
      console.error(
        `[galicia-talleres] network error: ${(error as Error).message}`,
      );
      return [];
    }
    if (!response.ok) {
      console.error(`[galicia-talleres] ${response.status} on ${url}`);
      return [];
    }
    const text = await response.text();
    const rows = parseCsv(text);
    const seen = new Set<string>();
    const out: ScrapedProfessional[] = [];

    for (const row of rows) {
      // Galicia uses "número de rexistro" (matrícula) instead of CIF as
      // the stable id. Fallback to CIF if the matrícula column is empty.
      const matricula =
        pick(row, ["numero_rexistro", "número_rexistro", "n_rexistro", "matricula", "matrícula"]) ||
        pick(row, ["cif", "nif"]);
      const nombre = pick(row, [
        "razon_social",
        "razón_social",
        "razon_socia",
        "nome",
        "empresa",
        "nombre",
      ]);
      if (!matricula || !nombre) continue;

      const municipio = pick(row, [
        "concello",
        "municipio",
        "poblacion",
        "población",
        "localidad",
      ]);
      const citySlug = slugify(municipio);
      if (!citySlug) continue;

      if (seen.has(matricula)) continue;
      seen.add(matricula);

      const direccion = pick(row, ["enderezo", "direccion", "dirección", "domicilio"]);
      const cp = pick(row, ["cp", "codigo_postal", "código_postal"]);
      const address = [direccion, cp, municipio].filter(Boolean).join(", ");

      out.push(
        normalise({
          source: "ccaa_registry",
          sourceId: `galicia-taller:${matricula}`,
          name: nombre,
          categoryKey: "mecanica",
          citySlug,
          phone: pick(row, ["telefono", "teléfono"]) || undefined,
          website: pick(row, ["web", "url"]) || undefined,
          address: address || undefined,
          licenseNumber: matricula,
          metadata: {
            ccaa: "GA",
            registry: "galicia-talleres",
            provincia: pick(row, ["provincia"]),
            actividade: pick(row, ["actividade", "actividad", "tipo"]),
          },
        }),
      );
    }
    return out;
  },
};
