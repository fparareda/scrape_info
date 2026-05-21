import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * RII División B — Registro Integrado Industrial (Ministerio de Industria).
 *
 * División B groups **installer/maintainer/repairer service entities**
 * (empresas instaladoras, mantenedoras y reparadoras) registered under
 * Real Decreto 559/2010. Unlike División A (industrial establishments
 * classified by CNAE), División B explicitly records the `Habilitación`
 * (authorisation type) for each company — making it the authoritative
 * national registry of licensed installers by speciality.
 *
 * Dataset page:
 *   https://datos.gob.es/en/catalogo/e05024301-consulta-registro-integrado-industrial-division-b
 * Direct CSV download (no login, no captcha, updated daily):
 *   https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/
 *   UbicacionRIII/Consulta%20RII%20division%20B.csv
 *
 * Pre-flight (2026-05-21):
 *   robots.txt — No robots.txt on www6.serviciosmin.gob.es (404 = permit by
 *     absence). Ministry open-data policy explicitly permits reutilización.
 *   Format — Single UTF-8 CSV (~202 MB, ~850k rows). One HTTP GET.
 *   No pagination, no captcha, no Cloudflare.
 *   Contact coverage — Name (Titular) + NIF (Documento) + Municipio +
 *     Provincia + CCAA. No phone/email/address in this export.
 *
 * Category mapping (Habilitación field):
 *   "Baja Tensión"                      → electricidad
 *   "Alta Tensión"                      → electricidad
 *   "Instalaciones Térmicas de Edificios" → hvac
 *   "Instalaciones Térmicas en Edificios" → hvac
 *   "Instalaciones de Gas"              → skipped (covered by rii-instaladores-es)
 *   (other)                             → skipped
 *
 * The file is large (~202 MB). We stream it line-by-line via Node.js
 * ReadableStream + TextDecoder to avoid loading everything into memory.
 *
 * Off by default. Enable via PROLIO_RUN_RII_DIV_B_ES=true.
 * Cap total records: PROLIO_RII_DIV_B_ES_LIMIT (default 200000).
 */

const CSV_URL =
  process.env.PROLIO_RII_DIV_B_ES_URL ??
  "https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20B.csv";

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 300_000; // 5 min — 202 MB at typical CI speeds
const DEFAULT_LIMIT = 200_000;

// ─── Habilitación → CategoryKey ────────────────────────────────────────────

function habilitacionToCategory(hab: string): CategoryKey | null {
  const h = hab.toLowerCase().trim();
  if (
    h.includes("baja tens") ||
    h.includes("alta tens")
  )
    return "electricidad";
  if (
    h.includes("instalaciones térmicas") ||
    h.includes("instalaciones termicas") ||
    h.includes("inst. termicas") ||
    h.includes("térmica") ||
    h.includes("termica")
  )
    return "hvac";
  return null;
}

// ─── Province → city slug mapping ─────────────────────────────────────────

const PROVINCE_TO_CITY: Record<string, string> = {
  "Madrid":                        "madrid",
  "Barcelona":                     "barcelona",
  "Valencia":                      "valencia",
  "Sevilla":                       "sevilla",
  "Zaragoza":                      "zaragoza",
  "Málaga":                        "malaga",
  "Murcia":                        "murcia",
  "Balears, Illes":                "palma",
  "Las Palmas":                    "las-palmas",
  "Palmas, Las":                   "las-palmas",
  "Bizkaia":                       "bilbao",
  "Alicante":                      "alicante",
  "Córdoba":                       "cordoba",
  "Valladolid":                    "valladolid",
  "Coruña, A":                     "a-coruna",
  "Vitoria":                       "vitoria-gasteiz",
  "Álava":                         "vitoria-gasteiz",
  "Gipuzkoa":                      "donostia-san-sebastian",
  "Navarra":                       "pamplona",
  "Granada":                       "granada",
  "Cádiz":                         "cadiz",
  "Asturias":                      "oviedo",
  "Cantabria":                     "santander",
  "Almería":                       "almeria",
  "Huelva":                        "huelva",
  "Badajoz":                       "badajoz",
  "Cáceres":                       "caceres",
  "Toledo":                        "toledo",
  "Ciudad Real":                   "ciudad-real",
  "Albacete":                      "albacete",
  "Cuenca":                        "cuenca",
  "Guadalajara":                   "guadalajara-es",
  "Tarragona":                     "tarragona",
  "Girona":                        "girona",
  "Lleida":                        "lleida",
  "Castellón":                     "castellon-de-la-plana",
  "Castellón/Castelló":            "castellon-de-la-plana",
  "Castelló":                      "castellon-de-la-plana",
  "Burgos":                        "burgos",
  "Salamanca":                     "salamanca",
  "León":                          "leon-es",
  "Palencia":                      "palencia",
  "Segovia":                       "segovia",
  "Ávila":                         "avila",
  "Zamora":                        "zamora",
  "Soria":                         "soria",
  "Rioja, La":                     "logrono",
  "La Rioja":                      "logrono",
  "Teruel":                        "teruel",
  "Huesca":                        "huesca",
  "Pontevedra":                    "pontevedra",
  "Ourense":                       "ourense",
  "Lugo":                          "lugo",
  "Santa Cruz de Tenerife":        "santa-cruz-de-tenerife",
  "Tenerife":                      "santa-cruz-de-tenerife",
  "Jaén":                          "jaen",
  "Ceuta":                         "ceuta",
  "Melilla":                       "melilla",
};

function provinceToCity(raw: string): string {
  const trimmed = raw.trim();
  return PROVINCE_TO_CITY[trimmed] ?? slugify(trimmed) ?? "";
}

// ─── CSV line splitter ────────────────────────────────────────────────────

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQ = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQ = true;
      } else if (c === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

// ─── Main export ──────────────────────────────────────────────────────────

export const riiDivBEsSource: ScraperSource = {
  name: "rii-div-b-es",
  enabled() {
    return process.env.PROLIO_RUN_RII_DIV_B_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runRiiDivBEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!riiDivBEsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const limit =
    Number(process.env.PROLIO_RII_DIV_B_ES_LIMIT ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;

  const sink = getSink();

  console.log(`[rii-div-b-es] fetching ${CSV_URL} (streaming, limit=${limit})`);

  let response: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    response = await fetch(CSV_URL, {
      headers: { "User-Agent": POLITE_UA },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.error(`[rii-div-b-es] network error: ${(err as Error).message}`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  if (!response.ok) {
    console.error(`[rii-div-b-es] HTTP ${response.status}`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  if (!response.body) {
    console.error("[rii-div-b-es] no response body");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  // Stream the CSV line-by-line to avoid loading 202 MB into memory.
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let header: string[] | null = null;
  let leftover = "";
  let totalRows = 0;
  let keptRows = 0;
  const BATCH_SIZE = 500;
  const batch: ScrapedProfessional[] = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const res = await sink.upsert(batch.splice(0));
    inserted += res.inserted;
    updated += res.updated;
    skipped += res.skipped;
  };

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = (leftover + chunk).split(/\r?\n/);
      leftover = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (!header) {
          // First line: strip BOM and parse header.
          header = splitCsvLine(line.replace(/^﻿/, "")).map((h) =>
            h.trim().toLowerCase()
          );
          continue;
        }

        totalRows++;
        if (keptRows >= limit) break outer;

        const cells = splitCsvLine(line);
        const row: Record<string, string> = {};
        for (let j = 0; j < header.length; j++) {
          row[header[j]] = (cells[j] ?? "").trim();
        }

        // Only keep ACTIVO records.
        const estado = (row["estado"] ?? "").toUpperCase();
        if (estado && estado !== "ACTIVO") continue;

        const hab = row["habilitación"] || row["habilitacion"] || "";
        const category = habilitacionToCategory(hab);
        if (!category) continue;

        const nombre = (row["titular"] ?? "").replace(/\s+/g, " ").trim();
        if (!nombre) continue;

        // Número Identificación is the RII registration number.
        const numId = row["número identificación"] || row["numero identificacion"] || row["identificación"] || row["identificacion"] || "";
        if (!numId) continue;

        const provincia = row["provincia"] ?? "";
        const municipioRaw = row["municipio - localidad"] ?? "";
        const municipio = municipioRaw.split("/")[0].trim(); // strip bilingual suffix
        const citySlug = municipio
          ? slugify(municipio) || provinceToCity(provincia)
          : provinceToCity(provincia);
        if (!citySlug) continue;

        const ccaa = row["ccaa"] || row["comunidad autónoma"] || row["comunidad autonoma"] || "";
        const nif = row["documento"] ?? "";

        keptRows++;
        batch.push(
          normalise({
            source: "rii-div-b-es",
            country: "ES",
            sourceId: `rii-b:${numId}`,
            name: nombre,
            categoryKey: category,
            citySlug,
            cif: nif.replace(/^NIF:/, ""),
            licenseNumber: numId,
            metadata: {
              registry: "rii-division-b",
              habilitacion: hab,
              provincia,
              ccaa,
            },
          })
        );

        if (batch.length >= BATCH_SIZE) {
          await flush();
        }
      }
    }

    // Drain leftover partial line (last line without newline).
    if (leftover.trim() && header && keptRows < limit) {
      const line = leftover.trim();
      const cells = splitCsvLine(line);
      const row: Record<string, string> = {};
      for (let j = 0; j < header.length; j++) {
        row[header[j]] = (cells[j] ?? "").trim();
      }
      const estado = (row["estado"] ?? "").toUpperCase();
      if (!estado || estado === "ACTIVO") {
        const hab = row["habilitación"] || row["habilitacion"] || "";
        const category = habilitacionToCategory(hab);
        if (category) {
          const nombre = (row["titular"] ?? "").replace(/\s+/g, " ").trim();
          const numId = row["número identificación"] || row["numero identificacion"] || "";
          const provincia = row["provincia"] ?? "";
          const municipioRaw = row["municipio - localidad"] ?? "";
          const municipio = municipioRaw.split("/")[0].trim();
          const citySlug = municipio
            ? slugify(municipio) || provinceToCity(provincia)
            : provinceToCity(provincia);
          if (nombre && numId && citySlug) {
            const nif = row["documento"] ?? "";
            const ccaa = row["ccaa"] || "";
            totalRows++;
            keptRows++;
            batch.push(
              normalise({
                source: "rii-div-b-es",
                country: "ES",
                sourceId: `rii-b:${numId}`,
                name: nombre,
                categoryKey: category,
                citySlug,
                cif: nif.replace(/^NIF:/, ""),
                licenseNumber: numId,
                metadata: {
                  registry: "rii-division-b",
                  habilitacion: hab,
                  provincia,
                  ccaa,
                },
              })
            );
          }
        }
      }
    }

    await flush();
  } finally {
    reader.cancel();
  }

  console.log(
    `[rii-div-b-es] scanned ${totalRows} rows, kept ${keptRows} ` +
    `(electricidad+hvac), inserted=${inserted} updated=${updated} skipped=${skipped}`
  );

  return { fetched: keptRows, inserted, updated, skipped };
}
