import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * CNB — Conseil National des Barreaux. National lawyer registry of
 * France, published as an open dataset on data.gouv.fr under
 * Licence Ouverte 2.0 (Lov2 — commercial reuse permitted).
 *
 * Discovery 2026-05-07 via Chrome MCP after pre-flight failures
 * against www.cnb.avocats.fr (DNS NXDOMAIN — that subdomain doesn't
 * exist; the real CNB is `cnb.avocat.fr`). The data.gouv path is the
 * authoritative bulk feed and bypasses any HTML scraping fragility.
 *
 * Strategy:
 *   1. Hit dataset metadata API to get the latest CSV resource URL
 *      (URL changes monthly; ID-based redirect is stable).
 *   2. Download CSV (~9.5 MB, ~70k lawyers).
 *   3. Map to category=extranjeria (only lawyer category in Prolio).
 *
 * Off by default. `PROLIO_RUN_CNB_AVOCATS=true` to enable. Cap with
 * `PROLIO_CNB_AVOCATS_LIMIT` (default 5000 to stay well under the
 * full 70k for the first run; bump as needed).
 */

const DATASET_API =
  "https://www.data.gouv.fr/api/1/datasets/annuaire-des-avocats-de-france/";
const DEFAULT_LIMIT = 5000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

interface DatasetResource {
  title?: string;
  format?: string;
  url?: string;
  latest?: string;
  filesize?: number;
  created_at?: string;
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
    if (!response.ok) {
      console.error(`[cnb-avocats] dataset metadata ${response.status}`);
      return null;
    }
    const meta = (await response.json()) as DatasetMeta;
    const csv = (meta.resources ?? []).find(
      (r) => r.format?.toLowerCase() === "csv",
    );
    return csv?.url ?? csv?.latest ?? null;
  } catch (error) {
    console.error(
      `[cnb-avocats] dataset metadata failed: ${(error as Error).message}`,
    );
    return null;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const overrideUrl = process.env.PROLIO_CNB_AVOCATS_CSV;
  const url = overrideUrl || (await findLatestCsvUrl());
  if (!url) {
    console.error("[cnb-avocats] no CSV URL available");
    return [];
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    console.error(`[cnb-avocats] download failed: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[cnb-avocats] ${response.status} on ${url}`);
    return [];
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    // Real columns observed in the 20260420 snapshot (semicolon-
    // separated, lowercased by parseCsv):
    //   nombarreau (e.g., "AGEN" — barreau city, NOT a generic "nom")
    //   avnom         last name
    //   avprenom      first name
    //   cbraisonsociale  firm name
    //   cbsiretsiren  SIREN/SIRET — use as licenseNumber (autonomos
    //                 have a SIREN, sociétés have SIRET)
    //   cbadresse1, cbadresse2
    //   cbcp          postal code
    //   cbville       city
    //   splibelle1..4 specialties (extranjeria filtering candidate)
    //   acdateserment date of oath
    //
    // Earlier version used substring matching against generic words
    // like "nom" / "ville" — but that hit "nombarreau" first (Object
    // key insertion order) and grabbed the wrong column. Bind to
    // exact lowercased headers now.
    const matricule = row["cbsiretsiren"] || row["cbsiret"] || row["cbsiren"];
    const lastName = row["avnom"];
    const firstName = row["avprenom"];
    if (!matricule || !lastName) continue;

    const city = row["cbville"];
    const cp = row["cbcp"];
    // Bucket by postal-code department to a seeded FR metro instead
    // of slugifying the literal commune. Earlier version mapped
    // ~35% (1,742 / 5,000) — most FR communes aren't in our metro
    // seed. Department bucketing pulls the dropped 65% into nearby
    // metros so they land in the FK-bound cities table.
    const citySlug = frPostalCodeToCitySlug(cp);
    if (!citySlug) continue;

    if (seen.has(matricule)) continue;
    seen.add(matricule);

    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    if (!name) continue;

    const street = [row["cbadresse1"], row["cbadresse2"]].filter(Boolean).join(" ");
    const address = [street, cp, city].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "cnb-avocats",
        sourceId: `cnb-avocats:${matricule}`,
        name,
        categoryKey: "extranjeria",
        citySlug,
        address: address || undefined,
        licenseNumber: matricule,
        metadata: {
          country: "FR",
          authority: "CNB (Conseil National des Barreaux)",
          verified_by_authority: true,
          barreau: row["nombarreau"],
          firm: row["cbraisonsociale"],
          specialty1: row["splibelle1"],
          specialty2: row["splibelle2"],
          oath_date: row["acdateserment"],
        },
      }),
    );
  }

  console.log(`[cnb-avocats] parsed=${out.length}`);
  return out;
}

export const cnbAvocatsSource: ScraperSource = {
  name: "cnb-avocats",
  enabled() {
    return process.env.PROLIO_RUN_CNB_AVOCATS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCnbAvocats(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cnbAvocatsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_CNB_AVOCATS_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[cnb-avocats] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
