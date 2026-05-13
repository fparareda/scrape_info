import type { CategoryKey } from "../prolio-types.js";
import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { splitCsvLine, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * FINESS — Fichier National des Établissements Sanitaires et Sociaux.
 * Official directory of every French healthcare establishment (hôpital,
 * clinique, centre médical, EHPAD, cabinet médical, laboratoire,
 * pharmacie d'officine, …). Maintained by DREES, published monthly on
 * data.gouv.fr as a pipe-delimited CSV. ~150k établissements.
 *
 *   Dataset: https://www.data.gouv.fr/datasets/finess-extraction-du-fichier-des-etablissements
 *   License: Lov2 (commercial reuse OK)
 *
 * Category mapping by `categagretab` (catégorie agrégée) + `categetab`
 * (catégorie d'établissement). FINESS is establishment-level (not
 * pro-level) so most rows map to medicina via a catch-all; we surface
 * the subset most useful to Prolio:
 *
 *   medicina    — Hôpital / Centre de santé / Cabinet médical
 *   dentista    — Cabinet dentaire / Centre de soins dentaires
 *   fisioterapia — Cabinet de masseur-kinésithérapeute
 *
 * Off by default. `PROLIO_RUN_FINESS=true` to enable.
 * Cap with `PROLIO_FINESS_LIMIT` (default 5000).
 */

const DATASET_API =
  "https://www.data.gouv.fr/api/1/datasets/finess-extraction-du-fichier-des-etablissements/";
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

function categoryFromLibelle(libelle: string): CategoryKey | undefined {
  const t = libelle.toLowerCase();
  if (t.includes("dentaire") || t.includes("dentiste")) return "dentista";
  if (t.includes("kinésithéra") || t.includes("kinesithera"))
    return "fisioterapia";
  if (
    t.includes("hôpital") ||
    t.includes("hopital") ||
    t.includes("clinique") ||
    t.includes("centre de santé") ||
    t.includes("centre medical") ||
    t.includes("cabinet médical") ||
    t.includes("cabinet medical") ||
    t.includes("médical") ||
    t.includes("medical") ||
    t.includes("polyclinique")
  )
    return "medicina";
  return undefined;
}

async function findLatestEtablissementCsvUrl(): Promise<string | null> {
  try {
    const response = await fetch(DATASET_API, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const meta = (await response.json()) as DatasetMeta;
    // FINESS publishes two files in the dataset: "etalab-cs1100507-stock-...-Etablissements.csv"
    // and "etalab-cs1100507-stock-...-Geolocalisation.csv". We want the
    // Etablissements one (carries names, addresses, categories).
    const target = (meta.resources ?? []).find((r) =>
      /etablissements?/i.test(r.title ?? r.url ?? ""),
    );
    return target?.url ?? null;
  } catch (error) {
    console.error(
      `[finess] metadata failed: ${(error as Error).message}`,
    );
    return null;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const overrideUrl = process.env.PROLIO_FINESS_CSV;
  const url = overrideUrl || (await findLatestEtablissementCsvUrl());
  if (!url) {
    console.error("[finess] no CSV URL available");
    return [];
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    console.error(`[finess] download failed: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[finess] ${response.status} on ${url}`);
    return [];
  }
  const text = await response.text();
  // FINESS uses ';' separator and starts with a "structureet;" header
  // (no quotes). The file has a 1-line preamble before the header row
  // on some snapshots — we accept the first line containing 'finess' as
  // the actual header.
  const lines = text.split(/\r?\n/);
  let headerIdx = lines.findIndex((l) => /nofinesset|categagretab/i.test(l));
  if (headerIdx < 0) headerIdx = 0;
  const header = splitCsvLine(lines[headerIdx], ";").map((h) =>
    h
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, ""),
  );

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (out.length >= limit) break;
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = splitCsvLine(line, ";");
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = (cells[j] ?? "").trim();
    }

    const libelle =
      row["libcategagretab"] ||
      row["libcategetab"] ||
      row["categagretab"] ||
      "";
    const category = categoryFromLibelle(libelle);
    if (!category) continue;

    const finess = row["nofinesset"] || row["nofinessej"] || row["nofinesset_geo"];
    if (!finess || seen.has(finess)) continue;
    seen.add(finess);

    const cp = row["codepostal"] || "";
    const citySlug = frPostalCodeToCitySlug(cp);
    if (!citySlug) continue;

    const name = row["rs"] || row["rslongue"] || row["raisonsociale"] || "";
    if (!name) continue;

    const street = [row["numvoie"], row["typvoie"], row["voie"]]
      .filter(Boolean)
      .join(" ");
    const city = row["libcommune"] || row["commune"] || "";
    const address = [street, cp, city].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "finess" as ScrapeSource,
        sourceId: `finess:${finess}`,
        name,
        categoryKey: category,
        citySlug,
        phone: row["telephone"] || undefined,
        address: address || undefined,
        licenseNumber: finess,
        metadata: {
          country: "FR",
          authority: "DREES — FINESS",
          verified_by_authority: true,
          finess,
          finess_juridique: row["nofinessej"] || undefined,
          categorie: libelle,
        },
      }),
    );
  }

  console.log(`[finess] parsed=${out.length}`);
  return out;
}

export const finessSource: ScraperSource = {
  name: "finess" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_FINESS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runFiness(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!finessSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_FINESS_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[finess] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
