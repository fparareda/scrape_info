import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, pick } from "./_bulk-utils.js";

/**
 * Open Data Ajuntament de Barcelona — Cens de locals en planta baixa
 * destinats a activitat econòmica.
 *
 *   https://opendata-ajuntament.barcelona.cat/data/es/dataset/cens-locals-planta-baixa-act-economica
 *
 * Dataset CKAN (Creative Commons 4.0, sin token). El paquete expone un
 * CSV anual; usamos el más reciente publicado a la fecha
 * (2024). Estructura ~70k filas con coordenadas, dirección,
 * sector/grupo/tipo de actividad y código de actividad económica.
 *
 * Mapeamos un subconjunto pequeño de tipos de actividad a categorías
 * Prolio. Los registros que no caen en una categoría conocida se
 * descartan en silencio (la mayoría son comercio minorista que no
 * pertenece al catálogo prolio).
 *
 * Off por defecto: `PROLIO_RUN_OPEN_DATA_BCN_LOCALES=true`.
 * Cap: `PROLIO_OPEN_DATA_BCN_LOCALES_LIMIT` (default 100.000).
 */

const CSV_URL =
  process.env.PROLIO_OPEN_DATA_BCN_LOCALES_CSV ||
  "https://opendata-ajuntament.barcelona.cat/data/dataset/fe177673-0f83-42e7-b35a-ddea901be8bc/resource/38babeec-5c47-43d3-84e7-b13a4b89004f/download/241021_censcomercialbcn_opendata_2024_v5.csv";
const DEFAULT_LIMIT = 100_000;
const SOURCE_NAME = "open-data-bcn-locales" as ScrapeSource;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";

/**
 * El CSV trae un campo `Nom_Activitat` / `Nom_Sector_Activitat` con
 * categorías humanas (no CNAE puro, sino una taxonomía propia del
 * Ajuntament). Mapeamos las que tienen contrapartida en prolio.
 *
 * Las claves se comparan en minúsculas y sin acentos, con `includes`,
 * para tolerar variantes de capitalización entre años del dataset.
 */
const ACTIVITY_KEYWORD_TO_CATEGORY: Array<{
  keywords: string[];
  category: CategoryKey;
}> = [
  // Salud / clínicas
  { keywords: ["farmacia", "farmacies"], category: "medicina" },
  { keywords: ["centres mediques", "centre medic", "consultori medic"], category: "medicina" },
  { keywords: ["dentista", "odontolog", "clinica dental"], category: "dentista" },
  { keywords: ["fisioterap"], category: "fisioterapia" },
  { keywords: ["psicolog"], category: "psicologia" },
  { keywords: ["veterinari"], category: "veterinario" },
  // Servicios profesionales
  { keywords: ["notari"], category: "notario" },
  { keywords: ["assessoria fiscal", "gestoria", "comptable"], category: "fiscal" },
  { keywords: ["arquitect"], category: "arquitecto" },
  { keywords: ["enginyer"], category: "ingenieria" },
  // Talleres / hogar
  { keywords: ["taller mecanic", "reparacio automob", "tallers automob"], category: "mecanica" },
  { keywords: ["itv", "inspeccio tecnica de vehicles"], category: "itv" },
  { keywords: ["electricitat", "electrician"], category: "electricidad" },
  { keywords: ["fontaner"], category: "fontaneria" },
  { keywords: ["clima", "calefacc"], category: "hvac" },
  { keywords: ["fuster"], category: "carpinteria" },
  { keywords: ["serraller", "manyer"], category: "cerrajero" },
];

function normaliseForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function classify(row: Record<string, string>): CategoryKey | undefined {
  const candidates = [
    pick(row, ["nom_activitat", "activitat", "nom_activitat_loc"]),
    pick(row, ["nom_sector_activitat", "sector_activitat"]),
    pick(row, ["nom_grup_activitat", "grup_activitat"]),
    pick(row, ["nom_tipus_activitat", "tipus_activitat"]),
  ]
    .filter(Boolean)
    .map(normaliseForMatch)
    .join(" | ");
  if (!candidates) return undefined;
  for (const { keywords, category } of ACTIVITY_KEYWORD_TO_CATEGORY) {
    for (const kw of keywords) {
      if (candidates.includes(kw)) return category;
    }
  }
  return undefined;
}

function buildName(row: Record<string, string>): string | undefined {
  const explicit = pick(row, [
    "nom_local",
    "nom_comercial",
    "nom_empresa",
    "denominacio",
    "nom",
  ]);
  if (explicit) return explicit;
  // Fallback: derive a synthetic name from activity + street (some rows
  // are anonymous "local en planta baixa" without trade name).
  const activity = pick(row, ["nom_activitat", "activitat"]);
  const street = pick(row, ["nom_carrer", "carrer"]);
  const number = pick(row, ["num_carrer", "numero"]);
  if (activity && street) {
    return `${activity} — ${street}${number ? ` ${number}` : ""}`;
  }
  return undefined;
}

function buildAddress(row: Record<string, string>): string | undefined {
  const street = pick(row, ["nom_carrer", "carrer"]);
  const number = pick(row, ["num_carrer", "numero"]);
  const distrito = pick(row, ["nom_districte", "districte"]);
  const barrio = pick(row, ["nom_barri", "barri"]);
  const parts = [
    [street, number].filter(Boolean).join(" "),
    barrio,
    distrito,
    "Barcelona",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function parseLatLng(row: Record<string, string>): { lat?: number; lng?: number } {
  const lat = Number(pick(row, ["latitud", "lat", "y_coord"]));
  const lng = Number(pick(row, ["longitud", "lon", "lng", "x_coord"]));
  return {
    lat: Number.isFinite(lat) && lat !== 0 ? lat : undefined,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : undefined,
  };
}

async function downloadCsv(): Promise<string> {
  const response = await fetch(CSV_URL, {
    headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*;q=0.5" },
    signal: AbortSignal.timeout(180_000),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`open-data-bcn-locales CSV ${response.status} on ${CSV_URL}`);
  }
  return await response.text();
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const csv = await downloadCsv();
  const rows = parseCsv(csv);
  console.log(`[open-data-bcn-locales] parsed rows=${rows.length}`);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let mapped = 0;
  let skippedNoCategory = 0;
  for (const row of rows) {
    if (out.length >= limit) break;
    const category = classify(row);
    if (!category) {
      skippedNoCategory += 1;
      continue;
    }
    const id = pick(row, ["id_local", "id_principal_activitat", "id"]);
    if (!id) continue;
    const sourceId = `open-data-bcn-locales:${id}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const name = buildName(row);
    if (!name) continue;
    const { lat, lng } = parseLatLng(row);
    out.push(
      normalise({
        source: SOURCE_NAME,
        sourceId,
        name,
        categoryKey: category,
        citySlug: "barcelona",
        address: buildAddress(row),
        lat,
        lng,
        metadata: {
          country: "ES",
          authority: "Ajuntament de Barcelona",
          source_dataset: "cens-locals-planta-baixa-act-economica",
          activitat: pick(row, ["nom_activitat", "activitat"]) || undefined,
          sector: pick(row, ["nom_sector_activitat", "sector_activitat"]) || undefined,
          grup: pick(row, ["nom_grup_activitat", "grup_activitat"]) || undefined,
          tipus: pick(row, ["nom_tipus_activitat", "tipus_activitat"]) || undefined,
          districte: pick(row, ["nom_districte", "districte"]) || undefined,
          barri: pick(row, ["nom_barri", "barri"]) || undefined,
        },
      }),
    );
    mapped += 1;
  }
  console.log(
    `[open-data-bcn-locales] mapped=${mapped} skipped_no_category=${skippedNoCategory}`,
  );
  return out;
}

export const openDataBcnLocalesSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_OPEN_DATA_BCN_LOCALES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOpenDataBcnLocales(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!openDataBcnLocalesSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_OPEN_DATA_BCN_LOCALES_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    console.log("[open-data-bcn-locales] no records fetched");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[open-data-bcn-locales] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
