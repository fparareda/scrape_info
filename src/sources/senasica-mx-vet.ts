import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv } from "./_bulk-utils.js";

/**
 * SENASICA — Servicio Nacional de Sanidad, Inocuidad y Calidad
 * Agroalimentaria. Mexican federal animal-health authority that
 * publishes the official roster of authorised veterinarians as a
 * CSV on datos.gob.mx (CKAN). License CC BY 4.0 — commercial reuse
 * with attribution.
 *
 * Discovered 2026-05-07 via Chrome MCP search of datos.gob.mx CKAN
 * API. Two complementary datasets:
 *   - "Médicos veterinarios responsables autorizados" (the main
 *     roster — vets responsible for clinic/hospital operations)
 *   - "Médicos veterinarios terceros especialistas autorizados"
 *     (specialty consultants — opt in via env override)
 *
 * Both share the same column shape:
 *   nombre,clave,area,correo,representacion,telefono,vigencia_inicio,vigencia_fin
 *
 * `representacion` is the city/state where the vet is registered;
 * we slugify it to match our cities seed (top 30 MX metros from
 * migration 0070). Anything outside the seed gets dropped at sink.
 *
 * Off by default. `PROLIO_RUN_SENASICA_MX_VET=true` enables. Cap
 * with `PROLIO_SENASICA_MX_VET_LIMIT` (default 5000).
 */

const DEFAULT_URL =
  "https://repodatos.atdt.gob.mx/api_update/senasica/medicos_veterinarios_responsables_autorizados/medicos_veterinarios_responsables_autorizados.csv";
const DEFAULT_LIMIT = 5_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_SENASICA_MX_VET_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    console.error(
      `[senasica-mx-vet] network error: ${(error as Error).message}`,
    );
    return [];
  }
  if (!response.ok) {
    console.error(`[senasica-mx-vet] ${response.status} on ${url}`);
    return [];
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  // Today's date check — SENASICA exports include expired licences
  // (vigencia_fin < today). We only ingest currently-valid ones.
  const today = new Date();

  for (const row of rows) {
    if (out.length >= limit) break;
    const clave = row["clave"];
    const nombre = row["nombre"];
    if (!clave || !nombre) continue;

    // Drop expired vigencia.
    const vigenciaFin = row["vigencia_fin"];
    if (vigenciaFin) {
      const fin = new Date(vigenciaFin);
      if (Number.isFinite(fin.getTime()) && fin < today) continue;
    }

    if (seen.has(clave)) continue;
    seen.add(clave);

    // `representacion` is e.g. "Ciudad de México", "Jalisco", "Guadalajara"
    // — sometimes a state, sometimes a city, and not reliably one of the
    // seeded MX city slugs. The old `STATE_TO_CITY[slug] ?? slug` path
    // emitted slugs not present in `cities`, which the sink dropped. SENASICA
    // is a national roster with only state/representacion granularity we can
    // trust, so emit citySlug="" (sink writes city_slug=NULL) and surface the
    // representacion as metadata.province_slug.
    const repRaw = row["representacion"]?.trim() ?? "";
    const provinceSlug = repRaw ? slugify(repRaw) : undefined;

    out.push(
      normalise({
        source: "senasica-mx-vet",
        country: "MX",
        sourceId: `senasica-mx-vet:${clave}`,
        name: nombre,
        categoryKey: "veterinario",
        citySlug: "",
        phone: row["telefono"] || undefined,
        email: row["correo"] || undefined,
        licenseNumber: clave,
        metadata: {
          country: "MX",
          authority: "SENASICA",
          verified_by_authority: true,
          area: row["area"],
          representacion: repRaw,
          province_slug: provinceSlug,
          vigencia_inicio: row["vigencia_inicio"],
          vigencia_fin: vigenciaFin,
        },
      }),
    );
  }
  console.log(`[senasica-mx-vet] parsed=${out.length}`);
  return out;
}

export const senasicaMxVetSource: ScraperSource = {
  name: "senasica-mx-vet",
  enabled() {
    return process.env.PROLIO_RUN_SENASICA_MX_VET === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runSenasicaMxVet(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!senasicaMxVetSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_SENASICA_MX_VET_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[senasica-mx-vet] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
