import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * SECOP II — Proveedores Registrados (Colombia), datos.gov.co `qmzu-gj57`.
 *
 * ~1.58M rows: every provider/contractor registered to do business with the
 * Colombian state. Richest dataset for contact + geo (municipio, teléfono,
 * correo, dirección) but has NO CIIU activity code → it cannot be classified
 * into a profession vertical, so every row maps to the generic `empresa`
 * category. (A later enrichment can join on NIT against RUES to upgrade the
 * category where RUES knows the CIIU.)
 *
 * Bulk no-loss: ensureCity() per row + getSink({ trustCitySlugs: true }).
 * Missing values arrive as the literal string "No Provisto".
 */

const HOST = "www.datos.gov.co";
const VIEW_ID = "qmzu-gj57";
const SOURCE_NAME = "secop-proveedores-co" as const;
const DEFAULT_LIMIT = 2_000_000; // dataset is ~1.58M; default covers all.

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase())
    .trim();
}

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
  /** Heartbeat: called after each page checkpoint with running totals so a
   *  killed run still reports the rows it wrote (see telemetry.ts). */
  onProgress?: (p: { fetched: number; upserted: number; skipped: number }) => Promise<void> | void;
}

// ── Resume cursor (public.scrape_cursor) ────────────────────────────────────
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

export async function runSecopProveedoresCo(
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

  // Resume checkpoint: 1.58M rows don't finish in one CI window, so we persist
  // the Socrata $offset and continue from it next run. Reaching end-of-dataset
  // resets it to 0 for the next full refresh.
  const startOffset = await readCursor(client);
  let offset = startOffset;
  if (startOffset > 0) console.log(`[secop-co] resuming from offset=${startOffset}`);

  for await (const page of fetchSocrataJson({
    host: HOST,
    viewId: VIEW_ID,
    pageSize: 1000,
    maxRows: opts.maxRows,
    appToken: process.env.SOCRATA_APP_TOKEN,
    startOffset,
  })) {
    for (const row of page) {
      if (scanned > 0 && scanned % 20000 === 0) {
        const cs = getCityUpsertStats();
        console.log(
          `[secop-co] progress scanned=${scanned} accepted=${accepted} ` +
            `written=${written} cities_created=${cs.inserted}`,
        );
      }
      scanned += 1;

      // SECOP NITs arrive dirty (leading junk: ". ", "´", "|"). Keep the raw
      // value for a stable sourceId, but store a digits-only NIT in metadata
      // for display + the RUES NIT cross-match.
      const rawNit = clean(socrataPick(row, ["nit"]));
      if (!rawNit) continue;
      const nit = rawNit.replace(/\D/g, "");
      const rawName = clean(socrataPick(row, ["nombre"]));
      if (!rawName) continue;

      const cityRaw = clean(socrataPick(row, ["municipio"]));
      const deptRaw = clean(socrataPick(row, ["departamento"]));
      if (!cityRaw) continue;

      const cityResult = await ensureCity(client, {
        name: titleCase(cityRaw),
        state: deptRaw,
        country: "CO",
      });
      if (!cityResult) continue;

      buffer.push({
        source: SOURCE_NAME as ScrapeSource,
        sourceId: `secop-co:${rawNit}`,
        name: titleCase(rawName),
        categoryKey: "empresa",
        country: "CO",
        citySlug: cityResult.slug,
        phone: clean(socrataPick(row, ["telefono"])),
        email: clean(socrataPick(row, ["correo"])),
        website: clean(socrataPick(row, ["sitio_web"])),
        address: buildAddress(socrataPick(row, ["direccion"]), cityRaw, deptRaw),
        metadata: {
          nit,
          tipo_empresa: clean(socrataPick(row, ["tipo_empresa"])),
          esta_activa: socrataPick(row, ["esta_activa"]),
          es_pyme: socrataPick(row, ["espyme"]),
          ubicacion_dane: socrataPick(row, ["ubicacion"]),
          municipio: cityRaw,
          departamento: deptRaw,
          country: "CO",
          verified_by_authority: true,
          authority: "SECOP II — Colombia Compra Eficiente",
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
  // End of dataset reached → reset cursor for the next full pass.
  await writeCursor(client, 0);

  const cs = getCityUpsertStats();
  console.log(
    `[secop-co] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ──────────────────────────────────────────────────────

export const secopProveedoresCoSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_SECOP_CO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runSecopProveedoresCoSource(
  report?: (p: { fetched: number; upserted: number; skipped: number }) => Promise<void> | void,
): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!secopProveedoresCoSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_SECOP_CO_LIMIT ?? DEFAULT_LIMIT);
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runSecopProveedoresCo(client, {
    maxRows,
    onProgress: report,
  });
  console.log(
    `[secop-co] source done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return {
    fetched: accepted,
    inserted: written,
    updated: 0,
    skipped: scanned - accepted,
  };
}
