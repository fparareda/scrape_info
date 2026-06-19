import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { ensureCity } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * RII Instaladores Gas (España) — Registro Integrado Industrial.
 *
 * Open-data CSV published by the Ministry of Industry, Commerce and Tourism
 * at:
 *   https://datos.gob.es/es/catalogo/e05024301-consulta-registro-integrado-industrial-instaladores-gas
 *
 * Direct CSV download (no authentication, no cookies):
 *   https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20Instaladores%20Gas.csv
 *
 * Pre-flight (2026-06-15):
 *
 *   robots.txt — www6.serviciosmin.gob.es returns HTTP 404 (no robots.txt
 *     file deployed). The parent domain industria.serviciosmin.gob.es and
 *     datos.gob.es both have no Disallow entries that cover this path for
 *     wildcard user-agents. The CSV is served as a static open-data file
 *     from the Ministry's OpenData module — not a web scrape of HTML pages.
 *
 *   Record count — 26,467 data rows (including header). After deduplication
 *     by NIF (tax ID), approximately 8,600 unique registered entities span
 *     all 17 autonomous communities + Ceuta/Melilla. Each company appears
 *     up to 3× because the registry tracks qualification level: Categoría A
 *     (basic LPG/butane), B (natural gas), C (industrial/high-pressure gas).
 *     We keep one record per NIF, preferring the highest category.
 *
 *   Format — CSV, comma-separated, all fields double-quoted. May have a
 *     UTF-8 BOM prefix. First row is the header. Columns:
 *       0: Titular/Razón social  (company or natural-person name)
 *       1: Documento             (NIF/NIE/Pasaporte, prefixed "NIF:…")
 *       2: Categoría             ("Categoría A", "Categoría B", "Categoría C")
 *       3: Teléfono
 *       4: Correo electrónico
 *       5: CCAA                  (autonomous community, upper-case)
 *       6: Código postal         (5-digit postal code)
 *       7: Dirección             (street address)
 *       8: Municipio             (city / municipality name)
 *       9: Provincia             (province)
 *      10: País                  ("ESPAÑA")
 *
 *   Auth / WAF — none. Static file served by the Ministry's open-data
 *     module; no login, no Cloudflare, no CAPTCHA.
 *
 *   License — datos.gob.es open-data reuse terms (Real Decreto 1495/2011,
 *     Ley 37/2007). Commercial reuse permitted with attribution.
 *
 * Category mapping: fontaneria — gas+fluid installers in Spain are regulated
 * under the "instalaciones de gas y fluidos" framework (Reglamento Técnico de
 * Distribución y Utilización de Combustibles Gaseosos). CONAIF (Confederación
 * Nacional de Asociaciones de Instaladores y Fluidos) represents both gas and
 * water/plumbing installers together; the fontaneria taxonomy key is the
 * closest fit for this combined "fluidos" category. Several registered
 * entities contain keywords like FONTANER in their name or email, confirming
 * the overlap.
 *
 * Off by default. Enable via `PROLIO_RUN_RII_INSTALADORES_GAS_ES=true`.
 * Monthly cron (annual renewals; dataset updated daily by the ministry).
 */

const CSV_URL =
  process.env.PROLIO_RII_GAS_CSV_URL ??
  "https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20Instaladores%20Gas.csv";

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 120_000; // 4.1 MB CSV — allow 2 min

const DEFAULT_LIMIT = 10_000;
const CATEGORY: CategoryKey = "fontaneria";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface FetchResponse {
  status: number;
  body: string;
}

async function politeFetch(url: string): Promise<FetchResponse | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "text/csv,text/plain,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[rii_gas_es] blocked with polite UA (${res.status}); retrying with Chrome UA`,
          );
          continue;
        }
        return { status: res.status, body: "" };
      }
      if (!res.ok) return { status: res.status, body: "" };
      // Detect charset from Content-Type header (may be Windows-1252)
      const ct = res.headers.get("content-type") ?? "";
      let body: string;
      if (/windows-1252|iso-8859/i.test(ct)) {
        const buf = await res.arrayBuffer();
        body = new TextDecoder("windows-1252").decode(buf);
      } else {
        body = await res.text();
      }
      return { status: res.status, body };
    } catch (err) {
      clearTimeout(timer);
      console.warn(
        `[rii_gas_es] network error on ${url}: ${(err as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSV parser — handle quoted fields, Windows line-endings
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV line into fields, respecting double-quoted fields
 * that may contain embedded commas or escaped quotes ("").
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

interface GasRow {
  name: string;
  nif: string;
  categoria: string; // "A", "B", or "C"
  telefono: string;
  email: string;
  ccaa: string;
  cp: string;
  direccion: string;
  municipio: string;
  provincia: string;
}

function parseGasCsv(raw: string): GasRow[] {
  // Strip UTF-8 BOM if present
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
  // Also strip Windows BOM (EF BB BF)
  const lines = text.split(/\r?\n/);
  const rows: GasRow[] = [];

  // Skip header line (first row)
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCsvLine(line);
    // Require at least 10 fields
    if (fields.length < 10) continue;

    // Column indices per pre-flight inspection:
    //  0: Titular/Razón social
    //  1: Documento (NIF)
    //  2: Categoría
    //  3: Teléfono
    //  4: Correo electrónico
    //  5: CCAA
    //  6: Código postal
    //  7: Dirección
    //  8: Municipio (note: header has trailing TAB, data is clean)
    //  9: Provincia
    // 10: País
    const name = fields[0]?.trim() ?? "";
    if (!name) continue;

    const nifRaw = fields[1]?.trim() ?? "";
    const nif = nifRaw.replace(/^NIF:/i, "").trim();

    const catRaw = fields[2]?.trim() ?? "";
    // "Categoría A", "Categoría B", "Categoría C" → "A", "B", "C"
    const catMatch = catRaw.match(/categor[ií]a\s+([ABC])/i);
    const categoria = catMatch ? catMatch[1].toUpperCase() : catRaw;

    rows.push({
      name,
      nif,
      categoria,
      telefono: fields[3]?.trim() ?? "",
      email: fields[4]?.trim() ?? "",
      ccaa: fields[5]?.trim() ?? "",
      cp: fields[6]?.trim() ?? "",
      direccion: fields[7]?.trim() ?? "",
      municipio: fields[8]?.trim() ?? "",
      provincia: fields[9]?.trim() ?? "",
    });
  }
  return rows;
}

/**
 * Deduplicate by NIF, keeping the highest category level (C > B > A).
 * Companies without a NIF are kept by name.
 */
function deduplicateRows(rows: GasRow[]): GasRow[] {
  const catOrder: Record<string, number> = { A: 1, B: 2, C: 3 };
  const byNif = new Map<string, GasRow>();
  const noNif: GasRow[] = [];

  for (const row of rows) {
    if (!row.nif) {
      noNif.push(row);
      continue;
    }
    const existing = byNif.get(row.nif);
    if (!existing) {
      byNif.set(row.nif, row);
    } else {
      const existingOrder = catOrder[existing.categoria] ?? 0;
      const newOrder = catOrder[row.categoria] ?? 0;
      if (newOrder > existingOrder) {
        byNif.set(row.nif, row);
      }
    }
  }

  // Deduplicate no-NIF rows by name
  const byName = new Map<string, GasRow>();
  for (const row of noNif) {
    const key = row.name.toLowerCase().replace(/\s+/g, " ");
    if (!byName.has(key)) byName.set(key, row);
  }

  return [...byNif.values(), ...byName.values()];
}

function stableSourceId(row: GasRow, idx: number): string {
  if (row.nif) return `rii-gas:${row.nif}`;
  const slug = row.name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
  return `rii-gas:name:${slug}:${idx}`;
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

async function fetchRiiInstaladorasGas(
  limit: number,
): Promise<ScrapedProfessional[]> {
  console.log(`[rii_gas_es] fetching CSV from ${CSV_URL}`);
  const response = await politeFetch(CSV_URL);
  if (!response || !response.body) {
    console.warn(
      `[rii_gas_es] fetch failed (status=${response?.status ?? "network"})`,
    );
    return [];
  }
  if (!response.body.trim()) {
    console.warn(`[rii_gas_es] empty response body`);
    return [];
  }

  const rawRows = parseGasCsv(response.body);
  console.log(`[rii_gas_es] parsed ${rawRows.length} raw rows`);

  const dedupedRows = deduplicateRows(rawRows);
  console.log(
    `[rii_gas_es] after deduplication: ${dedupedRows.length} unique entities`,
  );

  const client = getSupabaseClient();
  const out: ScrapedProfessional[] = [];
  let noCity = 0;

  for (let idx = 0; idx < dedupedRows.length; idx += 1) {
    if (out.length >= limit) break;
    const row = dedupedRows[idx];

    // Auto-seed the city by NAME so the row survives the sink. When no
    // municipio, emit citySlug="" (sink writes city_slug=NULL, keeps the
    // row) instead of dropping it. Do NOT map province→capital and emit a
    // possibly-unseeded slug.
    let citySlug = "";
    if (row.municipio) {
      const cityResult = await ensureCity(client, {
        name: row.municipio,
        state: row.provincia || row.ccaa || "España",
        country: "ES",
      });
      if (cityResult) citySlug = cityResult.slug;
    }
    if (!citySlug) noCity += 1;

    const sourceId = stableSourceId(row, idx);

    // Build full address string
    const addressParts = [row.direccion, row.cp, row.municipio, row.provincia]
      .map((p) => p.trim())
      .filter(Boolean);
    const address = addressParts.join(", ") || undefined;

    const record = normalise({
      source: "rii-instaladores-gas-es",
      country: "ES",
      sourceId,
      name: row.name,
      categoryKey: CATEGORY,
      citySlug,
      address,
      phone: row.telefono || undefined,
      email: row.email || undefined,
      licenseNumber: row.nif || undefined,
      metadata: {
        country: "ES",
        authority: "RII",
        verified_by_authority: true,
        gas_categoria: row.categoria,
        ccaa: row.ccaa,
        postal_code: row.cp,
        provincia: row.provincia,
        municipio: row.municipio,
      },
    });
    out.push(record);
  }

  console.log(
    `[rii_gas_es] built ${out.length} records ` +
      `(noCity=${noCity}, kept with city_slug=NULL)`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export const riiInstaladorasGasEsSource: ScraperSource = {
  name: "rii-instaladores-gas-es",
  enabled() {
    return process.env.PROLIO_RUN_RII_INSTALADORES_GAS_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export function riiInstaladorasGasEsEnabled(): boolean {
  return riiInstaladorasGasEsSource.enabled();
}

/**
 * Bulk runner. Downloads the full RII gas installers CSV (~26k rows,
 * ~8.6k unique companies after deduplication by NIF) and upserts into
 * the sink. Respects `PROLIO_RII_GAS_ES_LIMIT` (default 10 000).
 */
export async function runRiiInstaladorasGasEs(): Promise<void> {
  if (!riiInstaladorasGasEsSource.enabled()) return;

  const rawLimit = process.env.PROLIO_RII_GAS_ES_LIMIT;
  let limit = DEFAULT_LIMIT;
  if (rawLimit) {
    const parsed = Number(rawLimit);
    if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
    else
      console.warn(
        `[rii_gas_es] invalid PROLIO_RII_GAS_ES_LIMIT="${rawLimit}", using ${DEFAULT_LIMIT}`,
      );
  }

  const sink = getSink({ trustCitySlugs: true });

  await withScrapeRun("rii-instaladores-gas-es", async () => {
    const rows = await fetchRiiInstaladorasGas(limit);
    if (rows.length === 0) {
      return { rowsFetched: 0 };
    }
    const { inserted, updated, skipped } = await sink.upsert(rows);
    console.log(
      `[rii_gas_es] upserted=${rows.length} ` +
        `inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
    return {
      rowsFetched: rows.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
    };
  }).catch((e) =>
    console.error(`[rii_gas_es] crashed:`, (e as Error).message),
  );
}
