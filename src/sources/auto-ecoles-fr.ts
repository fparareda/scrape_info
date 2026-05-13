import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * Auto-écoles — liste officielle des auto-écoles agréées et taux de
 * réussite au permis. Publié par le Ministère de l'Intérieur sur
 * data.gouv.fr (trimestriel). ~13k auto-écoles.
 *
 *   Dataset: https://www.data.gouv.fr/datasets/liste-des-auto-ecoles-et-taux-de-reussite-au-permis-de-conduire
 *   License: Lov2
 *
 * Category: `mecanica` is the closest proxy in Prolio (no dedicated
 * driving-school category). Surface in metadata.profession="auto-ecole"
 * so the UI can label appropriately.
 *
 * Off by default. `PROLIO_RUN_AUTO_ECOLES_FR=true` to enable.
 * Cap with `PROLIO_AUTO_ECOLES_FR_LIMIT` (default 5000).
 */

const DATASET_API =
  "https://www.data.gouv.fr/api/1/datasets/liste-des-auto-ecoles-et-taux-de-reussite-au-permis-de-conduire/";
const DEFAULT_LIMIT = 5000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

interface DatasetResource {
  title?: string;
  format?: string;
  url?: string;
}
interface DatasetMeta {
  resources?: DatasetResource[];
}

async function findLatestCsvUrl(): Promise<string | null> {
  try {
    const response = await fetch(DATASET_API, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const meta = (await response.json()) as DatasetMeta;
    const csv = (meta.resources ?? []).find(
      (r) => r.format?.toLowerCase() === "csv",
    );
    return csv?.url ?? null;
  } catch (error) {
    console.error(
      `[auto-ecoles-fr] metadata failed: ${(error as Error).message}`,
    );
    return null;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const overrideUrl = process.env.PROLIO_AUTO_ECOLES_FR_CSV;
  const url = overrideUrl || (await findLatestCsvUrl());
  if (!url) {
    console.error("[auto-ecoles-fr] no CSV URL available");
    return [];
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    console.error(`[auto-ecoles-fr] download failed: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[auto-ecoles-fr] ${response.status} on ${url}`);
    return [];
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;

    // The Securité Routière CSV uses `raf_numero` (numéro d'agrément
    // RAF) as the identifier and prefixes establishment fields with
    // `aue_` (auto-école unité).
    const agrement =
      row["raf_numero"] ||
      row["num_agrement"] ||
      row["numero_agrement"] ||
      "";
    const name =
      row["aue_raisonsociale"] ||
      row["raison_sociale"] ||
      row["denomination"] ||
      "";
    if (!agrement || !name || seen.has(agrement)) continue;

    const cp =
      row["aue_codepostal"] ||
      row["code_postal"] ||
      row["cp"] ||
      "";
    const citySlug = frPostalCodeToCitySlug(cp);
    if (!citySlug) continue;

    seen.add(agrement);

    const street = row["aue_adresse"] || row["adresse"] || "";
    const city = row["aue_commune"] || row["commune"] || "";
    const address = [street, cp, city].filter(Boolean).join(", ");
    // Headline metric: 1st-time pass rate for catégorie B (voiture).
    const taux = row["b_taux_1pra"] || row["taux_reussite"] || undefined;
    const website = row["aue_siteinternet"] || undefined;

    out.push(
      normalise({
        source: "auto-ecoles-fr" as ScrapeSource,
        sourceId: `auto-ecole-fr:${agrement}`,
        name,
        categoryKey: "mecanica",
        citySlug,
        phone: row["telephone"] || undefined,
        website,
        address: address || undefined,
        licenseNumber: agrement,
        metadata: {
          country: "FR",
          authority: "Ministère de l'Intérieur — Auto-écoles agréées",
          verified_by_authority: true,
          profession: "auto-ecole",
          agrement,
          taux_reussite_b_1ere: taux,
          departement: row["dpt_id"] || undefined,
        },
      }),
    );
  }

  console.log(`[auto-ecoles-fr] parsed=${out.length}`);
  return out;
}

export const autoEcolesFrSource: ScraperSource = {
  name: "auto-ecoles-fr" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_AUTO_ECOLES_FR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runAutoEcolesFr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!autoEcolesFrSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_AUTO_ECOLES_FR_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[auto-ecoles-fr] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
