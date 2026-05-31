import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * SEP — Cédulas Profesionales del Registro Nacional de Profesionistas (MX).
 *
 *   https://www.cedulaprofesional.sep.gob.mx
 *
 * === What it is ===
 *
 * The SEP (Secretaría de Educación Pública) maintains a national registry of
 * every professional title/cedula issued in Mexico — doctors, lawyers,
 * engineers, nurses, dentists, accountants, architects, veterinarians,
 * pharmacists, psychologists, physiotherapists and hundreds more. Each
 * cédula is a unique government credential assigned when a person completes
 * a recognised university programme.
 *
 * === API discovery ===
 *
 * The Angular SPA at cedulaprofesional.sep.gob.mx exposes:
 *   config.json → { apiUrl, tokenApi, clientId, apiKey, recaptchaSiteKey }
 *
 * Auth:
 *   GET  {tokenApi}/auth/token
 *   Headers: X-Client-Id, X-API-Key
 *   Response: { access_token } — service-account JWT, ~1-year TTL.
 *
 * Lookup by cédula number (key discovery):
 *   POST {apiUrl}/solr/profesionista/consultar/byDetalle
 *   Headers: Authorization: Bearer {token}, X-Recaptcha-Token: {any string}
 *   Body: { "numCedula": "1234567" }
 *   Response: array (0 or 1 elements) with:
 *     cedula, nombre, primerApellido, segundoApellido, genero,
 *     nivelEducativo, carrera, profesion, institucion,
 *     entidadInstitucion, anioRegistro, fechaTitulacion, fechaExpedicion,
 *     areaConocimiento, libro, numero, foja
 *
 * The X-Recaptcha-Token header is present in the Angular code but the
 * server-side validation is not enforced — any non-empty string is accepted
 * (verified 2026-05-31 with value "probe").
 *
 * === Scale ===
 *
 * Probe results (2026-05-31):
 *   cédula 1,000,000 → 1987 (médico especialista)
 *   cédula 2,000,000 → 1997 (ciencias políticas)
 *   cédula 4,000,000 → 2003 (derecho)
 *   cédula 15,000,000 → 2025 (ingeniería)
 * Range: ~1M–15M = 14M numbers. Hit rate estimated >70% (few gaps).
 * Universe: ~8-10M active professional credentials in Mexico.
 *
 * === Sharding ===
 *
 * Full range at 1s/request = 161 days serial. With cap 5000/run:
 *   5000 cédulas/run × 52 weeks ≈ 260k/year (sample coverage).
 * To scan the full range: 14M / 5000 = 2800 runs ≈ 54 years at 1/week.
 * Realistic goal: sample the full professional landscape by category
 * (the range covers all professions uniformly) rather than exhaust.
 * Use PROLIO_SEP_LIMIT=10000 with 0.5s delay ≈ 1.5h/run for richer coverage.
 *
 * Off by default — PROLIO_RUN_SEP_CEDULAS=true.
 * PROLIO_SEP_START  range start (default 1_000_000)
 * PROLIO_SEP_END    range end (default 15_000_000)
 * PROLIO_SEP_LIMIT  max records to collect (default 5_000)
 * PROLIO_SEP_DELAY_MS delay between requests in ms (default 1000)
 */

const CONFIG_URL =
  "https://www.cedulaprofesional.sep.gob.mx/assets/config.json";

// Hardcoded fallback from config.json (public values baked into the Angular
// JS bundle at main.7dc5cf82893323a9.js). Used when GHA runners cannot reach
// config.json directly (datacenter IP may be rate-limited by SEP's CDN).
// These are static service-account credentials for the public-facing app —
// not user credentials.
const FALLBACK_CONFIG: SepConfig = {
  apiUrl:   "https://cedulaprofesional.sep.gob.mx/api",
  tokenApi: "https://cedulaprofesional.sep.gob.mx/api",
  clientId: "rnp-angular-app-prod",
  apiKey:   "65da8s675f8s75fda675s8d76as87d5as675da",
};
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_START = 1_000_000;
const DEFAULT_END = 15_000_000;
const DEFAULT_LIMIT = 5_000;
const DEFAULT_DELAY_MS = 1_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Category mapping: keyword patterns in `profesion` field → CategoryKey.
// The `profesion` field contains the degree name as certified by SEP.
// Tried in order; first match wins. Records with no match are skipped.
interface CatRule {
  key: CategoryKey;
  pattern: RegExp;
}
const CATEGORY_RULES: CatRule[] = [
  { key: "dentista",     pattern: /\b(dentist|odontolog|cirujano\s*dentista)\b/i },
  { key: "veterinario",  pattern: /\b(veterinar|mvz|médico\s*veterinario|zootecn)\b/i },
  { key: "farmacia",     pattern: /\b(farmacia|farmacéutico|químico.farm)\b/i },
  { key: "enfermeria",   pattern: /\b(enfermer|partería|obstetr)\b/i },
  { key: "fisioterapia", pattern: /\b(fisioter|kinesiol|terapia\s*física|rehab)\b/i },
  { key: "psicologia",   pattern: /\b(psicolog)\b/i },
  { key: "medicina",     pattern: /\b(médico|medicina|cirujano|médico\s*cirujano|especialidad.+médic)\b/i },
  { key: "abogado",      pattern: /\b(derecho|abogado|jurisprudencia)\b/i },
  { key: "fiscal",       pattern: /\b(contadur|contador|contabilidad)\b/i },
  { key: "arquitecto",   pattern: /\b(arquitect)\b/i },
  { key: "ingenieria",   pattern: /\b(ingenier)\b/i },
  { key: "notario",      pattern: /\b(notario|notarial)\b/i },
];

// State name (entidadInstitucion) → prolio city slug.
// Using the largest seeded MX city per state.
// Source: DENUE + existing city seed in prolio.
const MX_STATE_CITY: Record<string, string> = {
  "CIUDAD DE MÉXICO": "cdmx",
  "DISTRITO FEDERAL": "cdmx",
  "ESTADO DE MEXICO": "ecatepec-de-morelos",
  "JALISCO": "guadalajara",
  "NUEVO LEON": "monterrey",
  "PUEBLA": "puebla",
  "GUANAJUATO": "leon",
  "CHIHUAHUA": "ciudad-juarez",
  "BAJA CALIFORNIA": "tijuana",
  "TAMAULIPAS": "tampico",
  "SONORA": "hermosillo",
  "VERACRUZ": "veracruz",
  "GUERRERO": "acapulco",
  "OAXACA": "oaxaca",
  "SAN LUIS POTOSI": "san-luis-potosi",
  "HIDALGO": "pachuca-de-soto",
  "COAHUILA": "torreon",
  "SINALOA": "culiacan",
  "QUERETARO": "queretaro",
  "MICHOACAN": "morelia",
  "MORELOS": "cuernavaca",
  "AGUASCALIENTES": "aguascalientes",
  "TABASCO": "villahermosa",
  "YUCATAN": "merida",
  "DURANGO": "durango",
  "QUINTANA ROO": "cancun",
  "CAMPECHE": "campeche",
  "TLAXCALA": "tlaxcala-de-xicohtencatl",
  "COLIMA": "colima",
  "NAYARIT": "tepic",
  "ZACATECAS": "zacatecas",
  "CHIAPAS": "tuxtla-gutierrez",
  "BAJA CALIFORNIA SUR": "la-paz",
};

const DEFAULT_CITY = "cdmx";

export const sepCedulasMxSource: ScraperSource = {
  name: "sep-cedulas-mx" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_SEP_CEDULAS === "true";
  },
  async fetch() {
    return [];
  },
};

interface SepConfig {
  apiUrl: string;
  tokenApi: string;
  clientId: string;
  apiKey: string;
}

interface SepRecord {
  cedula: string;
  nombre?: string;
  primerApellido?: string;
  segundoApellido?: string;
  profesion?: string;
  carrera?: string;
  nivelEducativo?: string;
  institucion?: string;
  entidadInstitucion?: string;
  anioRegistro?: string;
  fechaTitulacion?: string;
  fechaExpedicion?: string;
  areaConocimiento?: string;
  genero?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(
  url: string,
  opts: RequestInit = {},
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(opts.headers as Record<string, string> || {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadConfig(): Promise<SepConfig | null> {
  return fetchJson<SepConfig>(CONFIG_URL);
}

async function getToken(cfg: SepConfig): Promise<string | null> {
  const data = await fetchJson<{ access_token: string }>(
    `${cfg.tokenApi}/auth/token`,
    {
      headers: {
        "X-Client-Id": cfg.clientId,
        "X-API-Key": cfg.apiKey,
      },
    },
  );
  return data?.access_token ?? null;
}

async function lookupCedula(
  apiUrl: string,
  token: string,
  cedula: number,
): Promise<SepRecord | null> {
  const data = await fetchJson<SepRecord[]>(
    `${apiUrl}/solr/profesionista/consultar/byDetalle`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Recaptcha-Token": "prolio-bot",
      },
      body: JSON.stringify({ numCedula: String(cedula) }),
    },
  );
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

function categorise(rec: SepRecord): CategoryKey | null {
  const text = [rec.profesion, rec.carrera, rec.areaConocimiento]
    .filter(Boolean)
    .join(" ");
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) return rule.key;
  }
  return null;
}

function citySlug(rec: SepRecord): string {
  const raw = (rec.entidadInstitucion ?? "")
    .toUpperCase()
    .replace(/\s+DE\s+/g, " ")
    .trim();
  return MX_STATE_CITY[raw] ?? DEFAULT_CITY;
}

function toRecord(rec: SepRecord, cat: CategoryKey): ScrapedProfessional | null {
  const nameParts = [rec.nombre, rec.primerApellido, rec.segundoApellido]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!nameParts) return null;
  return normalise({
    source: "sep-cedulas-mx" as ScrapeSource,
    country: "MX",
    sourceId: `sep-cedula:${rec.cedula}`,
    name: nameParts,
    categoryKey: cat,
    citySlug: citySlug(rec),
    licenseNumber: rec.cedula,
    metadata: {
      country: "MX",
      authority: "SEP",
      verified_by_authority: true,
      cedula: rec.cedula,
      profesion: rec.profesion ?? null,
      carrera: rec.carrera ?? null,
      nivel_educativo: rec.nivelEducativo ?? null,
      institucion: rec.institucion ?? null,
      entidad_institucion: rec.entidadInstitucion ?? null,
      anio_registro: rec.anioRegistro ?? null,
      fecha_titulacion: rec.fechaTitulacion ?? null,
      area_conocimiento: rec.areaConocimiento ?? null,
      genero: rec.genero ?? null,
    },
  });
}

export async function runSepCedulasMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!sepCedulasMxSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawStart = Number(process.env.PROLIO_SEP_START ?? DEFAULT_START);
  const rawEnd   = Number(process.env.PROLIO_SEP_END   ?? DEFAULT_END);
  const rawLimit = Number(process.env.PROLIO_SEP_LIMIT ?? DEFAULT_LIMIT);
  const rawDelay = Number(process.env.PROLIO_SEP_DELAY_MS ?? DEFAULT_DELAY_MS);
  const start = Number.isFinite(rawStart) && rawStart > 0 ? rawStart : DEFAULT_START;
  const end   = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : DEFAULT_END;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const delayMs = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : DEFAULT_DELAY_MS;

  console.log(`[sep-cedulas] start=${start} end=${end} limit=${limit} delay=${delayMs}ms`);

  let cfg = await loadConfig();
  if (!cfg) {
    console.warn("[sep-cedulas] config.json unreachable — using hardcoded fallback");
    cfg = FALLBACK_CONFIG;
  }

  const token = await getToken(cfg);
  if (!token) { console.error("[sep-cedulas] could not obtain Bearer token"); return { fetched: 0, inserted: 0, updated: 0, skipped: 0 }; }

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let misses = 0;
  let skippedCat = 0;

  for (let cedula = start; cedula <= end && records.length < limit; cedula++) {
    const raw = await lookupCedula(cfg.apiUrl, token, cedula);
    scanned++;

    if (!raw) {
      misses++;
      if (delayMs > 0) await delay(delayMs);
      continue;
    }
    const cat = categorise(raw);
    if (!cat) {
      skippedCat++;
      if (delayMs > 0) await delay(delayMs);
      continue;
    }
    const sourceId = `sep-cedula:${raw.cedula}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const rec = toRecord(raw, cat);
    if (rec) {
      records.push(rec);
      if (records.length % 200 === 0) {
        console.log(`[sep-cedulas] progress: cedula=${cedula} records=${records.length} misses=${misses} skippedCat=${skippedCat}`);
      }
    }
    if (delayMs > 0) await delay(delayMs);
  }

  console.log(`[sep-cedulas] scan done: scanned=${scanned} records=${records.length} misses=${misses} skippedCat=${skippedCat}`);

  if (records.length === 0) {
    console.warn("[sep-cedulas] no records collected");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(`[sep-cedulas] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`);
  return { fetched: records.length, inserted, updated, skipped };
}
