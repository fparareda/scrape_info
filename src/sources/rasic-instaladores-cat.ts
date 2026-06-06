import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";

/**
 * Catalonia RASIC — Empreses d'instal·lació, manteniment, reparació i
 * operació d'instal·lacions i productes industrials.
 *
 * Dataset `qcrr-stew` on analisi.transparenciacatalunya.cat — distinct from
 * the existing `rasic-talleres-cat` source which covers vehicle repair
 * workshops (`ebyt-8dme`). This dataset covers licensed industrial
 * installation/maintenance companies (electricians, HVAC, gas, fire
 * protection, etc.) registered in Catalonia's 4 provinces.
 *
 *   https://analisi.transparenciacatalunya.cat/Economia/Empreses-d-instal-laci-manteniment-reparaci-i-oper/qcrr-stew
 *
 * Pre-flight (2026-06-06):
 *   - robots.txt: ALLOWED — analisi.transparenciacatalunya.cat disallows only
 *     /OData.svc/, /api/odata/, /api/collocate*. The /resource/ path is open.
 *   - Technology: Socrata SoQL JSON API. No auth, no Cloudflare, no captcha.
 *   - Record count: 19,235 active registrations (estat_registre='Alta').
 *   - Licence: CC-BY (Catalan Government transparency data).
 *
 * Key columns:
 *   titular              — company/person name
 *   adreca_agrupada      — full street address
 *   municipi             — municipality (city)
 *   prov_ncia            — province (Barcelona/Girona/Lleida/Tarragona)
 *   telefon_mobil        — mobile phone
 *   n_mero_de_rasic      — RASIC registration/licence number
 *   estat_registre       — Alta (active) / Baixa (inactive)
 *   bt_installacions     — low-voltage electricity (Sí/No)
 *   ite_installacions_term — thermal/HVAC (Sí/No)
 *   fred_industrial      — industrial refrigeration (Sí/No)
 *   gas                  — gas installations (Sí/No)
 *
 * CategoryKey pick (first match wins per record):
 *   bt_installacions     → electricidad
 *   ite_installacions_term / fred_industrial → hvac
 *   gas                  → fontaneria
 *   default              → electricidad
 *
 * Off by default. Enable via `PROLIO_RUN_RASIC_INSTALADORES_CAT=true`.
 * Cap via `PROLIO_RASIC_INSTALADORES_CAT_LIMIT` (default 20000).
 * Monthly cadence (RASIC rolls update monthly).
 */

const SOCRATA_HOST = "analisi.transparenciacatalunya.cat";
const VIEW_ID = "qcrr-stew";
const SOURCE_NAME = "rasic-instaladores-cat" as const;
const DEFAULT_LIMIT = 20_000;

function isTrue(val: unknown): boolean {
  if (typeof val !== "string") return false;
  return /^s[ií]/i.test(val.trim());
}

function pickCategory(row: SocrataRow): CategoryKey {
  if (isTrue(socrataPick(row, ["bt_installacions"]))) return "electricidad";
  if (
    isTrue(socrataPick(row, ["ite_installacions_term"])) ||
    isTrue(socrataPick(row, ["fred_industrial"]))
  ) return "hvac";
  if (isTrue(socrataPick(row, ["gas"]))) return "fontaneria";
  return "electricidad";
}

function buildAddress(row: SocrataRow): string | undefined {
  const parts: string[] = [];
  const addr = socrataPick(row, ["adreca_agrupada", "adre_a"]);
  const city = socrataPick(row, ["municipi", "poblaci_"]);
  const cp = socrataPick(row, ["codi_postal"]);
  if (addr) parts.push(addr);
  if (city) parts.push(city);
  if (cp) parts.push(cp);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

interface RunResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export const rasicInstaladorsCatSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_RASIC_INSTALADORES_CAT === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runRasicInstaladorsCat(): Promise<RunResult> {
  if (!rasicInstaladorsCatSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(
    process.env.PROLIO_RASIC_INSTALADORES_CAT_LIMIT ?? DEFAULT_LIMIT,
  );
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const sink = getSink();
  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoName = 0;
  let droppedNoCity = 0;
  let droppedInactive = 0;

  for await (const page of fetchSocrataJson({
    host: SOCRATA_HOST,
    viewId: VIEW_ID,
    pageSize: 1000,
    maxRows,
    where: "estat_registre='Alta'",
  })) {
    for (const row of page) {
      const name = socrataPick(row, ["titular", "nom_titular", "nom"]);
      if (!name) {
        droppedNoName += 1;
        continue;
      }

      const rasicNum = socrataPick(row, ["n_mero_de_rasic", "numero_de_rasic"]);
      const sourceId = rasicNum ? `rasic-instaladores:${rasicNum}` : `rasic-instaladores:${name.slice(0, 40)}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const status = socrataPick(row, ["estat_registre"]);
      if (status && !/alta/i.test(status)) {
        droppedInactive += 1;
        continue;
      }

      const rawCity = socrataPick(row, ["municipi", "poblaci_"]);
      const citySlug = rawCity ? slugify(rawCity) : undefined;
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      const category = pickCategory(row);
      const province = socrataPick(row, ["prov_ncia"]);
      const phone = socrataPick(row, ["telefon_mobil", "telefon"]);

      records.push(
        normalise({
          source: SOURCE_NAME as ScrapeSource,
          country: "ES",
          sourceId,
          name,
          categoryKey: category,
          citySlug,
          address: buildAddress(row),
          phone,
          licenseNumber: rasicNum ?? undefined,
          metadata: {
            province,
            bt_installacions: socrataPick(row, ["bt_installacions"]),
            ite_installacions_term: socrataPick(row, ["ite_installacions_term"]),
            fred_industrial: socrataPick(row, ["fred_industrial"]),
            gas: socrataPick(row, ["gas"]),
            verified_by_authority: true,
            authority: "RASIC",
            country: "ES",
          },
        }),
      );
    }
  }

  if (records.length === 0) {
    console.log(
      `[rasic-instaladores-cat] done — scanned=${seen.size} accepted=0 ` +
        `droppedNoName=${droppedNoName} droppedNoCity=${droppedNoCity}`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[rasic-instaladores-cat] done — accepted=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped} ` +
      `droppedNoName=${droppedNoName} droppedNoCity=${droppedNoCity} ` +
      `droppedInactive=${droppedInactive}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}

export async function runRasicInstaladorsCatWithTelemetry(): Promise<RunResult> {
  let result: RunResult = { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  await withScrapeRun(SOURCE_NAME, async () => {
    result = await runRasicInstaladorsCat();
    return {
      rowsFetched: result.fetched,
      rowsUpserted: result.inserted + result.updated,
      rowsSkipped: result.skipped,
    };
  }).catch((e) =>
    console.error(`[rasic-instaladores-cat] crashed:`, (e as Error).message),
  );
  return result;
}
