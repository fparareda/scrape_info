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
  /** Heartbeat: called after each page checkpoint with running totals so a
   *  killed run still reports the rows it wrote (see telemetry.ts). */
  onProgress?: (p: { fetched: number; upserted: number; skipped: number }) => Promise<void> | void;
}

// ── Resume cursor (public.scrape_cursor) ────────────────────────────────────
// RUES is ~9.3M rows and never finishes in one CI window — without a cursor
// every run restarts from $offset=0, dies on timeout, and makes zero durable
// progress. We persist the Socrata $offset and continue from it next run, the
// same way secop-proveedores-co does. The offset is over the *filtered* result
// (whereClause()) ordered by the stable `:id` default in fetchSocrataJson, so
// it stays consistent across runs as long as the WHERE filter doesn't change.
async function readCursor(client: SupabaseClient): Promise<number> {
  const { data } = await client
    .from("scrape_cursor")
    .select("next_offset")
    .eq("source", SOURCE_NAME)
    .maybeSingle();
  const v = (data as { next_offset?: number | string } | null)?.next_offset;
  return Number(v ?? 0) || 0;
}

async function writeCursor(client: SupabaseClient, nextOffset: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (client.from("scrape_cursor") as any).upsert(
    {
      source: SOURCE_NAME,
      next_offset: nextOffset,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "source" },
  );
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

  // Resume checkpoint: 9.3M rows don't finish in one CI window, so we persist
  // the Socrata $offset and continue from it next run. Reaching end-of-dataset
  // resets it to 0 for the next full refresh.
  const startOffset = await readCursor(client);
  let offset = startOffset;
  if (startOffset > 0) console.log(`[rues-co] resuming from offset=${startOffset}`);

  // Only a short page (fewer rows than pageSize) proves the dataset is
  // exhausted. A run that stops at the per-run maxRows cap ends with full
  // pages — we must NOT reset the cursor in that case or we'd re-scan from 0.
  const PAGE_SIZE = 1000;
  let exhausted = false;

  for await (const page of fetchSocrataJson({
    host: HOST,
    viewId: VIEW_ID,
    pageSize: PAGE_SIZE,
    maxRows: opts.maxRows,
    where: whereClause(),
    appToken: process.env.SOCRATA_APP_TOKEN,
    startOffset,
  })) {
    if (page.length < PAGE_SIZE) exhausted = true;
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
    // Page done — flush, then advance + persist the resume cursor so we only
    // checkpoint past rows already written.
    offset += page.length;
    await flush();
    await writeCursor(client, offset);
    await opts.onProgress?.({ fetched: accepted, upserted: written, skipped: scanned - accepted });
  }
  await flush();
  // Reset the cursor for the next full pass ONLY if we truly reached the end
  // of the dataset (a short page). If the run merely hit the per-run cap, keep
  // the checkpoint so the next run resumes where this one left off.
  if (exhausted) {
    await writeCursor(client, 0);
    console.log("[rues-co] dataset exhausted — cursor reset to 0 for next full pass");
  } else {
    console.log(`[rues-co] stopped at cap/kill — cursor parked at offset=${offset}`);
  }

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

export async function runRuesRegistroMercantilCoSource(
  report?: (p: { fetched: number; upserted: number; skipped: number }) => Promise<void> | void,
): Promise<{
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
    onProgress: report,
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
