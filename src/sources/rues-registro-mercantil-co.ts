import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * RUES — Registro Mercantil (Colombia), via datos.gov.co `c82u-588k`.
 *
 * ~9.3M rows: every natural person, legal entity and ESADL registered in
 * the commercial registry, consolidated from the 57 chambers of commerce.
 *
 * Caveats (verified live, docs/SCRAPING_CO_20260619.md §3):
 *  - NO municipio/departamento/geo/contact columns. The only location hint
 *    is `camara_comercio` (the chamber's seat city) → used as a coarse city.
 *  - Has CIIU activity codes (`cod_ciiu_act_econ_pri`). We map those to a
 *    profession vertical; everything that doesn't map falls back to the
 *    generic `empresa` category (so no business is dropped).
 *
 * Bulk no-loss: ensureCity() per row + getSink({ trustCitySlugs: true }).
 */

const HOST = "www.datos.gov.co";
const VIEW_ID = "c82u-588k";
const SOURCE_NAME = "rues-registro-mercantil-co" as const;
const DEFAULT_LIMIT = 10_000_000; // whole dataset (~9.3M).

// Default to active registrations only — cancelled/struck-off companies add
// millions of rows with no product value. Toggle off with
// PROLIO_RUES_ALL_STATES=true to ingest every state.
function whereClause(): string | undefined {
  if (process.env.PROLIO_RUES_ALL_STATES === "true") return undefined;
  return "upper(estado_matricula)='ACTIVA'";
}

// CIIU Rev. 4 A.C. → vertical. Only the codes that map to one of our
// profession verticals; anything else → 'empresa'. 4-digit class prefix.
const CIIU_TO_CATEGORY: Record<string, CategoryKey> = {
  "4520": "mecanica", // mantenimiento y reparación de vehículos
  "4321": "electricidad", // instalaciones eléctricas
  "4322": "fontaneria", // fontanería, calefacción y aire acondicionado
  "4330": "carpinteria", // terminación y acabado de edificios
  "7110": "ingenieria", // actividades de arquitectura e ingeniería
  "7111": "arquitecto", // actividades de arquitectura
  "7112": "ingenieria", // actividades de ingeniería
  "6920": "fiscal", // contabilidad, teneduría de libros, auditoría
  "6910": "abogado", // actividades jurídicas
  "7500": "veterinario", // actividades veterinarias
  "4773": "farmacia", // comercio al por menor de productos farmacéuticos
  "8621": "medicina", // medicina general
  "8622": "medicina", // medicina especializada
  "8690": "medicina", // otras actividades de atención de la salud humana
};

function mapCiiu(code: string | undefined): CategoryKey {
  if (!code) return "empresa";
  return CIIU_TO_CATEGORY[code.trim().slice(0, 4)] ?? "empresa";
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase())
    .trim();
}

function clean(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (!t || /^no provisto$/i.test(t)) return undefined;
  return t;
}

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
}

export async function runRuesRegistroMercantilCo(
  client: SupabaseClient,
  opts: RunOptions = {},
): Promise<{ scanned: number; accepted: number; written: number }> {
  const batchSize = opts.batchSize ?? 1000;
  const sink = getSink({ trustCitySlugs: true });
  let scanned = 0;
  let accepted = 0;
  let written = 0;
  let buffer: ScrapedProfessional[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const res = await sink.upsert(buffer);
    written += res.inserted + res.updated;
    buffer = [];
  };

  for await (const page of fetchSocrataJson({
    host: HOST,
    viewId: VIEW_ID,
    pageSize: 1000,
    maxRows: opts.maxRows,
    where: whereClause(),
    appToken: process.env.SOCRATA_APP_TOKEN,
  })) {
    for (const row of page) {
      if (scanned > 0 && scanned % 20000 === 0) {
        const cs = getCityUpsertStats();
        console.log(
          `[rues-co] progress scanned=${scanned} accepted=${accepted} ` +
            `written=${written} cities_created=${cs.inserted}`,
        );
      }
      scanned += 1;

      const nit = clean(socrataPick(row, ["nit"]));
      const numId = clean(socrataPick(row, ["numero_identificacion"]));
      const id = nit ?? numId;
      if (!id) continue;

      const rawName = clean(socrataPick(row, ["razon_social"]));
      if (!rawName) continue;

      // Value filter: RUES has no contact data, so a row that doesn't even
      // map to a profession vertical (CIIU → 'empresa') is a contactless,
      // uncategorised shell — ~93% of the 9.3M. Skip those by default; the
      // useful ~7% (mechanics, lawyers, …) stay. PROLIO_RUES_INCLUDE_GENERIC=true
      // ingests everything. Compute BEFORE ensureCity to skip its geocode cost.
      const ciiuPri = socrataPick(row, ["cod_ciiu_act_econ_pri", "ciiu4"]);
      const category = mapCiiu(ciiuPri);
      if (
        category === "empresa" &&
        process.env.PROLIO_RUES_INCLUDE_GENERIC !== "true"
      )
        continue;

      // Coarse geo: the chamber's seat city is the best location available.
      const camara = clean(socrataPick(row, ["camara_comercio"]));
      if (!camara) continue;
      const cityResult = await ensureCity(client, {
        name: titleCase(camara),
        country: "CO",
      });
      if (!cityResult) continue;

      buffer.push({
        source: SOURCE_NAME as ScrapeSource,
        sourceId: `rues-co:${id}`,
        name: titleCase(rawName),
        categoryKey: category,
        country: "CO",
        citySlug: cityResult.slug,
        metadata: {
          nit,
          digito_verificacion: socrataPick(row, ["digito_verificacion"]),
          numero_identificacion: numId,
          clase_identificacion: socrataPick(row, ["clase_identificacion"]),
          ciiu_pri: ciiuPri,
          ciiu_sec: socrataPick(row, ["cod_ciiu_act_econ_sec"]),
          estado_matricula: socrataPick(row, ["estado_matricula"]),
          camara_comercio: camara,
          codigo_camara: socrataPick(row, ["codigo_camara"]),
          representante_legal: socrataPick(row, ["representante_legal"]),
          country: "CO",
          verified_by_authority: true,
          authority: "RUES — Confecámaras",
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();

  const cs = getCityUpsertStats();
  console.log(
    `[rues-co] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ──────────────────────────────────────────────────────

export const ruesRegistroMercantilCoSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_RUES_CO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runRuesRegistroMercantilCoSource(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!ruesRegistroMercantilCoSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_RUES_CO_LIMIT ?? DEFAULT_LIMIT);
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runRuesRegistroMercantilCo(client, {
    maxRows,
  });
  console.log(
    `[rues-co] source done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return {
    fetched: accepted,
    inserted: written,
    updated: 0,
    skipped: scanned - accepted,
  };
}
