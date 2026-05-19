import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { splitCsvLine } from "./_bulk-utils.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * Padrón Ganadero Nacional (PGN) — Mexico.
 *
 * El PGN es el registro oficial federal de Unidades de Producción
 * Pecuaria (UPP) y Prestadores de Servicios Ganaderos (PSG) en
 * México, operado por SADER/SENASICA y publicado a través de
 * la FMVZ-UNAM como administrador técnico del padrón.
 *
 *   Sitio admin:  https://www.fmvz.unam.mx/fmvz/departamentos/genetica/padron_2025.html
 *   Visor:        https://public.tableau.com/views/PGN25/PGN25
 *   Contacto:     pgn.informacion@gmail.com
 *
 * ~1.2M UPP activas a 2025-09. El campo principal de profesional
 * que nos interesa es el **MVZ responsable** (Médico Veterinario
 * Zootecnista que firma el alta sanitaria de cada UPP). Una sola
 * MVZ típicamente responde por decenas/cientos de UPPs, por lo
 * que la deduplicación por `clave_mvz` (o por nombre+estado si
 * la clave no está disponible) es crítica.
 *
 * IMPORTANTE: a fecha 2026-05 el PGN **no** publica el dataset
 * bulk en CKAN/data.gob.mx — sólo está disponible vía la viz
 * pública de Tableau. Mientras SADER no publique un endpoint
 * CSV/XLSX directo, esta fuente queda lista para activarse
 * mediante `PROLIO_PADRON_GANADERO_NACIONAL_CSV` apuntando a un
 * mirror interno o una extracción manual del Tableau (`Download
 * → Crosstab → All`). El parser hace streaming chunk-by-chunk
 * para soportar archivos del orden de cientos de MB sin OOM.
 *
 * Formato esperado del CSV (cabeceras tolerantes — normalisedHeaderKey):
 *   estado, municipio, upp, especie, responsable_sanitario,
 *   clave_mvz, telefono, correo (opcionales)
 *
 * Off by default. `PROLIO_RUN_PADRON_GANADERO_NACIONAL=true` enables.
 * Cap con `PROLIO_PADRON_GANADERO_NACIONAL_LIMIT` (default 50000 —
 * primer batch razonable; el universo total es 1.2M UPPs pero al
 * deduplicar por MVZ responsable bajan a ~30-50k profesionales
 * únicos esperados).
 */

const DEFAULT_LIMIT = 50_000;
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function normaliseHeaderKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function pick(row: Record<string, string>, candidates: string[]): string {
  for (const k of candidates) if (row[k]) return row[k];
  for (const k of Object.keys(row)) {
    for (const c of candidates) {
      if (k.includes(c) && row[k]) return row[k];
    }
  }
  return "";
}

/**
 * Streaming CSV reader — auto-detects separator (`,` `;` or `\t`)
 * on the header line. Yields one row per record. Tolerates BOM,
 * Windows line endings and quoted fields with embedded delimiters.
 */
async function* streamRows(
  url: string,
): AsyncGenerator<Record<string, string>, void, unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(30 * 60_000),
    });
  } catch (error) {
    console.error(
      `[padron-ganadero-nacional] network: ${(error as Error).message}`,
    );
    return;
  }
  if (!response.ok) {
    console.error(
      `[padron-ganadero-nacional] HTTP ${response.status} on ${url}`,
    );
    return;
  }
  if (!response.body) {
    console.error("[padron-ganadero-nacional] response.body is null");
    return;
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const reader = response.body.getReader();
  let buffer = "";
  let header: string[] | null = null;
  let sep = ",";

  const detectSep = (line: string): string => {
    const candidates = [",", ";", "\t"];
    let best = ",";
    let bestCount = -1;
    for (const c of candidates) {
      const n = line.split(c).length;
      if (n > bestCount) {
        bestCount = n;
        best = c;
      }
    }
    return best;
  };

  const handleLine = (line: string): Record<string, string> | null => {
    if (!line) return null;
    if (!header) {
      // Strip UTF-8 BOM from the very first line, if present.
      const clean = line.replace(/^﻿/, "");
      sep = detectSep(clean);
      header = splitCsvLine(clean, sep).map(normaliseHeaderKey);
      return null;
    }
    const cells = splitCsvLine(line, sep);
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) {
      row[header[i]] = (cells[i] ?? "").trim();
    }
    return row;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const raw = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        const row = handleLine(raw);
        if (row) yield row;
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const row = handleLine(buffer.replace(/\r$/, ""));
      if (row) yield row;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_PADRON_GANADERO_NACIONAL_CSV;
  if (!url) {
    console.warn(
      "[padron-ganadero-nacional] PROLIO_PADRON_GANADERO_NACIONAL_CSV not set — " +
        "PGN bulk dataset is not published on CKAN; set the env var to a mirror " +
        "or Tableau crosstab export to ingest. Skipping.",
    );
    return [];
  }

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  for await (const row of streamRows(url)) {
    scanned += 1;
    if (out.length >= limit) break;

    const responsable =
      pick(row, [
        "responsable_sanitario",
        "mvz_responsable",
        "responsable",
        "nombre_mvz",
        "nombre_responsable",
        "medico_veterinario",
      ]) || "";
    if (!responsable) continue;

    const claveMvz =
      pick(row, [
        "clave_mvz",
        "cedula_mvz",
        "cedula_profesional",
        "cedula",
        "clave_responsable",
        "no_mvz",
      ]) || "";

    const estado = pick(row, ["estado", "entidad", "entidad_federativa"]);
    const municipio = pick(row, ["municipio", "mpio", "nom_mun"]);
    const upp = pick(row, ["upp", "clave_upp", "id_upp", "folio_upp"]);
    const especie = pick(row, ["especie", "especies", "tipo_explotacion"]);

    // Dedup priority: clave_mvz when present (1 row per pro nationwide),
    // otherwise responsable + estado (fuzzy but stable enough across
    // re-runs of the same dataset).
    const dedupKey = claveMvz
      ? `mvz:${claveMvz}`
      : `name:${responsable.toLowerCase()}|${(estado || "").toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const citySlug = mxStateToCity(estado) ?? undefined;
    if (!citySlug) continue;

    const phone = pick(row, ["telefono", "tel", "telefonos"]) || undefined;
    const email =
      pick(row, ["correo", "correo_electronico", "email"]) || undefined;

    out.push(
      normalise({
        source: "padron-ganadero-nacional" as ScrapeSource,
        country: "MX",
        sourceId: `pgn:${claveMvz || dedupKey}`,
        name: responsable,
        categoryKey: "veterinario",
        citySlug,
        licenseNumber: claveMvz || undefined,
        phone,
        email,
        metadata: {
          country: "MX",
          authority: "FMVZ-UNAM / SADER (PGN)",
          verified_by_authority: true,
          mvz_responsable: responsable,
          clave_mvz: claveMvz || undefined,
          estado: estado || undefined,
          municipio: municipio || undefined,
          especie: especie || undefined,
          upp_sample: upp || undefined,
        },
      }),
    );
  }

  console.log(
    `[padron-ganadero-nacional] scanned=${scanned} kept=${out.length}`,
  );
  return out;
}

export const padronGanaderoNacionalEnabled = (): boolean =>
  process.env.PROLIO_RUN_PADRON_GANADERO_NACIONAL === "true";

export const padronGanaderoNacionalSource: ScraperSource = {
  name: "padron-ganadero-nacional" as ScrapeSource,
  enabled: padronGanaderoNacionalEnabled,
  async fetch() {
    return [];
  },
};

export async function runPadronGanaderoNacional(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!padronGanaderoNacionalEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  return withScrapeRun(
    "padron-ganadero-nacional" as ScrapeSource,
    async () => {
      const rawLimit = Number(
        process.env.PROLIO_PADRON_GANADERO_NACIONAL_LIMIT ?? DEFAULT_LIMIT,
      );
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
      const records = await fetchAll(limit);
      if (records.length === 0)
        return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
      const sink = getSink();
      const { inserted, updated, skipped } = await sink.upsert(records);
      console.log(
        `[padron-ganadero-nacional] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
      );
      return {
        rowsFetched: records.length,
        rowsUpserted: inserted + updated,
        rowsSkipped: skipped,
      };
    },
  ).then((r) => ({
    fetched: r?.rowsFetched ?? 0,
    inserted: 0,
    updated: 0,
    skipped: r?.rowsSkipped ?? 0,
  }));
}
