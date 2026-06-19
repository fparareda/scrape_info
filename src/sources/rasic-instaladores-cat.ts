import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { ensureCity } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * RASIC Cataluña — Instal·ladors industrials
 * (Registre d'Activitats i Serveis d'Inspecció de Catalunya)
 *
 *   https://analisi.transparenciacatalunya.cat/d/qcrr-stew
 *
 * Public registry of industrial installation, maintenance, repair and
 * operation companies authorised to operate in Cataluña under RASIC
 * (Decret 141/2012). Published by the Generalitat de Catalunya via
 * Socrata; the JSON API is open, no auth, Crawl-delay: 1 s.
 *
 *   https://analisi.transparenciacatalunya.cat/resource/qcrr-stew.json
 *
 * Key columns (Socrata names):
 *   n_mero_de_rasic, titular, document, adreca_agrupada, codi_postal,
 *   municipi, telefon_mobil, bt_installacions, gas,
 *   ite_installacions_term, pci_sist_deteccio_alarma
 *
 * Category mapping (service flag → CategoryKey):
 *   bt_installacions = Sí  → electricidad   (~13,144 records)
 *   gas = Sí               → fontaneria      (~8,157 records)
 *   ite_installacions_term = Sí → hvac       (~9,898 records)
 *   pci_sist_deteccio_alarma = Sí → cerrajero (~800 records — alarm
 *     system installers; first dedicated ES government-backed cerrajero
 *     source, well above the 500-record minimum)
 *
 * One company can match multiple categories. A ScrapedProfessional is
 * emitted once per matching category with a category-scoped sourceId:
 *   `rasic:qcrr:{rasic_num}:{category}`
 *
 * Dataset size: ~19,235 active records. Default limit: 25,000.
 * Page size: 1,000 rows. Polite delay: 1,000 ms between pages.
 *
 * Off by default; enable with `PROLIO_RUN_RASIC_INSTALADORES_CAT=true`.
 * Cap with `PROLIO_RASIC_INSTALADORES_CAT_LIMIT` (default 25,000).
 */

const DEFAULT_URL =
  process.env.PROLIO_RASIC_INSTALADORES_CAT_URL ||
  "https://analisi.transparenciacatalunya.cat/resource/qcrr-stew.json";
const DEFAULT_LIMIT = 25_000;
const PAGE_SIZE = 1_000;
const POLITE_DELAY_MS = 1_000;
const POLITE_UA =
  "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const SOURCE_NAME = "rasic-instaladores-cat" as ScrapeSource;

// Service-flag column → CategoryKey mapping (order determines insertion
// priority when a single company maps to multiple categories).
const FLAG_MAP: Array<{ col: string; category: CategoryKey }> = [
  { col: "bt_installacions",        category: "electricidad" },
  { col: "gas",                     category: "fontaneria"   },
  { col: "ite_installacions_term",  category: "hvac"         },
  { col: "pci_sist_deteccio_alarma", category: "cerrajero"   },
];

function isYes(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "sí" || v === "si" || v === "s" || v === "true" || v === "1";
}

async function fetchPage(offset: number): Promise<Record<string, string>[]> {
  const url = new URL(DEFAULT_URL);
  url.searchParams.set("$limit", String(PAGE_SIZE));
  url.searchParams.set("$offset", String(offset));
  url.searchParams.set("$order", "n_mero_de_rasic");
  const response = await fetch(url.toString(), {
    headers: { "User-Agent": POLITE_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(
      `rasic-instaladores-cat: HTTP ${response.status} at offset=${offset}`,
    );
  }
  return (await response.json()) as Record<string, string>[];
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const client = getSupabaseClient();
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for (let page = 0; page < 50; page += 1) {
    let rows: Record<string, string>[];
    try {
      rows = await fetchPage(offset);
    } catch (error) {
      console.error(
        `[rasic-instaladores-cat] page offset=${offset} failed: ${(error as Error).message}`,
      );
      break;
    }
    if (rows.length === 0) break;

    for (const row of rows) {
      if (out.length >= limit) break;

      const rasic = (row["n_mero_de_rasic"] ?? "").trim();
      const nombre = (row["titular"] ?? "").trim();
      if (!rasic || !nombre) continue;

      const municipi = (row["municipi"] ?? "").trim();
      const cp = (row["codi_postal"] ?? "").trim();
      const adresa = (row["adreca_agrupada"] ?? "").trim();
      const phone = (row["telefon_mobil"] ?? "").trim() || undefined;
      const document = (row["document"] ?? "").trim() || undefined;
      const address =
        [adresa, cp, municipi].filter(Boolean).join(", ") || undefined;
      // Auto-seed the city by NAME so the row is not dropped at the sink.
      // When there is no municipi, emit citySlug="" (sink writes
      // city_slug=NULL and KEEPS the row). Do NOT fabricate slugs like
      // "cp-{cp}" or "cataluna" — they are not in `cities` and dropped.
      let citySlug = "";
      if (municipi) {
        const cityResult = await ensureCity(client, {
          name: municipi,
          state: "Cataluña",
          country: "ES",
        });
        if (cityResult) citySlug = cityResult.slug;
      }

      for (const { col, category } of FLAG_MAP) {
        if (!isYes(row[col])) continue;
        const sourceId = `rasic:qcrr:${rasic}:${category}`;
        if (seen.has(sourceId)) continue;
        seen.add(sourceId);

        out.push(
          normalise({
            source: SOURCE_NAME,
            country: "ES",
            sourceId,
            name: nombre,
            categoryKey: category,
            citySlug,
            address,
            phone,
            cif: document,
            licenseNumber: rasic,
            metadata: {
              country: "ES",
              authority: "Generalitat de Catalunya (RASIC)",
              verified_by_authority: true,
              comunidad: "Cataluña",
              municipio: municipi || undefined,
              codigo_postal: cp || undefined,
              rasic_flag: col,
            },
          }),
        );

        if (out.length >= limit) break;
      }
    }

    if (out.length >= limit) break;
    if (rows.length < PAGE_SIZE) break;
    offset += rows.length;

    // Respect Crawl-delay: 1
    await new Promise<void>((resolve) => setTimeout(resolve, POLITE_DELAY_MS));
  }

  console.log(`[rasic-instaladores-cat] parsed=${out.length}`);
  return out;
}

export const rasicInstaladorsCatEnabled = (): boolean =>
  process.env.PROLIO_RUN_RASIC_INSTALADORES_CAT === "true";

export const rasicInstaladorsCatSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled: rasicInstaladorsCatEnabled,
  async fetch() {
    return [];
  },
};

export async function runRasicInstaladorsCat(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!rasicInstaladorsCatEnabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return withScrapeRun("rasic-instaladores-cat", async () => {
    const rawLimit = Number(
      process.env.PROLIO_RASIC_INSTALADORES_CAT_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
    const records = await fetchAll(limit);
    if (records.length === 0) {
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    }
    const sink = getSink({ trustCitySlugs: true });
    const { inserted, updated, skipped } = await sink.upsert(records);
    console.log(
      `[rasic-instaladores-cat] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
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
