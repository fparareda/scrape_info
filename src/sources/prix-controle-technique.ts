import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * Prix Contrôle Technique — annuaire officiel des centres de contrôle
 * technique automobile. Published by the Ministère de l'Économie on
 * data.economie.gouv.fr (OpenDataSoft API). ~6.5k centres agréés.
 *
 *   Dataset: https://data.economie.gouv.fr/explore/dataset/annuaire-centres-controle-technique/
 *   API:     https://data.economie.gouv.fr/api/records/1.0/search/?dataset=annuaire-centres-controle-technique
 *   License: Lov2
 *
 * Category: itv (inspección técnica de vehículos — direct match to
 * French contrôle technique).
 *
 * Off by default. `PROLIO_RUN_PRIX_CONTROLE_TECHNIQUE=true` to enable.
 * Cap with `PROLIO_PRIX_CONTROLE_TECHNIQUE_LIMIT` (default 7000 to
 * cover the full annuaire in one run).
 */

const API_URL =
  "https://data.economie.gouv.fr/api/records/1.0/search/?dataset=annuaire-centres-controle-technique";
const DEFAULT_LIMIT = 7000;
const PAGE_SIZE = 1000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

interface OdsRecord {
  recordid?: string;
  fields?: {
    cct_siret?: string;
    cct_denomination?: string;
    cct_adresse?: string;
    cct_code_postal?: string;
    cct_commune?: string;
    cct_tel?: string;
    cct_url?: string;
    code_departement?: string;
    nom_region?: string;
    [k: string]: unknown;
  };
}
interface OdsResponse {
  nhits?: number;
  records?: OdsRecord[];
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let start = 0;

  while (out.length < limit) {
    const url = `${API_URL}&rows=${PAGE_SIZE}&start=${start}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      console.error(
        `[prix-controle-technique] fetch failed: ${(error as Error).message}`,
      );
      break;
    }
    if (!response.ok) {
      console.error(`[prix-controle-technique] ${response.status} on ${url}`);
      break;
    }
    const json = (await response.json()) as OdsResponse;
    const records = json.records ?? [];
    if (records.length === 0) break;

    for (const rec of records) {
      if (out.length >= limit) break;
      const f = rec.fields ?? {};
      // OpenDataSoft v1: the real columns of this dataset are prefixed
      // `cct_` (centre de contrôle technique). Anchor on SIRET first,
      // fall back to recordid (a deterministic OpenDataSoft hash).
      const id =
        (f.cct_siret as string) || rec.recordid || "";
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const cp = ((f.cct_code_postal as string) || "").trim();
      const citySlug = frPostalCodeToCitySlug(cp);
      if (!citySlug) continue;

      const name = ((f.cct_denomination as string) || "").trim();
      if (!name) continue;

      // `cct_commune` is a slash-joined repetition (one per vehicle
      // category) — keep the first entry only.
      const rawCity = (f.cct_commune as string) || "";
      const city = rawCity.split("/")[0]?.trim() || "";
      const address = [
        (f.cct_adresse as string) || "",
        cp,
        city,
      ]
        .filter(Boolean)
        .join(", ");

      out.push(
        normalise({
          source: "prix-controle-technique" as ScrapeSource,
          country: "FR",
          sourceId: `prix-ct:${id}`,
          name,
          categoryKey: "itv",
          citySlug,
          phone: (f.cct_tel as string) || undefined,
          website: (f.cct_url as string) || undefined,
          address: address || undefined,
          licenseNumber: (f.cct_siret as string) || id,
          metadata: {
            country: "FR",
            authority:
              "Ministère de l'Économie — Annuaire des centres de contrôle technique",
            verified_by_authority: true,
            siret: f.cct_siret,
            code_departement: f.code_departement,
            region: f.nom_region,
          },
        }),
      );
    }

    start += PAGE_SIZE;
    if (records.length < PAGE_SIZE) break;
  }

  console.log(`[prix-controle-technique] parsed=${out.length}`);
  return out;
}

export const prixControleTechniqueSource: ScraperSource = {
  name: "prix-controle-technique" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_PRIX_CONTROLE_TECHNIQUE === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runPrixControleTechnique(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!prixControleTechniqueSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_PRIX_CONTROLE_TECHNIQUE_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[prix-controle-technique] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
