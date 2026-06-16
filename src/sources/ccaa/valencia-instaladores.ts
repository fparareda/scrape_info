import type { CategoryKey } from "../../prolio-types.js";
import type { ScrapedProfessional } from "../../types.js";
import type { CcaaSource } from "./types.js";
import { normalise, slugify } from "../../normalise.js";

/**
 * Comunitat Valenciana — Registre d'Empreses Instal·ladores i
 * Mantenedores.
 *
 * Source: dadesobertes.gva.es. Default URL is a documented entry
 * point but **must be verified on first run**. Override with
 * `PROLIO_VALENCIA_INSTALADORES_CSV`.
 *
 * Headers may be Catalan or Spanish; the `pick()` helper accepts both.
 */

const DEFAULT_URL =
  "https://dadesobertes.gva.es/dataset/empreses-instal-ladores/resource/empreses-instal-ladores.csv";
const USER_AGENT = "Prolio/0.1 (ferranp.work@gmail.com)";
// Hard ceiling on the request. Node's global fetch has NO default
// timeout: a stalled endpoint would hang the await forever and the
// whole ccaa run would never terminate.
const FETCH_TIMEOUT_MS = 120_000;

function denominacionToCategory(denom: string): CategoryKey | undefined {
  const d = denom.toLowerCase();
  if (d.includes("eléctric") || d.includes("electric") || d.includes("elèctric"))
    return "electricidad";
  if (
    d.includes("gas") ||
    d.includes("térmic") ||
    d.includes("termic") ||
    d.includes("frigor") ||
    d.includes("agua") ||
    d.includes("aigua") ||
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

export const valenciaInstaladores: CcaaSource = {
  name: "valencia-instaladores",
  ccaaCode: "VC",
  categories: ["electricidad", "fontaneria"],

  enabled() {
    return process.env.PROLIO_SCRAPE_CCAA === "true";
  },

  async fetch(): Promise<ScrapedProfessional[]> {
    const url = process.env.PROLIO_VALENCIA_INSTALADORES_CSV || DEFAULT_URL;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      console.error(
        `[valencia-instaladores] network error: ${(error as Error).message}`,
      );
      return [];
    }
    if (!response.ok) {
      console.error(`[valencia-instaladores] ${response.status} on ${url}`);
      return [];
    }
    const text = await response.text();
    const rows = parseCsv(text);
    const seen = new Set<string>();
    const out: ScrapedProfessional[] = [];

    for (const row of rows) {
      const cif = pick(row, ["cif", "nif", "documento"]);
      const nombre = pick(row, [
        "razo_social",
        "razon_social",
        "razón_social",
        "rao_social",
        "empresa",
        "nombre",
        "nom",
      ]);
      if (!cif || !nombre) continue;
      const category = denominacionToCategory(
        pick(row, [
          "denominacion",
          "denominación",
          "denominacio",
          "especialidad",
          "especialitat",
          "actividad",
          "activitat",
          "tipo",
        ]),
      );
      if (!category) continue;
      const key = `${cif}:${category}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const municipio = pick(row, [
        "municipio",
        "municipi",
        "poblacion",
        "població",
        "población",
        "localidad",
      ]);
      const citySlug = slugify(municipio);
      if (!citySlug) continue;
      const direccion = pick(row, ["domicili", "domicilio", "direccion", "dirección"]);
      const cp = pick(row, ["cp", "codi_postal", "codigo_postal", "código_postal"]);
      const address = [direccion, cp, municipio].filter(Boolean).join(", ");

      out.push(
        normalise({
          source: "ccaa_registry",
          country: "ES",
          sourceId: `valencia-instalador:${cif}:${category}`,
          name: nombre,
          categoryKey: category,
          citySlug,
          phone: pick(row, ["telefon", "telefono", "teléfono"]) || undefined,
          website: pick(row, ["web", "url"]) || undefined,
          address: address || undefined,
          licenseNumber: cif,
          metadata: {
            ccaa: "VC",
            registry: "valencia-instaladores",
            provincia: pick(row, ["provincia", "província"]),
          },
        }),
      );
    }
    return out;
  },
};
