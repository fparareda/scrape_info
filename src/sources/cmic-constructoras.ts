import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * CMIC — Cámara Mexicana de la Industria de la Construcción.
 *
 *   https://www.cmic.org.mx/catalogo/
 *
 * Reality check (auditado 2026-05-13):
 *   - El "Catálogo de Proveedores" público (asociadosvigentes.cfm) lista
 *     **46 empresas vigentes** repartidas en 9 estados. Cada ficha trae
 *     razón social, giro, descripción, vigencia, 1-2 teléfonos, 1-2
 *     correos (ofuscados con Cloudflare email-protection), ciudad,
 *     dirección y, opcionalmente, sitio web.
 *   - Los rumores de "~12,000 constructoras afiliadas" no se materializan
 *     públicamente: ese padrón vive detrás del CRM interno de CMIC y de
 *     las 43 delegaciones estatales — la mayoría sin web pública y las
 *     que la tienen no exponen directorios scrapables (mismo patrón que
 *     FCARM, ver src/sources/fcarm-arquitectos.ts).
 *   - Esta fuente, por tanto, contribuye con ~46 proveedores
 *     verificados por CMIC. Es poco volumen pero de muy alta calidad
 *     (vigencia explícita 2025-2026, contacto directo, dirección).
 *
 * Estructura del HTML (asociadosvigentes.cfm):
 *   - <h1 onClick="mostrar('mostrarestadoN')">ESTADO</h1>     (9 estados)
 *   - dentro de cada estado, una serie de
 *     <div id="ID" class="popup">  ... </div>                  (1 popup = 1 empresa)
 *   - dentro del popup:
 *       <h2 align="center">RAZÓN SOCIAL</h2>
 *       <h1 align="center">GIRO</h1>
 *       <h3>descripción</h3>
 *       Vigencia / Cobertura / Contacto / Ubicación / Sitio web
 *
 * Los emails están protegidos por Cloudflare (`data-cfemail="HEX..."`)
 * y se decodifican con XOR de un byte. Implementado abajo.
 *
 * Off by default. `PROLIO_RUN_CMIC_CONSTRUCTORAS=true`.
 * Cap con `PROLIO_CMIC_CONSTRUCTORAS_LIMIT` (default 15000 — holgado
 * frente a los ~46 reales).
 */

const BASE_URL =
  process.env.PROLIO_CMIC_CONSTRUCTORAS_URL ||
  "https://www.cmic.org.mx/catalogo/asociadosvigentes.cfm";
const DEFAULT_LIMIT = 15_000;
const POLITE_UA =
  "Mozilla/5.0 (compatible; ProlioBot/1.0; +https://prolio.co/bot)";
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Mapping from CMIC delegation/state label to a seeded `citySlug` in
 * src/cities.ts. The state appears in the popup as "Ciudad / Municipio"
 * (free text); we first prefer that, and fall back to the estado
 * header. Unmapped values route to the nearest available capital and
 * the raw original is preserved in metadata.raw_municipio.
 */
const STATE_TO_CITY: Record<string, string> = {
  CHIHUAHUA: "chihuahua",
  "CIUDAD JUAREZ": "ciudad-juarez",
  "CIUDAD JUÁREZ": "ciudad-juarez",
  "CIUDAD DE MEXICO": "cdmx",
  "CIUDAD DE MÉXICO": "cdmx",
  CDMX: "cdmx",
  DURANGO: "torreon", // closest seeded MX city
  "ESTADO DE MEXICO": "tlalnepantla",
  "ESTADO DE MÉXICO": "tlalnepantla",
  TOLUCA: "toluca",
  GUANAJUATO: "leon-mx",
  LEON: "leon-mx",
  LEÓN: "leon-mx",
  "NUEVO LEON": "monterrey",
  "NUEVO LEÓN": "monterrey",
  MONTERREY: "monterrey",
  OAXACA: "cdmx", // no Oaxaca slug seeded
  "SAN LUIS POTOSI": "san-luis-potosi",
  "SAN LUIS POTOSÍ": "san-luis-potosi",
  ZACATECAS: "aguascalientes", // no Zacatecas slug seeded
  AGUASCALIENTES: "aguascalientes",
  GUADALAJARA: "guadalajara",
  JALISCO: "guadalajara",
  PUEBLA: "puebla",
  QUERETARO: "queretaro",
  QUERÉTARO: "queretaro",
  CANCUN: "cancun",
  CANCÚN: "cancun",
  HERMOSILLO: "hermosillo",
  CULIACAN: "culiacan",
  CULIACÁN: "culiacan",
  MAZATLAN: "mazatlan",
  MAZATLÁN: "mazatlan",
  MORELIA: "morelia",
  VILLAHERMOSA: "villahermosa",
  REYNOSA: "reynosa",
  TAMPICO: "tampico",
  ACAPULCO: "acapulco",
  TIJUANA: "tijuana",
  MEXICALI: "mexicali",
  CUERNAVACA: "cuernavaca",
  SALTILLO: "saltillo",
  TORREON: "torreon",
  TORREÓN: "torreon",
  VERACRUZ: "veracruz-mx",
  MERIDA: "merida-mx",
  MÉRIDA: "merida-mx",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function politeFetch(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/html,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[cmic-constructoras] ${res.status} on ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[cmic-constructoras] network ${url}: ${(err as Error).message}`,
    );
    return null;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#43;/g, "+")
    .replace(/&#160;/g, " ")
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&oacute;/g, "ó")
    .replace(/&uacute;/g, "ú")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Decode a Cloudflare email-protection hex blob. The first byte is the
 * XOR key, the rest is the ciphertext. Used on <a class="__cf_email__"
 * data-cfemail="HEX">.
 */
function decodeCfEmail(hex: string): string | undefined {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 4) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  const key = bytes[0];
  let out = "";
  for (let i = 1; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i] ^ key);
  }
  return out;
}

/**
 * Map CMIC `giro` to a Prolio CategoryKey. CMIC giros cover materials,
 * services and trades; we surface only the trades that map to existing
 * Prolio categories. Anything else falls back to "arquitecto" (the
 * closest "construction professional" bucket) so the records still land
 * but are filterable by metadata.especialidad.
 */
function classifyGiro(giro: string): { key: CategoryKey; matched: boolean } {
  const g = giro.toLowerCase();
  // electricidad
  if (/eléctric|electric|alumbrado|cables\s+eléctric/i.test(giro)) {
    return { key: "electricidad", matched: true };
  }
  // fontaneria / hidráulica
  if (/hidr[áa]ulic|fontaner|plomer|sanitari|bomb/i.test(giro)) {
    return { key: "fontaneria", matched: true };
  }
  // hvac
  if (/climatiz|hvac|aire\s+acondicion|refriger|ventila/i.test(giro)) {
    return { key: "hvac", matched: true };
  }
  // arquitectura (default fallback for "construcción", "obra civil",
  // "diseño", "prefabricados", materiales, etc.)
  void g;
  return { key: "arquitecto", matched: false };
}

interface CmicCompany {
  id: string;
  razonSocial: string;
  giro: string;
  description?: string;
  vigenciaInicio?: string;
  vigenciaFin?: string;
  coberturaNacional?: boolean;
  coberturaLocal?: boolean;
  phones: string[];
  emails: string[];
  municipio?: string;
  direccion?: string;
  website?: string;
  delegacionEstatal: string; // estado header in the listing
}

/**
 * Slice the document by `mostrarestadoN` headers and return one chunk
 * per state, with the state name attached. The state header looks like
 * `<h1 class="invert" onClick="mostrar('mostrarestadoN')" ...>+ STATE</h1>`.
 */
function splitByState(html: string): Array<{ state: string; chunk: string }> {
  const headerRe = /<h1\b[^>]*onClick="mostrar\('mostrarestado\d+'\)"[^>]*>([\s\S]*?)<\/h1>/g;
  const headers: Array<{ name: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(html)) !== null) {
    const name = stripTags(m[1])
      .replace(/[+ ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    headers.push({ name, start: m.index, end: m.index + m[0].length });
  }
  const out: Array<{ state: string; chunk: string }> = [];
  for (let i = 0; i < headers.length; i++) {
    const next = i + 1 < headers.length ? headers[i + 1].start : html.length;
    out.push({ state: headers[i].name, chunk: html.slice(headers[i].end, next) });
  }
  return out;
}

/**
 * Walk a chunk of HTML and extract every `<div id="ID" class="popup">`
 * with balanced-div boundaries, so nested <div>s inside the popup
 * (logo wrappers, etc.) don't truncate the slice.
 */
function extractPopups(chunk: string): Array<{ id: string; html: string }> {
  const out: Array<{ id: string; html: string }> = [];
  const startRe = /<div id="(\d+)" class="popup">/g;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(chunk)) !== null) {
    const id = m[1];
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < chunk.length && depth > 0) {
      const nextOpen = chunk.indexOf("<div", i);
      const nextClose = chunk.indexOf("</div>", i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        i = nextOpen + 4;
      } else {
        depth -= 1;
        i = nextClose + 6;
      }
    }
    out.push({ id, html: chunk.slice(m.index, i) });
  }
  return out;
}

function parseCompany(popupHtml: string, state: string, id: string): CmicCompany | null {
  // Razón social: the <h2 align="center"> just before the popup (it's
  // sibling, not inside the popup), but our popup window starts at the
  // popup div. Look in the *enclosing* chunk if not present — caller
  // passes ENRICHED popup with the preceding h2. We instead grab the
  // <h2> from inside the visible card (it appears outside the popup
  // div); recover it via the openPopUp anchor heuristic: in practice
  // each card contains both elements and the same id. We'll search a
  // pre-chunk pattern outside.
  // For robustness, also try inside popup first:
  let razonSocial = "";
  const h2In = popupHtml.match(/<h2[^>]*>([^<]{3,200})<\/h2>/);
  if (h2In) razonSocial = stripTags(h2In[1]);

  // Giro: <h1 align="center"> inside the popup
  let giro = "";
  const h1 = popupHtml.match(/<h1\b[^>]*align="center"[^>]*>([^<]{3,200})<\/h1>/);
  if (h1) giro = stripTags(h1[1]);

  // Description: <h3 ... align="justify">
  let description: string | undefined;
  const h3 = popupHtml.match(/<h3\b[^>]*align="justify"[^>]*>([\s\S]{3,2000}?)<\/h3>/);
  if (h3) description = stripTags(h3[1]) || undefined;

  // Vigencia: two <h2 class="caja" ...>DD-MM-YYYY</h2>
  const fechas = [...popupHtml.matchAll(/<h2[^>]*class="caja"[^>]*>\s*(\d{2}-\d{2}-\d{4})\s*<\/h2>/g)].map(
    (mm) => mm[1],
  );
  const vigenciaInicio = fechas[0];
  const vigenciaFin = fechas[1];

  // Cobertura: nacional/local — look for "X" inside small caja boxes
  // following the literal text "Nacional:" and "Local:".
  const coberturaNacional = /Nacional:[\s\S]{0,400}?<h2[^>]*class="caja"[^>]*>\s*X\s*<\/h2>/i.test(
    popupHtml,
  );
  const coberturaLocal = /Local:[\s\S]{0,400}?<h2[^>]*class="caja"[^>]*>\s*X\s*<\/h2>/i.test(
    popupHtml,
  );

  // Phones: any <h2 class="caja" width="150px">DIGITS</h2> not a date
  const phones: string[] = [];
  const phoneRe = /<h2[^>]*class="caja"[^>]*width:150px[^>]*>\s*([0-9 ()+\-]{7,20})\s*<\/h2>/g;
  let pm: RegExpExecArray | null;
  while ((pm = phoneRe.exec(popupHtml)) !== null) {
    const raw = pm[1].replace(/\s+/g, "").trim();
    if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) continue;
    if (/^[0-9()+\-]{7,20}$/.test(raw)) phones.push(raw);
  }

  // Emails: <a class="__cf_email__" data-cfemail="HEX">
  const emails: string[] = [];
  const emailRe = /data-cfemail="([0-9a-fA-F]+)"/g;
  let em: RegExpExecArray | null;
  while ((em = emailRe.exec(popupHtml)) !== null) {
    const decoded = decodeCfEmail(em[1]);
    if (decoded && /@/.test(decoded)) emails.push(decoded.toLowerCase());
  }

  // Municipio: "Ciudad / Municipio:" followed by a <h2 class="caja">VALUE</h2>
  let municipio: string | undefined;
  const munMatch = popupHtml.match(
    /Ciudad[\s\S]{0,80}?Municipio[\s\S]{0,300}?<h2[^>]*class="caja"[^>]*>([\s\S]{1,120}?)<\/h2>/i,
  );
  if (munMatch) {
    municipio = stripTags(munMatch[1]).replace(/^[\s ]+/, "");
    if (!municipio) municipio = undefined;
  }

  // Dirección: "Dirección:" followed by an <h2 class="caja">VALUE</h2>
  let direccion: string | undefined;
  const dirMatch = popupHtml.match(
    /Direcci[oó]n:[\s\S]{0,300}?<h2[^>]*class="caja"[^>]*>([\s\S]{1,400}?)<\/h2>/i,
  );
  if (dirMatch) {
    direccion = stripTags(dirMatch[1]);
    if (!direccion) direccion = undefined;
  }

  // Sitio web: <a href="URL" target="_blank"> ... <button>Link</button>
  let website: string | undefined;
  const webMatch = popupHtml.match(/href="(https?:\/\/[^"]+)"[^>]*target="_blank"[^>]*>\s*<button/i);
  if (webMatch) website = webMatch[1];

  if (!razonSocial || !giro) return null;

  return {
    id,
    razonSocial,
    giro,
    description,
    vigenciaInicio,
    vigenciaFin,
    coberturaNacional,
    coberturaLocal,
    phones,
    emails,
    municipio,
    direccion,
    website,
    delegacionEstatal: state,
  };
}

/**
 * Razón social sits *outside* the popup, in a sibling <h2> within the
 * surrounding card. Build a pre-index of `openPopUp('ID')` blocks so we
 * can resolve names by id when the popup itself lacks the <h2>.
 */
function buildNameIndex(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Pattern: <a onClick="openPopUp('ID')" ... > ... <h2 align="center">NAME</h2>
  const re =
    /openPopUp\('(\d+)'\)[\s\S]{0,2000}?<h2 align="center">([\s\S]{3,300}?)<\/h2>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!out[m[1]]) out[m[1]] = stripTags(m[2]);
  }
  return out;
}

function citySlugFor(company: CmicCompany): string {
  const candidates = [company.municipio, company.delegacionEstatal];
  for (const c of candidates) {
    if (!c) continue;
    const key = c.toUpperCase().replace(/\s+/g, " ").trim();
    if (STATE_TO_CITY[key]) return STATE_TO_CITY[key];
    // Try without punctuation
    const stripped = key.replace(/[^A-ZÁÉÍÓÚÑ ]/g, "").trim();
    if (STATE_TO_CITY[stripped]) return STATE_TO_CITY[stripped];
  }
  return "cdmx";
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];

  const html = await politeFetch(BASE_URL);
  if (!html) {
    console.warn(`[cmic-constructoras] index unreachable, aborting`);
    return out;
  }
  console.log(`[cmic-constructoras] index OK (${html.length} bytes)`);

  const names = buildNameIndex(html);
  const states = splitByState(html);
  console.log(
    `[cmic-constructoras] states=${states.length} names_indexed=${Object.keys(names).length}`,
  );

  let totalParsed = 0;
  let totalEmitted = 0;
  for (const { state, chunk } of states) {
    const popups = extractPopups(chunk);
    for (const { id, html: phtml } of popups) {
      if (out.length >= limit) break;
      const parsed = parseCompany(phtml, state, id);
      if (!parsed) continue;
      // Backfill name from outer index if popup-internal h2 not present
      if (!parsed.razonSocial && names[id]) parsed.razonSocial = names[id];
      // Prefer outer name index when it gives a longer, more complete value
      if (names[id] && names[id].length > parsed.razonSocial.length) {
        parsed.razonSocial = names[id];
      }
      totalParsed += 1;

      const { key: categoryKey, matched } = classifyGiro(parsed.giro);
      const citySlug = citySlugFor(parsed);
      const sid = `cmic:${id}:${slugify(parsed.razonSocial).slice(0, 40)}`;

      out.push(
        normalise({
          source: "cmic-constructoras" as ScrapeSource,
          country: "MX",
          sourceId: sid,
          name: parsed.razonSocial,
          categoryKey,
          citySlug,
          headline: parsed.giro,
          description: parsed.description,
          email: parsed.emails[0],
          phone: parsed.phones[0],
          website: parsed.website,
          address: parsed.direccion,
          metadata: {
            country: "MX",
            authority: "CMIC",
            verified_by_authority: true,
            cmic_id: id,
            especialidad: parsed.giro,
            categoria_match: matched,
            delegacion_estatal: parsed.delegacionEstatal,
            raw_municipio: parsed.municipio,
            vigencia_inicio: parsed.vigenciaInicio,
            vigencia_fin: parsed.vigenciaFin,
            cobertura_nacional: parsed.coberturaNacional,
            cobertura_local: parsed.coberturaLocal,
            phones: parsed.phones,
            emails: parsed.emails,
            source_url: BASE_URL,
          },
        }),
      );
      totalEmitted += 1;
    }
    if (out.length >= limit) break;
    // Be nice between states even though it's one HTTP request total.
    await sleep(50);
  }

  console.log(
    `[cmic-constructoras] parsed=${totalParsed} emitted=${totalEmitted} states=${states.length}`,
  );

  return out;
}

export const cmicConstructorasEnabled = (): boolean =>
  process.env.PROLIO_RUN_CMIC_CONSTRUCTORAS === "true";

export const cmicConstructorasSource: ScraperSource = {
  name: "cmic-constructoras" as ScrapeSource,
  enabled: cmicConstructorasEnabled,
  async fetch() {
    return [];
  },
};

export async function runCmicConstructoras(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cmicConstructorasEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("cmic-constructoras", async () => {
    const rawLimit = Number(
      process.env.PROLIO_CMIC_CONSTRUCTORAS_LIMIT ?? DEFAULT_LIMIT,
    );
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

/**
 * ---------------------------------------------------------------------
 * CMIC — probe (auditoría 2026-05-13)
 * ---------------------------------------------------------------------
 * URL real:   https://www.cmic.org.mx/catalogo/asociadosvigentes.cfm
 *
 * Estructura: single-page HTML (~480 KB) con 9 acordeones por estado
 * y 46 popups (1 = 1 empresa). Sin paginación, sin API JSON detrás.
 *
 * Distribución por estado:
 *   CHIHUAHUA           1
 *   CIUDAD DE MÉXICO    3
 *   DURANGO             4
 *   ESTADO DE MÉXICO    7
 *   GUANAJUATO         18
 *   NUEVO LEÓN          9
 *   OAXACA              2
 *   SAN LUIS POTOSÍ     1
 *   ZACATECAS           1
 *   ----------------- ----
 *   TOTAL              46
 *
 * Especialidades detectadas (giros) — muestra:
 *   - EQUIPO DE SEGURIDAD OCUPACIONAL
 *   - EXPLORACIÓN GEOFÍSICA
 *   - MATERIALES DE ACERO
 *   - Concreto Hidráulico Premezclado
 *   - Construcciones e instalaciones eléctricas  → electricidad
 *   - Movimiento de tierras, construcción de infraestructura
 *     hidrosanitaria e hidroagrícola              → fontaneria
 *   - Impermeabilizantes, Pinturas, Epóxicos
 *   - Renta y Venta de Maquinaria
 *   - Seguros y Fianzas
 *   - Cal y agregados
 *   - Insumos para Urbanización
 *   - Comercio de artículos para la construcción
 *   - Servicio Logístico de Seguridad y de Ingeniería
 *   - SUMINISTRO DE MATERIALES DE CONSTRUCCION
 *   - DISEÑO Y GESTION DE PERMISOS DE CONSTRUCCION
 *   - VENTA DE MADERA Y TRIPLAY
 *   - Publicidad
 *   - Prefabricados
 *   - Productos derivados del Poliestireno
 *   - Pinturas, Esmaltes, Barnices
 *   - Construcción
 *   - VENTA DE AUTOS, CAMIONETAS Y CAMIONES
 *   - Proyección y construcción de obra de jardinería
 *   - Ingeniería en Seguridad
 *
 * Mapping a CategoryKey (Prolio):
 *   - "Construcciones e instalaciones eléctricas" → electricidad
 *   - "...hidrosanitaria..."                       → fontaneria
 *   - climatización/HVAC                            → hvac (0 hoy)
 *   - resto                                         → arquitecto (default)
 *
 * Probe rows (3 ejemplos auditados):
 *   1. SEGISA CHIHUAHUA, S.A. DE C.V.
 *      giro=EQUIPO DE SEGURIDAD OCUPACIONAL  city=CHIHUAHUA
 *      tels=[6144199517, 6142353444]  web=https://segisa.com.mx/nosotros/
 *      vigencia=28-02-2025 → 28-02-2026
 *   2. EXPLORACION PERFORACION Y ESTUDIOS DEL SUBSUELO
 *      giro=EXPLORACIÓN GEOFÍSICA
 *   3. STRONG SUMINISTROS HIDRAULICOS S.A. DE C.V.
 *      giro=MATERIALES DE ACERO  → fontaneria por "hidráulic" en nombre?
 *      (clasificador usa solo el GIRO, no la razón social → cae a
 *      arquitecto; correcto, ya que vende acero, no fontanería)
 *
 * Limitaciones:
 *   - El catálogo público es minúsculo (46 vs los ~12k afiliados
 *     reales). Las 43 delegaciones estatales con CRM propio quedan
 *     fuera del alcance público; mismo patrón que FCARM.
 *   - Para crecer la huella habría que: a) negociar acceso al padrón
 *     central CMIC (requiere convenio), o b) raspar cada delegación
 *     estatal (muchas sin web o con login). Out of scope para v1.
 *   - Emails están ofuscados con Cloudflare email-protection; se
 *     decodifican localmente con XOR de un byte (sin red).
 */
