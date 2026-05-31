import type { ScrapedProfessional, ScraperSource } from "../types.js";
import type { ScrapeSource } from "../types.js";
import { normalise, slugify, normalisePhone } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, pick } from "./_bulk-utils.js";
import { SPANISH_CITIES } from "../cities.js";

/**
 * RII División B — Registro Integrado Industrial (Spain).
 *
 * Bulk open-data CSV published by the Spanish Ministry of Industry covering
 * regulated industrial installers (División B). Includes low-voltage
 * electrical installers (baja tensión), HVAC/thermal, gas fitters, etc.
 * We filter for electricidad rows only.
 *
 * Open data CC-BY licence. No login required.
 * Enable with `PROLIO_RUN_RII_DIV_B_ES=true`.
 * Override URL with `PROLIO_RII_DIV_B_ES_CSV`.
 * Cap rows with `PROLIO_RII_DIV_B_ES_LIMIT` (default 5000).
 */

const DEFAULT_URL =
  "https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20B.csv";
const DEFAULT_LIMIT = 5000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// ─── City slug resolution ─────────────────────────────────────────────────────

const ES_CITY_SLUGS = new Set(SPANISH_CITIES.map((c) => c.slug));

const ES_CITY_ALIASES: Record<string, string> = {
  "la-coruna": "a-coruna",
  "coruna": "a-coruna",
  "palma-de-mallorca": "palma",
  "palma-mallorca": "palma",
  "san-sebastian-donostia": "san-sebastian",
  "donostia": "san-sebastian",
  "vitoria-gasteiz": "vitoria",
  "santa-cruz-de-tenerife": "santa-cruz-tenerife",
  "l-hospitalet-de-llobregat": "hospitalet",
  "hospitalet-de-llobregat": "hospitalet",
  "alcala-de-henares": "alcala-henares",
  "castellon-de-la-plana": "castellon",
  "jerez-de-la-frontera": "jerez",
};

function resolveCitySlug(
  rawMunicipio: string | undefined,
  rawProvincia: string | undefined,
): string | undefined {
  for (const raw of [rawMunicipio, rawProvincia]) {
    if (!raw) continue;
    const s = slugify(raw);
    if (!s) continue;
    if (ES_CITY_SLUGS.has(s)) return s;
    const alias = ES_CITY_ALIASES[s];
    if (alias && ES_CITY_SLUGS.has(alias)) return alias;
    // token-tail fallback: "ayuntamiento de madrid" → "madrid"
    const tokens = s.split("-");
    for (let n = tokens.length; n > 0; n -= 1) {
      const tail = tokens.slice(-n).join("-");
      if (ES_CITY_SLUGS.has(tail)) return tail;
      if (ES_CITY_ALIASES[tail] && ES_CITY_SLUGS.has(ES_CITY_ALIASES[tail]!))
        return ES_CITY_ALIASES[tail];
    }
  }
  return undefined;
}

// ─── Electricidad filter ──────────────────────────────────────────────────────

function isElectricidad(actividadRaw: string | undefined): boolean {
  // If column is absent or empty, keep the row conservatively.
  if (!actividadRaw || !actividadRaw.trim()) return true;
  const a = actividadRaw.toLowerCase();
  return (
    a.includes("baja tension") ||
    a.includes("baja tensión") ||
    a.includes("electr") ||
    a.includes("instalacion electr") ||
    a.includes("instalaciones electr")
  );
}

// ─── Fetch & parse ────────────────────────────────────────────────────────────

async function fetchAll(limit: number): Promise<{
  records: ScrapedProfessional[];
  droppedNoCity: number;
  droppedFiltered: number;
}> {
  const url = process.env.PROLIO_RII_DIV_B_ES_CSV ?? DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.error(
      `[rii-div-b-es] network error: ${(err as Error).message}`,
    );
    return { records: [], droppedNoCity: 0, droppedFiltered: 0 };
  }

  if (!response.ok) {
    console.error(`[rii-div-b-es] HTTP ${response.status} on ${url}`);
    return { records: [], droppedNoCity: 0, droppedFiltered: 0 };
  }

  const rows = parseCsv(await response.text());
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedFiltered = 0;
  let droppedNoCity = 0;

  for (const row of rows) {
    if (out.length >= limit) break;

    // Activity filter
    const actividad = pick(row, [
      "actividad",
      "actividades",
      "especialidad",
      "especialidades",
      "tipo_instalacion",
      "tipo",
      "division",
      "descripcion_actividad",
    ]);
    if (!isElectricidad(actividad)) {
      droppedFiltered += 1;
      continue;
    }

    // Name
    const name = pick(row, [
      "denominacion",
      "denominacion_social",
      "nombre",
      "razon_social",
      "empresa",
    ]);
    if (!name) continue;

    // NIF / licence
    const licence = pick(row, [
      "nif",
      "cif",
      "num_habilitacion",
      "numero_habilitacion",
      "habilitacion",
      "numero",
    ]);

    // Location
    const rawMunicipio = pick(row, [
      "municipio",
      "localidad",
      "ciudad",
      "poblacion",
    ]) || undefined;
    const rawProvincia = pick(row, ["provincia"]) || undefined;

    const citySlug = resolveCitySlug(rawMunicipio, rawProvincia);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }

    // Dedup key
    const key = licence
      ? `rii-div-b-es:${licence}:electricidad`
      : `rii-div-b-es:${slugify(name)}:${citySlug}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Address fields
    const street = pick(row, ["domicilio", "direccion", "calle", "via"]);
    const postalCode = pick(row, ["codigo_postal", "cp", "c_p"]);
    const addressParts = [street, rawMunicipio, rawProvincia, postalCode].filter(
      Boolean,
    );
    const address = addressParts.length > 0 ? addressParts.join(", ") : undefined;

    // Contact
    const phone = normalisePhone(
      pick(row, ["telefono", "telefono_1", "tel", "phone"]) || undefined,
    );
    const email =
      pick(row, ["email", "correo", "correo_electronico", "e_mail"]) ||
      undefined;

    out.push(
      normalise({
        source: "rii-div-b-electricidad-es" as ScrapeSource,
        country: "ES",
        sourceId: key,
        name,
        categoryKey: "electricidad",
        citySlug,
        phone,
        email: email || undefined,
        address,
        licenseNumber: licence || undefined,
        metadata: {
          country: "ES",
          authority: "Ministerio de Industria — RII División B",
          verified_by_authority: true,
          actividad: actividad || undefined,
          provincia: rawProvincia || undefined,
        },
      }),
    );
  }

  return { records: out, droppedNoCity, droppedFiltered };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const riiDivBElectricidadEsSource: ScraperSource = {
  name: "rii-div-b-electricidad-es" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_RII_DIV_B_ES === "true";
  },
  async fetch(): Promise<ScrapedProfessional[]> {
    return [];
  },
};

export async function runRiiDivBElectricidadEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!riiDivBElectricidadEsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(
    process.env.PROLIO_RII_DIV_B_ES_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const { records, droppedNoCity, droppedFiltered } = await fetchAll(limit);

  console.log(
    `[rii-div-b-es] parsed=${records.length} droppedNoCity=${droppedNoCity} droppedFiltered=${droppedFiltered}`,
  );

  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[rii-div-b-es] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );

  return { fetched: records.length, inserted, updated, skipped };
}
