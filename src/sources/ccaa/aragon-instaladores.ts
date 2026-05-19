import type { CategoryKey } from "../../prolio-types.js";
import type { ScrapedProfessional } from "../../types.js";
import type { CcaaSource } from "./types.js";
import { normalise, slugify } from "../../normalise.js";

/**
 * Aragón — Registro de Empresas Instaladoras y Mantenedoras.
 *
 * Aragón publishes the registry as a single CSV via the open-data
 * portal's GA_OD_Core download endpoint. Columns verified against the
 * live CSV (empresa_razon_social, telefono, municipio, denominacion,
 * etc.) — this source *does* carry phones, unlike the national RII.
 *
 * Dataset page: https://opendata.aragon.es/datos/catalogo/dataset/datos-del-registro-de-empresas-instaladoras-y-o-mantenedoras
 * CSV (all specialties): https://opendata.aragon.es/GA_OD_Core/download?resource_id=328&formato=csv
 *
 * Category mapping uses the `denominacion` field (human-readable
 * specialty name) — Aragón doesn't use CNAE codes in this export.
 */

const DEFAULT_URL =
  "https://opendata.aragon.es/GA_OD_Core/download?resource_id=328&formato=csv";
const USER_AGENT = "Prolio/0.1 (ferranp.work@gmail.com)";

function denominacionToCategory(denom: string): CategoryKey | undefined {
  const d = denom.toLowerCase();
  if (d.includes("eléctric") || d.includes("electric")) return "electricidad";
  if (
    d.includes("gas") ||
    d.includes("térmic") ||
    d.includes("termic") ||
    d.includes("frigor") ||
    d.includes("suministro de agua") ||
    d.includes("calefac")
  )
    return "fontaneria";
  // "Líneas eléctricas" también → electricidad
  // "Productos petrolíferos líquidos" / "Aparatos elevadores" / "Incendios" → fuera de nuestras categorías
  return undefined;
}

function parseCsv(text: string): Array<Record<string, string>> {
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

export const aragonInstaladores: CcaaSource = {
  name: "aragon-instaladores",
  ccaaCode: "AR",
  categories: ["electricidad", "fontaneria"],

  enabled() {
    return process.env.PROLIO_SCRAPE_CCAA === "true";
  },

  async fetch(): Promise<ScrapedProfessional[]> {
    const url = process.env.PROLIO_ARAGON_INSTALADORES_CSV || DEFAULT_URL;
    let response: Response;
    try {
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (error) {
      console.error(
        `[aragon-instaladores] network error: ${(error as Error).message}`,
      );
      return [];
    }
    if (!response.ok) {
      console.error(`[aragon-instaladores] ${response.status} on ${url}`);
      return [];
    }
    const text = await response.text();
    const rows = parseCsv(text);
    // Aragón repeats a row per specialty — one empresa may have 3–5
    // rows if they hold 3–5 authorisations. Dedupe by (cif, category).
    const seen = new Set<string>();
    const out: ScrapedProfessional[] = [];

    for (const row of rows) {
      const cif = row["empresa_cif"];
      const nombre = row["empresa_razon_social"];
      if (!cif || !nombre) continue;
      const category = denominacionToCategory(row["denominacion"] ?? "");
      if (!category) continue;
      const key = `${cif}:${category}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const municipio = row["municipio"] ?? row["poblacion"] ?? "";
      const citySlug = slugify(municipio);
      if (!citySlug) continue;
      const direccion = row["domicilio_social"];
      const cp = row["cp"];
      const address = [direccion, cp, municipio].filter(Boolean).join(", ");

      out.push(
        normalise({
          source: "ccaa_registry",
          country: "ES",
          sourceId: `aragon-instalador:${cif}:${category}`,
          name: nombre,
          categoryKey: category,
          citySlug,
          phone: row["telefono"] || undefined,
          website: row["web"] || undefined,
          address: address || undefined,
          licenseNumber: cif,
          metadata: {
            ccaa: "AR",
            registry: "aragon-instaladores",
            comarca: row["comarca"],
            provincia: row["provincia"],
            denominacion: row["denominacion"],
          },
        }),
      );
    }
    return out;
  },
};
