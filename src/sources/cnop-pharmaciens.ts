import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * CNOP — Conseil National de l'Ordre des Pharmaciens. Two open
 * datasets cover this domain on data.gouv.fr:
 *
 *   1. "Les pharmacies" — ~21k officines (établissements pharmaceutiques)
 *      with name, address, license. Best for Prolio because it carries
 *      a physical address.
 *      Dataset: https://www.data.gouv.fr/datasets/les-pharmacies
 *   2. "Sites de vente en ligne" — ~2k e-pharmacies.
 *   3. Pharmacien individuels (~74k) live in the ANS extract covered
 *      by `annuaire-sante-ans` already; no point duplicating here.
 *
 * License: Lov2.
 *
 * Category: `medicina` (officine ≈ medical retail / pharmacie).
 *
 * Off by default. `PROLIO_RUN_CNOP_PHARMACIENS=true` to enable.
 * Cap with `PROLIO_CNOP_PHARMACIENS_LIMIT` (default 10000 covers full).
 */

const DATASET_API =
  "https://www.data.gouv.fr/api/1/datasets/les-pharmacies/";
const DEFAULT_LIMIT = 10000;
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
      `[cnop-pharmaciens] metadata failed: ${(error as Error).message}`,
    );
    return null;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const overrideUrl = process.env.PROLIO_CNOP_PHARMACIENS_CSV;
  const url = overrideUrl || (await findLatestCsvUrl());
  if (!url) {
    console.error("[cnop-pharmaciens] no CSV URL available");
    return [];
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    console.error(
      `[cnop-pharmaciens] download failed: ${(error as Error).message}`,
    );
    return [];
  }
  if (!response.ok) {
    console.error(`[cnop-pharmaciens] ${response.status} on ${url}`);
    return [];
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;

    const finess =
      row["finess"] ||
      row["numero_finess"] ||
      row["finess_geographique"] ||
      row["numero_pharmacie"] ||
      row["siret"];
    const name =
      row["raison_sociale"] ||
      row["nom"] ||
      row["denomination"] ||
      row["nom_pharmacie"] ||
      "";
    if (!finess || !name) continue;
    if (seen.has(finess)) continue;
    seen.add(finess);

    const cp = row["code_postal"] || row["cp"] || "";
    const citySlug = frPostalCodeToCitySlug(cp);
    if (!citySlug) continue;

    const street = row["adresse"] || row["voie"] || "";
    const city = row["commune"] || row["ville"] || "";
    const address = [street, cp, city].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "cnop-pharmaciens" as ScrapeSource,
        sourceId: `cnop:${finess}`,
        name,
        categoryKey: "medicina",
        citySlug,
        phone: row["telephone"] || undefined,
        email: row["email"] || undefined,
        website: row["site_internet"] || row["url"] || undefined,
        address: address || undefined,
        licenseNumber: finess,
        metadata: {
          country: "FR",
          authority: "CNOP — Ordre National des Pharmaciens (officines)",
          verified_by_authority: true,
          profession: "pharmacie-officine",
          finess,
          siret: row["siret"],
        },
      }),
    );
  }

  console.log(`[cnop-pharmaciens] parsed=${out.length}`);
  return out;
}

export const cnopPharmaciensSource: ScraperSource = {
  name: "cnop-pharmaciens" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CNOP_PHARMACIENS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCnopPharmaciens(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cnopPharmaciensSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_CNOP_PHARMACIENS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[cnop-pharmaciens] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
