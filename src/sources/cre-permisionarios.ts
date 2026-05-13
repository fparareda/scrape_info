import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv, pick } from "./_bulk-utils.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * CRE — Comisión Reguladora de Energía (Mexico).
 *
 * Padrones de permisionarios = empresas autorizadas en los cuatro
 * mercados energéticos regulados por la CRE:
 *
 *   - Gas LP                (distribución, transporte, almacenamiento, expendio)
 *   - Gas natural           (distribución, transporte, comercialización)
 *   - Petrolíferos          (refinación, transporte, comercialización, expendio)
 *   - Electricidad          (generación, transmisión, distribución, suministro)
 *
 * ~20k permisos activos en total. Son empresas LEGÍTIMAS con
 * certificación oficial — encaja directamente con categorías
 * `hvac` (climatización con gas), `fontaneria` (instalación de gas LP)
 * y `electricidad` (transmisión/distribución).
 *
 * URLs source: las páginas oficiales `gob.mx/cre/acciones-y-programas/*`
 * publican un padrón por mercado en CSV/XLSX, accesible desde el sitio
 * legado `www.cre.gob.mx` bajo `/da/` (datos abiertos). El env override
 * `PROLIO_CRE_*_URL` por mercado permite redirigir a la URL actual sin
 * tocar código si la CRE muda los archivos.
 *
 * Off by default. `PROLIO_RUN_CRE_PERMISIONARIOS=true` enables.
 * Cap con `PROLIO_CRE_PERMISIONARIOS_LIMIT` (default 25000 — toda la
 * lista cabe en una corrida).
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const DEFAULT_LIMIT = 25_000;

type PadronTipo = "gas-lp" | "gas-natural" | "petroliferos" | "electricidad";

interface Padron {
  tipo: PadronTipo;
  label: string;
  /** Default URL — overridable via env. */
  url: string;
  /** Category fallback when modalidad doesn't match a more specific rule. */
  defaultCategory: CategoryKey;
}

const PADRONES: Padron[] = [
  {
    tipo: "gas-lp",
    label: "gas-lp",
    url:
      process.env.PROLIO_CRE_GAS_LP_URL ||
      "https://www.cre.gob.mx/da/permisosgaslp.csv",
    defaultCategory: "fontaneria",
  },
  {
    tipo: "gas-natural",
    label: "gas-natural",
    url:
      process.env.PROLIO_CRE_GAS_NATURAL_URL ||
      "https://www.cre.gob.mx/da/permisosgasnatural.csv",
    defaultCategory: "hvac",
  },
  {
    tipo: "petroliferos",
    label: "petroliferos",
    url:
      process.env.PROLIO_CRE_PETROLIFEROS_URL ||
      "https://www.cre.gob.mx/da/permisospetroliferos.csv",
    defaultCategory: "mecanica",
  },
  {
    tipo: "electricidad",
    label: "electricidad",
    url:
      process.env.PROLIO_CRE_ELECTRICIDAD_URL ||
      "https://www.cre.gob.mx/da/permisoselectricidad.csv",
    defaultCategory: "electricidad",
  },
];

/**
 * Map a CRE permiso to a Prolio category. Some modalidades clarify
 * the activity: e.g. an "expendio al público" of gas LP behaves
 * like a fontanería supplier; a "generación" eléctrica is closer
 * to electricidad regardless. We special-case those; everything
 * else falls back to the padrón's default.
 */
function mapCategory(tipo: PadronTipo, modalidad: string | undefined): CategoryKey {
  const m = (modalidad ?? "").toLowerCase();
  if (tipo === "gas-lp" || tipo === "gas-natural") {
    if (/distribuc/.test(m) || /expendio/.test(m) || /almacen/.test(m)) {
      // Distribución / expendio residencial → fontanería (gas a pie de
      // edificio). Almacenamiento se queda con fontanería también
      // porque suele ir acompañado de instalación.
      return "fontaneria";
    }
    if (/transport/.test(m) || /comercializ/.test(m)) {
      // Transporte y comercialización mayorista → climatización industrial.
      return "hvac";
    }
    return tipo === "gas-lp" ? "fontaneria" : "hvac";
  }
  if (tipo === "electricidad") return "electricidad";
  // Petrolíferos: refinación / transporte / comercialización / expendio.
  if (/expendio/.test(m) || /estacion/.test(m)) return "mecanica"; // gasolineras
  return "mecanica";
}

function parseEstado(row: Record<string, string>): string | undefined {
  return (
    pick(row, ["entidad_federativa", "entidad", "estado", "edo"]) || undefined
  );
}

function parseCity(row: Record<string, string>): string | undefined {
  return pick(row, ["municipio", "ciudad", "nom_mun", "delegacion"]) || undefined;
}

async function fetchPadron(
  padron: Padron,
  remaining: number,
): Promise<ScrapedProfessional[]> {
  if (remaining <= 0) return [];
  let response: Response;
  try {
    response = await fetch(padron.url, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    console.error(
      `[cre-permisionarios] ${padron.label} network: ${(error as Error).message}`,
    );
    return [];
  }
  if (!response.ok) {
    console.error(
      `[cre-permisionarios] ${padron.label} HTTP ${response.status} on ${padron.url}`,
    );
    return [];
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  const today = new Date();

  for (const row of rows) {
    if (out.length >= remaining) break;

    const numeroPermiso =
      pick(row, [
        "numero_permiso",
        "num_permiso",
        "num_de_permiso",
        "permiso",
        "no_permiso",
        "folio",
        "clave",
      ]) || "";
    if (!numeroPermiso) continue;
    if (seen.has(numeroPermiso)) continue;
    seen.add(numeroPermiso);

    const razonSocial =
      pick(row, [
        "razon_social",
        "permisionario",
        "nombre",
        "nombre_permisionario",
        "denominacion",
      ]) || "";
    if (!razonSocial) continue;

    const estadoPermiso =
      pick(row, [
        "estatus",
        "estatus_permiso",
        "estado_permiso",
        "estado_del_permiso",
        "vigencia",
        "situacion",
      ]) || "";
    // Drop explicitly inactive permisos.
    if (/cancel|extinguid|revocad|terminad/i.test(estadoPermiso)) continue;

    // Drop expired by date if present.
    const fechaTermino =
      pick(row, ["fecha_termino", "fecha_vencimiento", "vigencia_fin"]) || "";
    if (fechaTermino) {
      const d = new Date(fechaTermino);
      if (Number.isFinite(d.getTime()) && d < today) continue;
    }

    const modalidad =
      pick(row, [
        "modalidad",
        "modalidad_permiso",
        "tipo_permiso",
        "actividad",
      ]) || "";

    const entidad = parseEstado(row);
    const municipio = parseCity(row);
    // Prefer estado-based mapping (most reliable). Municipio rarely
    // matches the seeded city slug verbatim, but we still record it
    // in metadata for downstream geocoding.
    const citySlug = mxStateToCity(entidad) ?? "cdmx";

    const fechaOtorgamiento =
      pick(row, [
        "fecha_otorgamiento",
        "fecha_de_otorgamiento",
        "fecha_inicio",
        "fecha_publicacion",
      ]) || undefined;

    const rfc = pick(row, ["rfc"]) || undefined;
    const telefono = pick(row, ["telefono", "tel", "telefonos"]) || undefined;
    const email =
      pick(row, ["correo", "correo_electronico", "email", "correoelec"]) ||
      undefined;
    const website =
      pick(row, ["sitio_web", "pagina_web", "url", "www"]) || undefined;
    const domicilio =
      pick(row, ["domicilio", "direccion", "domicilio_fiscal"]) || undefined;

    out.push(
      normalise({
        source: "cre-permisionarios" as ScrapeSource,
        sourceId: `cre:${numeroPermiso}`,
        name: razonSocial,
        categoryKey: mapCategory(padron.tipo, modalidad),
        citySlug,
        licenseNumber: numeroPermiso,
        cif: rfc,
        phone: telefono,
        email,
        website,
        address: domicilio,
        metadata: {
          country: "MX",
          authority: "CRE",
          verified_by_authority: true,
          permiso_numero: numeroPermiso,
          permiso_tipo: padron.tipo,
          modalidad: modalidad || undefined,
          estado_permiso: estadoPermiso || "vigente",
          fecha_otorgamiento: fechaOtorgamiento,
          fecha_termino: fechaTermino || undefined,
          entidad,
          municipio,
        },
      }),
    );
  }
  console.log(
    `[cre-permisionarios] padron=${padron.label}: kept=${out.length} of ${rows.length} csv rows`,
  );
  return out;
}

export const crePermisionariosEnabled = (): boolean =>
  process.env.PROLIO_RUN_CRE_PERMISIONARIOS === "true";

export const crePermisionariosSource: ScraperSource = {
  name: "cre-permisionarios" as ScrapeSource,
  enabled: crePermisionariosEnabled,
  async fetch() {
    return [];
  },
};

export async function runCrePermisionarios(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!crePermisionariosEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("cre-permisionarios" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_CRE_PERMISIONARIOS_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

    const all: ScrapedProfessional[] = [];
    for (const padron of PADRONES) {
      if (all.length >= limit) break;
      const remaining = limit - all.length;
      const records = await fetchPadron(padron, remaining);
      all.push(...records);
    }

    if (all.length === 0)
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(all);
    console.log(
      `[cre-permisionarios] done — fetched=${all.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
    return {
      rowsFetched: all.length,
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
