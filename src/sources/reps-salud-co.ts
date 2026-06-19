import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * REPS — Registro Especial de Prestadores de Servicios de Salud (Colombia).
 *
 * Dataset `c36g-9fc2` on datos.gov.co (Socrata). ~77k rows: every
 * habilitated health provider + service location (sede) in Colombia.
 *
 * Bulk no-loss ingestion (docs/SCRAPING_CO_20260619.md §1): we stream the
 * whole dataset and call ensureCity() per row to auto-seed the municipio,
 * then upsert through getSink({ trustCitySlugs: true }) which skips the
 * city-not-seeded drop. No row is lost for an unseeded municipality.
 *
 * Category: REPS distinguishes provider class (claseprestador) but not the
 * medical specialty at this level (that lives in a separate `servicios`
 * dataset). So every row maps to the generic health vertical `medicina`.
 * A future enrichment can subdivide via the services dataset.
 *
 * Field names are the exact (sparse) Socrata keys — non-ASCII chars in the
 * source are serialised to `_` (e.g. `direcci_nsede`, `t_lefonosede`).
 */

const HOST = "www.datos.gov.co";
const VIEW_ID = "c36g-9fc2";
const SOURCE_NAME = "reps-salud-co" as const;
const DEFAULT_LIMIT = 100_000; // dataset is ~77k; default covers all.

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase())
    .trim();
}

/** SECOP/REPS encode missing values as the literal string "No Provisto". */
function clean(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (!t || /^no provisto$/i.test(t) || /^no definido$/i.test(t)) return undefined;
  return t;
}

function buildAddress(
  street: string | undefined,
  city: string | undefined,
  dept: string | undefined,
): string | undefined {
  const parts = [street, city, dept].map(clean).filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
}

export async function runRepsSaludCo(
  client: SupabaseClient,
  opts: RunOptions = {},
): Promise<{ scanned: number; accepted: number; written: number }> {
  const batchSize = opts.batchSize ?? 500;
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
  })) {
    for (const row of page) {
      if (scanned > 0 && scanned % 5000 === 0) {
        const cs = getCityUpsertStats();
        console.log(
          `[reps-salud-co] progress scanned=${scanned} accepted=${accepted} ` +
            `written=${written} cities_created=${cs.inserted}`,
        );
      }
      scanned += 1;

      // Unique per sede; fall back to prestador code.
      const sedeCode = socrataPick(row, ["codigohabilitacionsede"]);
      const prestadorCode = socrataPick(row, ["codigoprestador"]);
      const id = sedeCode ?? prestadorCode;
      if (!id) continue;

      const rawName =
        clean(socrataPick(row, ["nombresede"])) ??
        clean(socrataPick(row, ["nombreprestador"]));
      if (!rawName) continue;

      const cityRaw =
        clean(socrataPick(row, ["municipiosededesc", "municipioprestadordesc"]));
      const deptRaw =
        clean(socrataPick(row, ["departamentodededesc", "departamentoprestadordesc"]));
      if (!cityRaw) continue;

      const cityResult = await ensureCity(client, {
        name: titleCase(cityRaw),
        state: deptRaw,
        country: "CO",
      });
      if (!cityResult) continue;

      const tipoId = socrataPick(row, ["tipoid"]);
      const numId = clean(socrataPick(row, ["numeroidentificacion"]));
      const nit = tipoId === "NI" ? numId : undefined;

      buffer.push({
        source: SOURCE_NAME as ScrapeSource,
        sourceId: `reps-salud-co:${id}`,
        name: titleCase(rawName),
        categoryKey: "medicina",
        country: "CO",
        citySlug: cityResult.slug,
        phone: clean(socrataPick(row, ["telefonoprestador", "t_lefonosede"])),
        email: clean(socrataPick(row, ["email_prestador", "email_sede"])),
        address: buildAddress(
          socrataPick(row, ["direccionprestador", "direcci_nsede"]),
          cityRaw,
          deptRaw,
        ),
        metadata: {
          nit,
          tipo_id: tipoId,
          numero_identificacion: numId,
          clase_prestador: clean(socrataPick(row, ["claseprestador"])),
          naturaleza_juridica: clean(socrataPick(row, ["naturalezajuridica"])),
          es_ese: clean(socrataPick(row, ["ese"])),
          municipio: cityRaw,
          municipio_dane: socrataPick(row, ["municipiosede", "municipio_prestador"]),
          departamento: deptRaw,
          codigo_prestador: prestadorCode,
          country: "CO",
          verified_by_authority: true,
          authority: "REPS — MinSalud",
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();

  const cs = getCityUpsertStats();
  console.log(
    `[reps-salud-co] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ──────────────────────────────────────────────────────

export const repsSaludCoSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_REPS_SALUD_CO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runRepsSaludCoSource(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!repsSaludCoSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_REPS_SALUD_CO_LIMIT ?? DEFAULT_LIMIT);
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runRepsSaludCo(client, { maxRows });
  console.log(
    `[reps-salud-co] source done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return {
    fetched: accepted,
    inserted: written,
    updated: 0,
    skipped: scanned - accepted,
  };
}
