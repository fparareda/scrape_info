import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * OGE — Ordre des Géomètres-Experts. Tableau public de l'Ordre,
 * publié sur data.gouv.fr. ~1.9k géomètres-experts personnes physiques
 * en exercice en France.
 *
 *   Dataset: https://www.data.gouv.fr/datasets/tableau-de-lordre-des-geometres-experts-section-des-personnes-physiques
 *   License: Lov2
 *
 * Category: `arquitecto` is the closest Prolio category (architecture
 * + topographie are routinely commissioned together). Metadata flags
 * profession="geometre-expert" so consumers can disambiguate.
 *
 * Off by default. `PROLIO_RUN_GEOMETRES_FR=true` to enable.
 * Cap with `PROLIO_GEOMETRES_FR_LIMIT` (default 2000 — covers the
 * full tableau).
 */

const DATASET_API =
  "https://www.data.gouv.fr/api/1/datasets/tableau-de-lordre-des-geometres-experts-section-des-personnes-physiques/";
const DEFAULT_LIMIT = 2000;
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
    console.error(`[geometres-fr] metadata failed: ${(error as Error).message}`);
    return null;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const overrideUrl = process.env.PROLIO_GEOMETRES_FR_CSV;
  const url = overrideUrl || (await findLatestCsvUrl());
  if (!url) {
    console.error("[geometres-fr] no CSV URL available");
    return [];
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    console.error(`[geometres-fr] download failed: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[geometres-fr] ${response.status} on ${url}`);
    return [];
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;

    const lastName = row["nom"] || row["nom_de_naissance"] || row["nom_d_exercice"];
    const firstName = row["prenom"] || row["prenoms"] || row["prenom_d_exercice"];
    if (!lastName) continue;

    const cp =
      row["code_postal"] ||
      row["cp"] ||
      row["adresse_code_postal"] ||
      "";
    const citySlug = frPostalCodeToCitySlug(cp);
    if (!citySlug) continue;

    const matricule =
      row["numero_inscription"] ||
      row["num_inscription"] ||
      row["matricule"] ||
      row["numero"] ||
      `${slugify(lastName)}-${slugify(firstName ?? "")}-${cp}`;
    if (seen.has(matricule)) continue;
    seen.add(matricule);

    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    const street = row["adresse"] || row["voie"] || "";
    const city = row["commune"] || row["ville"] || "";
    const address = [street, cp, city].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "geometres-fr" as ScrapeSource,
        sourceId: `oge:${matricule}`,
        name,
        categoryKey: "arquitecto",
        citySlug,
        phone: row["telephone"] || undefined,
        email: row["email"] || undefined,
        address: address || undefined,
        licenseNumber: matricule,
        metadata: {
          country: "FR",
          authority: "OGE — Ordre des Géomètres-Experts",
          verified_by_authority: true,
          profession: "geometre-expert",
          conseil_regional: row["conseil_regional"],
          firm: row["raison_sociale"] || row["nom_cabinet"],
        },
      }),
    );
  }

  console.log(`[geometres-fr] parsed=${out.length}`);
  return out;
}

export const geometresFrSource: ScraperSource = {
  name: "geometres-fr" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_GEOMETRES_FR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runGeometresFr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!geometresFrSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_GEOMETRES_FR_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[geometres-fr] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
