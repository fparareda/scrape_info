import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, normalisePhone, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv, pick } from "./_bulk-utils.js";
import { SPANISH_CITIES } from "../cities.js";

/**
 * RII División B — Instalaciones Térmicas de Edificios (HVAC/thermal)
 *
 * The Spanish Ministry of Industry publishes a single bulk CSV covering
 * ALL División B regulated installers (low-voltage electricians, gas
 * fitters, HVAC, elevator maintenance, refrigeration, etc.). This
 * scraper extracts only the **Instalaciones Térmicas de Edificios**
 * rows, which map to the `hvac` category (calefacción, climatización,
 * ACS — heating, air-conditioning, domestic hot water).
 *
 * Pre-flight 2026-06-08:
 *   robots.txt  — www6.serviciosmin.gob.es returns 404 for /robots.txt
 *     = allowed by absence. CC-BY 4.0 open-data licence; Ministry
 *     policy explicitly permits reutilización.
 *   Format      — 202 MB CSV, single HTTP GET, no login/captcha/WAF.
 *   Records     — 114,626 "Instalaciones Térmicas de Edificios" rows
 *     in the full file. After deduplication by NIF (same company can
 *     appear as both Instaladora + Reparadora/Mantenedora), expect
 *     ~50,000–60,000 unique HVAC companies across all 50 provinces.
 *   Last-Modified — Thu, 31 Aug 2023 (annual export cadence).
 *
 * CSV columns (after normaliseHeaderKey stripping accents):
 *   estado, titular, documento, numero_identificacion, ccaa,
 *   division, seccion, habilitacion, categoria_especialidad,
 *   identificacion, municipio_localidad, provincia, pais
 *
 * Category mapping:
 *   habilitacion == "Instalaciones Térmicas de Edificios" → hvac
 *
 * Off by default. Enable via `PROLIO_RUN_RII_DIV_B_TERMICAS_ES=true`.
 * Cap total unique companies with `PROLIO_RII_DIV_B_TERMICAS_ES_LIMIT`
 * (default 60,000).
 *
 * Sister scraper: `rii-div-b-electricidad-es` uses the same CSV URL
 * and filters for Baja Tensión (electricidad).
 */

const DEFAULT_URL =
  process.env.PROLIO_RII_DIV_B_TERMICAS_ES_URL ??
  "https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20B.csv";

const DEFAULT_LIMIT = 60_000;
const REQUEST_TIMEOUT_MS = 300_000; // 5 min — 202 MB CSV
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const CATEGORY: CategoryKey = "hvac";
const SOURCE_NAME: ScrapeSource = "rii-div-b-termicas-es";

// ─── Target habilitación value ────────────────────────────────────────────────
const HABILITACION_TERMICA = "instalaciones termicas de edificios";

function isThermica(habilitacionRaw: string | undefined): boolean {
  if (!habilitacionRaw || !habilitacionRaw.trim()) return false;
  return habilitacionRaw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .includes(HABILITACION_TERMICA);
}

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
  "corun-a": "a-coruna",
  "a-corun-a": "a-coruna",
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
      const tailAlias = ES_CITY_ALIASES[tail];
      if (tailAlias && ES_CITY_SLUGS.has(tailAlias)) return tailAlias;
    }
  }
  return undefined;
}

// ─── Fetch & parse ────────────────────────────────────────────────────────────

async function fetchAll(limit: number): Promise<{
  records: ScrapedProfessional[];
  droppedNoCity: number;
  droppedFiltered: number;
}> {
  const url = DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/csv,application/octet-stream,*/*;q=0.1",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(
      `[rii-div-b-termicas-es] fetch error: ${(error as Error).message}`,
    );
    return { records: [], droppedNoCity: 0, droppedFiltered: 0 };
  }
  if (!response.ok) {
    console.warn(`[rii-div-b-termicas-es] HTTP ${response.status} from ${url}`);
    return { records: [], droppedNoCity: 0, droppedFiltered: 0 };
  }
  const text = await response.text();
  console.log(
    `[rii-div-b-termicas-es] downloaded ${(text.length / 1024 / 1024).toFixed(1)} MB`,
  );

  const rows = parseCsv(text);
  console.log(`[rii-div-b-termicas-es] parsed ${rows.length} raw rows`);

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedFiltered = 0;
  let droppedNoCity = 0;

  for (const row of rows) {
    if (out.length >= limit) break;

    // Habilitación filter
    const habilitacion = pick(row, ["habilitacion", "habilitaci_n"]);
    if (!isThermica(habilitacion)) {
      droppedFiltered += 1;
      continue;
    }

    // Estado filter — only active records
    const estado = pick(row, ["estado"]);
    if (estado && estado.toUpperCase() !== "ACTIVO") {
      droppedFiltered += 1;
      continue;
    }

    // Company name
    const name = pick(row, [
      "titular",
      "denominacion",
      "denominacion_social",
      "nombre",
      "razon_social",
    ]);
    if (!name) continue;

    // NIF / habilitación number — use número_identificación as licence
    const numId = pick(row, [
      "numero_identificacion",
      "numero_identificaci_n",
      "identificacion",
      "identificaci_n",
    ]);
    const nif = pick(row, ["documento", "nif", "cif"]);
    // Use NIF for dedup (same company can appear with multiple habilitaciones);
    // fall back to numId when NIF is absent (individual professionals without NIF)
    const dedupKey = nif ? nif.replace(/^NIF:|^NIE:|^Pasaporte:/i, "").trim() : numId;

    // Skip rows without any identity
    if (!dedupKey && !name) continue;

    const sourceId = dedupKey
      ? `rii-b-term:${dedupKey}`
      : `rii-b-term:${slugify(name)}`;

    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    // Location
    const rawMunicipio =
      pick(row, ["municipio_localidad", "municipio", "localidad", "ciudad", "poblacion"]) ||
      undefined;
    const rawProvincia = pick(row, ["provincia"]) || undefined;

    const citySlug = resolveCitySlug(rawMunicipio, rawProvincia);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }

    // Address / contact
    const street = pick(row, ["domicilio", "direccion", "calle", "via"]);
    const postalCode = pick(row, ["codigo_postal", "cp", "c_p"]);
    const addressParts = [street, rawMunicipio, rawProvincia, postalCode].filter(Boolean);
    const address = addressParts.length > 0 ? addressParts.join(", ") : undefined;

    const phone = normalisePhone(
      pick(row, ["telefono", "telefono_1", "tel", "phone"]) || undefined,
    );
    const email = pick(row, ["email", "correo", "correo_electronico", "e_mail"]) || undefined;

    out.push(
      normalise({
        source: SOURCE_NAME,
        country: "ES",
        sourceId,
        name: name.trim(),
        categoryKey: CATEGORY,
        citySlug,
        phone,
        email: email || undefined,
        address,
        licenseNumber: numId || undefined,
        cif: nif ? nif.replace(/^NIF:|^NIE:|^Pasaporte:/i, "").trim() : undefined,
        metadata: {
          country: "ES",
          authority: "Ministerio de Industria — RII División B",
          verified_by_authority: true,
          habilitacion: habilitacion || undefined,
          seccion: pick(row, ["seccion", "secci_n"]) || undefined,
          categoria: pick(row, ["categoria_especialidad", "categor_a_especialidad"]) || undefined,
          ccaa: pick(row, ["ccaa"]) || undefined,
          provincia: rawProvincia || undefined,
        },
      }),
    );
  }

  return { records: out, droppedNoCity, droppedFiltered };
}

// ─── ScraperSource shim ───────────────────────────────────────────────────────

export const riiDivBTermicasEsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_RII_DIV_B_TERMICAS_ES === "true";
  },
  async fetch(): Promise<ScrapedProfessional[]> {
    return [];
  },
};

// ─── Main run ─────────────────────────────────────────────────────────────────

export async function runRiiDivBTermicasEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!riiDivBTermicasEsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  return withScrapeRun("rii-div-b-termicas-es", async () => {
    const rawLimit = Number(
      process.env.PROLIO_RII_DIV_B_TERMICAS_ES_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

    console.log(`[rii-div-b-termicas-es] starting — limit=${limit}`);

    const { records, droppedNoCity, droppedFiltered } = await fetchAll(limit);
    console.log(
      `[rii-div-b-termicas-es] parsed=${records.length} ` +
        `droppedFiltered=${droppedFiltered} droppedNoCity=${droppedNoCity}`,
    );

    if (records.length === 0) {
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    }

    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    console.log(
      `[rii-div-b-termicas-es] done — fetched=${records.length} ` +
        `inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );

    return {
      rowsFetched: records.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
    };
  }).then((r) => ({
    fetched: r?.rowsFetched ?? 0,
    inserted: 0,
    updated: 0,
    skipped: r?.rowsSkipped ?? 0,
  }));
}
