import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv } from "./_bulk-utils.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * CNSF — Comisión Nacional de Seguros y Fianzas.
 * Registro de agentes intermediarios + ajustadores + persona moral
 * (seguros + fianzas).
 *
 *   Agentes Personas Físicas  (~74k):  CKAN bulk CSV (Busca_tu_agente)
 *   Ajustadores               (~12k):  https://www.cnsf.gob.mx/Transparencia/DGJCI/Ajustadores%20vigentes.csv
 *   Agentes Persona Moral     (~2k):   https://www.cnsf.gob.mx/Transparencia/DGJCI/Directorio%20de%20Agentes%20Persona%20Moral%20Autorizados.csv
 *
 * The 2 CNSF Transparencia CSVs are CP1252 / Latin-1 encoded SharePoint
 * downloads — we decode explicitly and route through `parseCsv`.
 *
 * Mapeo de categoría: "fiscal" (es la más afín en nuestra taxonomía
 * actual — no existe `seguros`).
 *
 * Off by default. `PROLIO_RUN_CNSF_AGENTES=true`.
 * Cap with `PROLIO_CNSF_AGENTES_LIMIT` (default 10000) — applies as a
 * cumulative cap across the 3 sub-feeds.
 *
 * Per-row provenance lives in metadata.tipo:
 *   "agente"     — persona física (CKAN bulk)
 *   "ajustador"  — Transparencia CSV
 *   "agente-pm"  — persona moral CSV
 */

/**
 * Real CSV URL discovered 2026-05-13 via the CKAN API at
 *   /api/3/action/package_show?id=agentes_intermediarios
 * The dataset publishes 8 resources; the largest by far is "Busca a
 * tu agente" (~74k rows), which is the canonical agent registry.
 */
const DEFAULT_URL =
  process.env.PROLIO_CNSF_AGENTES_CSV ||
  "https://repodatos.atdt.gob.mx/api_update/csnf/agentes_intermediarios/Busca_tu_agente_ok.csv";
const AJUSTADORES_URL =
  process.env.PROLIO_CNSF_AJUSTADORES_CSV ||
  "https://www.cnsf.gob.mx/Transparencia/DGJCI/Ajustadores%20vigentes.csv";
const PM_URL =
  process.env.PROLIO_CNSF_PM_CSV ||
  "https://www.cnsf.gob.mx/Transparencia/DGJCI/Directorio%20de%20Agentes%20Persona%20Moral%20Autorizados.csv";
const DEFAULT_LIMIT = 10_000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "fiscal";

/**
 * The 2 CNSF Transparencia CSVs are served as application/octet-stream
 * with CP1252 (Windows-1252 / Latin-1) encoding. Default `response.text()`
 * decodes as UTF-8 and mangles "Descripción", "M�xico", accented names.
 * Decode explicitly so column-name normalisation in `parseCsv` lands.
 */
async function fetchLatin1Csv(url: string, label: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    console.error(`[cnsf-agentes:${label}] network error: ${(error as Error).message}`);
    return "";
  }
  if (!response.ok) {
    console.error(`[cnsf-agentes:${label}] ${response.status} on ${url}`);
    return "";
  }
  const buf = await response.arrayBuffer();
  // Node has no built-in latin1 TextDecoder label everywhere — manual map.
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

async function fetchAgentesCkan(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  let response: Response;
  try {
    response = await fetch(DEFAULT_URL, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    console.error(`[cnsf-agentes:agentes] network error: ${(error as Error).message}`);
    return out;
  }
  if (!response.ok) {
    console.error(`[cnsf-agentes:agentes] ${response.status} on ${DEFAULT_URL}`);
    return out;
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const today = new Date();

  // Schema (2026-05-13 snapshot of Busca_tu_agente_ok.csv):
  //   nombre, apellido_paterno, apellido_materno, no_cedula,
  //   tipo_cedula, tipo_agente, descripcion, fecha_vigencia
  // There is no entidad column → all routed to cdmx (CNSF is federal).
  for (const row of rows) {
    if (out.length >= limit) break;
    const clave =
      row["no_cedula"] || row["clave"] || row["folio"] || row["cedula"];
    const nombrePartes = [
      row["nombre"] || row["nombre_completo"] || row["razon_social"],
      row["apellido_paterno"] || row["apellido1"],
      row["apellido_materno"] || row["apellido2"],
    ]
      .filter(Boolean)
      .map((v) => String(v).trim());
    const nombre = nombrePartes.join(" ").trim();
    if (!clave || !nombre) continue;

    // Drop expired
    const fin =
      row["fecha_vigencia"] || row["vigencia_fin"] || row["vigencia"];
    if (fin) {
      const d = new Date(fin);
      if (Number.isFinite(d.getTime()) && d < today) continue;
    }

    const entidad =
      row["entidad"] || row["estado"] || row["entidad_federativa"];
    const citySlug = mxStateToCity(entidad) ?? "cdmx";

    out.push(
      normalise({
        source: "cnsf-agentes" as ScrapeSource,
        country: "MX",
        sourceId: `cnsf-agentes:${String(clave).trim()}`,
        name: nombre,
        categoryKey: CATEGORY,
        citySlug,
        licenseNumber: String(clave).trim(),
        cif: row["rfc"] || undefined,
        phone: row["telefono"] || undefined,
        email: row["correo"] || row["email"] || undefined,
        metadata: {
          country: "MX",
          authority: "CNSF",
          verified_by_authority: true,
          tipo: "agente",
          subtipo: row["tipo_agente"] || row["tipo_cedula"] || row["tipo"],
          descripcion: row["descripcion"],
          entidad,
          vigencia_fin: fin,
        },
      }),
    );
  }
  console.log(`[cnsf-agentes:agentes] parsed=${out.length} of ${rows.length} csv rows`);
  return out;
}

/**
 * Ajustadores vigentes — Transparencia CSV, ~12k rows.
 * Columns: Nombre, Apellido_Paterno, Apellido_Materno, Descripción, Fecha_de_Vigencia.
 * No state/entidad column → CNSF is federal → cdmx slug. No RFC, no phone.
 * sourceId composite (name + descripción hash) because there is no unique
 * cedula column; one ajustador can have N rows (one per ramo / tipo AJ-x).
 */
async function fetchAjustadores(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const text = await fetchLatin1Csv(AJUSTADORES_URL, "ajustadores");
  if (!text) return out;
  const rows = parseCsv(text);
  const today = new Date();
  let dropped = 0;
  for (const row of rows) {
    if (out.length >= limit) break;
    const nombrePartes = [
      row["nombre"],
      row["apellido_paterno"],
      row["apellido_materno"],
    ]
      .filter(Boolean)
      .map((v) => String(v).trim());
    const nombre = nombrePartes.join(" ").trim();
    const descripcion = row["descripcion"] || "";
    if (!nombre) {
      dropped += 1;
      continue;
    }
    const fin = row["fecha_de_vigencia"] || row["fecha_vigencia"];
    if (fin) {
      // DD/MM/YYYY format
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fin);
      if (m) {
        const d = new Date(`${m[3]}-${m[2]}-${m[1]}`);
        if (Number.isFinite(d.getTime()) && d < today) {
          dropped += 1;
          continue;
        }
      }
    }
    // Composite sourceId — name+descripcion uniquely identifies a row.
    const key = `${nombre}|${descripcion}`.toLowerCase().replace(/\s+/g, "_");
    out.push(
      normalise({
        source: "cnsf-agentes" as ScrapeSource,
        country: "MX",
        sourceId: `cnsf-ajustador:${key}`,
        name: nombre,
        categoryKey: CATEGORY,
        citySlug: "cdmx",
        metadata: {
          country: "MX",
          authority: "CNSF",
          verified_by_authority: true,
          tipo: "ajustador",
          descripcion,
          vigencia_fin: fin,
        },
      }),
    );
  }
  console.log(
    `[cnsf-agentes:ajustadores] parsed=${out.length} of ${rows.length} csv rows (dropped=${dropped})`,
  );
  return out;
}

/**
 * Agentes Persona Moral autorizados — Transparencia CSV, ~2k rows.
 * Columns: DENOMINACIÓN, CALLE_Y_NUMERO, COLONIA, CODIGO_POSTAL_Y_CIUDAD,
 *          TELÉFONO, EMAIL/WEB, SUCURSALES_1, SUCURSALES_2.
 * CODIGO_POSTAL_Y_CIUDAD is a free-text string like "66224, SAN PEDRO ..., N.L."
 * — we extract the trailing state abbreviation to route via mxStateToCity().
 */
const MX_STATE_ABBR_TO_NAME: Record<string, string> = {
  "ags": "aguascalientes", "b.c.": "baja-california", "b.c.s.": "baja-california-sur",
  "camp.": "campeche", "chih.": "chihuahua", "chis.": "chiapas",
  "coah.": "coahuila", "col.": "colima", "cdmx": "ciudad-de-mexico",
  "d.f.": "ciudad-de-mexico", "dgo.": "durango", "edomex": "estado-de-mexico",
  "edo. mex.": "estado-de-mexico", "mex.": "estado-de-mexico",
  "gro.": "guerrero", "gto.": "guanajuato", "hgo.": "hidalgo",
  "jal.": "jalisco", "mich.": "michoacan", "mor.": "morelos",
  "n.l.": "nuevo-leon", "nay.": "nayarit", "oax.": "oaxaca",
  "pue.": "puebla", "q. roo": "quintana-roo", "q.roo": "quintana-roo",
  "qro.": "queretaro", "sin.": "sinaloa", "s.l.p.": "san-luis-potosi",
  "son.": "sonora", "tab.": "tabasco", "tamps.": "tamaulipas",
  "tlax.": "tlaxcala", "ver.": "veracruz", "yuc.": "yucatan", "zac.": "zacatecas",
};

function extractMxStateFromCpString(cpCiudad: string): string | undefined {
  if (!cpCiudad) return undefined;
  const lower = cpCiudad.toLowerCase().trim();
  // Try matching any known abbreviation, longest first.
  const keys = Object.keys(MX_STATE_ABBR_TO_NAME).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (lower.endsWith(k) || lower.endsWith(`${k}.`) || lower.includes(`, ${k}`) || lower.includes(` ${k} `)) {
      return MX_STATE_ABBR_TO_NAME[k];
    }
  }
  return undefined;
}

function splitPhones(raw: string): string | undefined {
  if (!raw || raw === "---") return undefined;
  const first = raw.split(/[;,/]/)[0]?.trim();
  if (!first) return undefined;
  const digits = first.replace(/[^\d]/g, "");
  if (digits.length < 7) return undefined;
  return digits;
}

function splitEmail(raw: string): string | undefined {
  if (!raw || raw === "---") return undefined;
  const first = raw.split(/[;,\s]+/).find((t) => t.includes("@"));
  return first?.trim();
}

async function fetchPersonaMoral(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const text = await fetchLatin1Csv(PM_URL, "pm");
  if (!text) return out;
  const rows = parseCsv(text);
  let dropped = 0;
  for (const row of rows) {
    if (out.length >= limit) break;
    const nombre = (row["denominacion"] || row["denominación"] || "").trim();
    if (!nombre) {
      dropped += 1;
      continue;
    }
    const cpCiudad = row["codigo_postal_y_ciudad"] || "";
    const stateSlug = extractMxStateFromCpString(cpCiudad);
    const citySlug = mxStateToCity(stateSlug) ?? "cdmx";
    const phone = splitPhones(row["telefono"] || row["teléfono"] || "");
    const email = splitEmail(row["email_web"] || row["email/web"] || "");
    const calle = row["calle_y_numero"] || row["calle"] || "";
    const colonia = row["colonia"] || "";
    const key = nombre.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 80);
    out.push(
      normalise({
        source: "cnsf-agentes" as ScrapeSource,
        country: "MX",
        sourceId: `cnsf-pm:${key}`,
        name: nombre,
        categoryKey: CATEGORY,
        citySlug,
        phone,
        email,
        metadata: {
          country: "MX",
          authority: "CNSF",
          verified_by_authority: true,
          tipo: "agente-pm",
          direccion: [calle, colonia, cpCiudad].filter(Boolean).join(", "),
          cp_ciudad: cpCiudad,
          sucursales_1: row["sucursales_1"] && row["sucursales_1"] !== "---" ? row["sucursales_1"] : undefined,
          sucursales_2: row["sucursales_2"] && row["sucursales_2"] !== "---" ? row["sucursales_2"] : undefined,
        },
      }),
    );
  }
  console.log(
    `[cnsf-agentes:pm] parsed=${out.length} of ${rows.length} csv rows (dropped=${dropped})`,
  );
  return out;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  // Order: agentes (bulk) → ajustadores → PM. Cumulative cap.
  const agentes = await fetchAgentesCkan(limit);
  out.push(...agentes);
  const remaining1 = Math.max(0, limit - out.length);
  if (remaining1 > 0) {
    const ajust = await fetchAjustadores(remaining1);
    out.push(...ajust);
  }
  const remaining2 = Math.max(0, limit - out.length);
  if (remaining2 > 0) {
    const pm = await fetchPersonaMoral(remaining2);
    out.push(...pm);
  }
  console.log(`[cnsf-agentes] total=${out.length} (cap=${limit})`);
  return out;
}

export const cnsfAgentesEnabled = (): boolean =>
  process.env.PROLIO_RUN_CNSF_AGENTES === "true";

export const cnsfAgentesSource: ScraperSource = {
  name: "cnsf-agentes" as ScrapeSource,
  enabled: cnsfAgentesEnabled,
  async fetch() {
    return [];
  },
};

export async function runCnsfAgentes(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cnsfAgentesEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("cnsf-agentes", async () => {
    const rawLimit = Number(process.env.PROLIO_CNSF_AGENTES_LIMIT ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
    const records = await fetchAll(limit);
    if (records.length === 0)
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
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
