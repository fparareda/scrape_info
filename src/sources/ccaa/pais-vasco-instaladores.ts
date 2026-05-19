import type { CategoryKey } from "../../prolio-types.js";
import type { ScrapedProfessional } from "../../types.js";
import type { CcaaSource } from "./types.js";
import { normalise, slugify } from "../../normalise.js";

/**
 * Euskadi — Registro de Empresas Instaladoras (electricidad, gas,
 * térmicas, frigoríficas, etc.).
 *
 * Source: open.euskadi.eus open-data portal. The exact dataset slug
 * changes occasionally; the default URL below is a documented entry
 * point but **must be verified on first run**. Override at runtime
 * with `PROLIO_EUSKADI_INSTALADORES_CSV` if Euskadi rotates the path.
 *
 * The Aragón source ([aragon-instaladores.ts](./aragon-instaladores.ts))
 * is the proven blueprint; everything below mirrors it. CSV columns
 * vary slightly between portals: this parser auto-detects the cif /
 * razón social / municipio / teléfono columns by header substring so
 * we don't crash if Euskadi reshuffles them.
 */

const DEFAULT_URL =
  "https://opendata.euskadi.eus/contenidos/ds_recursos_industriales/empresas_instaladoras/opendata/empresas_instaladoras.csv";
const USER_AGENT = "Prolio/0.1 (ferranp.work@gmail.com)";

function denominacionToCategory(denom: string): CategoryKey | undefined {
  const d = denom.toLowerCase();
  if (d.includes("eléctric") || d.includes("electric") || d.includes("baja tensión"))
    return "electricidad";
  if (
    d.includes("gas") ||
    d.includes("térmic") ||
    d.includes("termic") ||
    d.includes("frigor") ||
    d.includes("agua") ||
    d.includes("calefac") ||
    d.includes("climat")
  )
    return "fontaneria";
  return undefined;
}

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
  // Euskadi CSVs sometimes use ';' as separator — auto-detect.
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
  for (const k of candidates) {
    if (row[k]) return row[k];
  }
  for (const k of Object.keys(row)) {
    for (const c of candidates) {
      if (k.includes(c) && row[k]) return row[k];
    }
  }
  return "";
}

export const paisVascoInstaladores: CcaaSource = {
  name: "pais-vasco-instaladores",
  ccaaCode: "PV",
  categories: ["electricidad", "fontaneria"],

  enabled() {
    return process.env.PROLIO_SCRAPE_CCAA === "true";
  },

  async fetch(): Promise<ScrapedProfessional[]> {
    const url = process.env.PROLIO_EUSKADI_INSTALADORES_CSV || DEFAULT_URL;
    let response: Response;
    try {
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (error) {
      console.error(
        `[pais-vasco-instaladores] network error: ${(error as Error).message}`,
      );
      return [];
    }
    if (!response.ok) {
      console.error(`[pais-vasco-instaladores] ${response.status} on ${url}`);
      return [];
    }
    const text = await response.text();
    const rows = parseCsv(text);
    const seen = new Set<string>();
    const out: ScrapedProfessional[] = [];

    for (const row of rows) {
      const cif = pick(row, ["cif", "nif", "documento"]);
      const nombre = pick(row, ["razon_social", "razón_social", "empresa", "nombre"]);
      if (!cif || !nombre) continue;
      const category = denominacionToCategory(
        pick(row, ["denominacion", "denominación", "especialidad", "actividad", "tipo"]),
      );
      if (!category) continue;
      const key = `${cif}:${category}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const municipio = pick(row, ["municipio", "poblacion", "población", "localidad"]);
      const citySlug = slugify(municipio);
      if (!citySlug) continue;
      const direccion = pick(row, ["domicilio", "direccion", "dirección"]);
      const cp = pick(row, ["cp", "codigo_postal", "código_postal"]);
      const address = [direccion, cp, municipio].filter(Boolean).join(", ");

      out.push(
        normalise({
          source: "ccaa_registry",
          country: "ES",
          sourceId: `pais-vasco-instalador:${cif}:${category}`,
          name: nombre,
          categoryKey: category,
          citySlug,
          phone: pick(row, ["telefono", "teléfono"]) || undefined,
          website: pick(row, ["web", "url"]) || undefined,
          address: address || undefined,
          licenseNumber: cif,
          metadata: {
            ccaa: "PV",
            registry: "pais-vasco-instaladores",
            provincia: pick(row, ["provincia", "territorio"]),
          },
        }),
      );
    }
    return out;
  },
};
