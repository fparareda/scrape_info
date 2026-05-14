import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv } from "./_bulk-utils.js";

/**
 * RASIC — Registre d'Activitats i Serveis d'Inspecció de Catalunya:
 * "Tallers de reparació de vehicles" (talleres de mecánica y reparación
 * en Cataluña).
 *
 *   https://analisi.transparenciacatalunya.cat/d/ebyt-8dme
 *
 * El dataset está publicado en Socrata; el CSV directo es:
 *
 *   https://analisi.transparenciacatalunya.cat/resource/ebyt-8dme.csv
 *
 * Columnas (snake_case Socrata, con caracteres ASCII-normalizados):
 *   n_mero_de_rasic, nom_titular_actual, n_mero_d_identificaci_del_titular,
 *   adre_a, poblaci_, municipi, codi_municipi, codi_postal, comarca,
 *   codi_comarca, prov_ncia, email, web_de_l_establiment, carrosseria,
 *   electricitat, mec_nica, pintura, manipulacio_gas,
 *   especialitat_motos_i_ciclomotors, especialitat_reparaci_pneum_tics,
 *   especialitat_radiadors, especialitat_equips_d_injecci_.
 *
 * Off by default. `PROLIO_RUN_RASIC_TALLERES_CAT=true` to enable.
 * Cap with `PROLIO_RASIC_TALLERES_CAT_LIMIT` (default 5000; dataset has
 * algunos miles de filas).
 */

const DEFAULT_URL =
  process.env.PROLIO_RASIC_TALLERES_CAT_URL ||
  "https://analisi.transparenciacatalunya.cat/resource/ebyt-8dme.csv";
const DEFAULT_LIMIT = 5000;
const PAGE_SIZE = 1000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "mecanica";
const SOURCE_NAME = "rasic-talleres-cat" as ScrapeSource;

async function fetchPage(offset: number, pageSize: number): Promise<string> {
  const url = new URL(DEFAULT_URL);
  url.searchParams.set("$limit", String(pageSize));
  url.searchParams.set("$offset", String(offset));
  url.searchParams.set("$order", "n_mero_de_rasic");
  const response = await fetch(url, {
    headers: { "User-Agent": POLITE_UA, Accept: "text/csv" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`RASIC ${response.status} on ${url.pathname}`);
  }
  return response.text();
}

function pickService(row: Record<string, string>): string[] {
  const services: string[] = [];
  const flags: Array<[string, string]> = [
    ["carrosseria", "carrosseria"],
    ["electricitat", "electricitat"],
    ["mec_nica", "mecanica"],
    ["pintura", "pintura"],
    ["manipulacio_gas", "manipulacio_gas"],
    ["especialitat_motos_i_ciclomotors", "motos"],
    ["especialitat_reparaci_pneum_tics", "pneumatics"],
    ["especialitat_radiadors", "radiadors"],
    ["especialitat_equips_d_injecci_", "injeccio"],
  ];
  for (const [key, label] of flags) {
    const value = (row[key] ?? "").trim().toLowerCase();
    if (value === "sí" || value === "si" || value === "s" || value === "true") {
      services.push(label);
    }
  }
  return services;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 50; page += 1) {
    let csv: string;
    try {
      csv = await fetchPage(offset, PAGE_SIZE);
    } catch (error) {
      console.error(
        `[rasic-talleres-cat] page offset=${offset} failed: ${(error as Error).message}`,
      );
      break;
    }
    const rows = parseCsv(csv);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (out.length >= limit) break;
      const rasic = (row["n_mero_de_rasic"] ?? "").trim();
      const nombre = (row["nom_titular_actual"] ?? "").trim();
      if (!rasic || !nombre) continue;
      const sourceId = `rasic:${rasic}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const municipi = (row["municipi"] ?? row["poblaci_"] ?? "").trim();
      const provincia = (row["prov_ncia"] ?? "").trim();
      const cp = (row["codi_postal"] ?? "").trim();
      const adre = (row["adre_a"] ?? "").trim();
      const address = [adre, cp, municipi, provincia].filter(Boolean).join(", ") || undefined;
      const citySlug = municipi ? slugify(municipi) : provincia ? slugify(provincia) : "cataluna";

      out.push(
        normalise({
          source: SOURCE_NAME,
          sourceId,
          name: nombre,
          categoryKey: CATEGORY,
          citySlug,
          address,
          email: row["email"]?.trim() || undefined,
          website: row["web_de_l_establiment"]?.trim() || undefined,
          licenseNumber: rasic,
          cif: row["n_mero_d_identificaci_del_titular"]?.trim() || undefined,
          metadata: {
            country: "ES",
            authority: "Generalitat de Catalunya (RASIC)",
            verified_by_authority: true,
            comunidad: "Cataluña",
            provincia,
            municipio: municipi,
            comarca: row["comarca"]?.trim() || undefined,
            codi_municipi: row["codi_municipi"]?.trim() || undefined,
            codi_comarca: row["codi_comarca"]?.trim() || undefined,
            codigo_postal: cp,
            servicios: pickService(row),
          },
        }),
      );
    }
    if (out.length >= limit) break;
    if (rows.length < PAGE_SIZE) break;
    offset += rows.length;
  }
  console.log(`[rasic-talleres-cat] parsed=${out.length}`);
  return out;
}

export const rasicTalleresCatEnabled = (): boolean =>
  process.env.PROLIO_RUN_RASIC_TALLERES_CAT === "true";

export const rasicTalleresCatSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled: rasicTalleresCatEnabled,
  async fetch() {
    return [];
  },
};

export async function runRasicTalleresCat(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!rasicTalleresCatEnabled()) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("rasic-talleres-cat", async () => {
    const rawLimit = Number(
      process.env.PROLIO_RASIC_TALLERES_CAT_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
    const records = await fetchAll(limit);
    if (records.length === 0) {
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    }
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    return {
      rowsFetched: records.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
    };
  }).then((r) => ({
    fetched: r?.rowsFetched ?? 0,
    inserted: 0,
    updated: 0,
    skipped: r?.rowsSkipped ?? 0,
  }));
}
