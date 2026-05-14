import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * CONACEM — Consejo Mexicano de Certificación de Especialidades
 * Médicas. Organismo decano que agrupa 47 consejos federados de
 * especialidades médicas (Anestesiología, Ginecología, Cirugía
 * General, Medicina Interna, etc.). Tras pasar el examen de su
 * consejo, los médicos obtienen una "certificación vigente" que el
 * portal de CONACEM permite verificar uno a uno.
 *
 *   Landing:   https://www.conacem.org.mx/
 *   Buscador:  https://www.conacem.org.mx/buscador
 *   Consejos:  https://conacem.org.mx/catalogo-consejos
 *
 * Universe estimado: ~80,000 especialistas con certificación vigente
 * (referencia interna del propio portal en la sección /tablero).
 *
 * ---------------------------------------------------------------------
 * BLOQUEO — el buscador NO es scrapable hoy (auditoría 2026-05-14)
 * ---------------------------------------------------------------------
 *
 * El frontend (Nuxt 3 SPA) llama dos endpoints internos:
 *
 *   GET /api/buscador/consejos
 *        → catálogo de 47 consejos con sus especialidades
 *
 *   GET /api/buscador/medico-especialista/
 *          {consejoId}/{especialidadId}/{cursorId}/{direction}/{nombre}
 *        → resultados paginados (apellido paterno, materno, nombre,
 *          consejo, especialidad, vigencia)
 *
 * Ambos endpoints son **un proxy SSR de Nuxt** sobre un backend Flask
 * en `127.0.0.1:5000/api/v1/buscador/*`. El backend rechaza
 * cualquier llamada que no provenga del propio servidor SSR con un
 * header/token compartido que NO se filtra al cliente:
 *
 *   $ curl https://www.conacem.org.mx/api/buscador/consejos
 *     {"statusCode":502,
 *      "message":"Error al consultar API: [GET]
 *                 \"http://127.0.0.1:5000/api/v1/buscador/consejos\":
 *                 403 FORBIDDEN"}
 *
 *   $ curl .../api/buscador/medico-especialista/0/0/0/next/garcia
 *     {"statusCode":403, "message":"Acceso denegado"}
 *
 * Probado con cookies de sesión, User-Agent de Chrome, Origin/Referer
 * `https://www.conacem.org.mx/buscador`, Sec-Fetch-*: mismo 502/403.
 * El bundle Nuxt cliente (`/_nuxt/CZq2Jjbf.js` + chunks) no contiene
 * api-key, token, ni firma — porque la inyecta el servidor Nuxt en
 * caliente antes de proxy-ear al backend Flask. Sin acceso al runtime
 * SSR no hay forma de replicarlo.
 *
 * No hay alternativa pública:
 *   - El listado /catalogo-consejos solo enumera los 47 consejos
 *     (nombre de la asociación), no expone padrones.
 *   - El subdominio certeza.conacem.org.mx es la revista institucional,
 *     no contiene directorio.
 *   - /__nuxt_content/consejos/sql_dump.txt existe pero solo dumpea
 *     la tabla de consejos (4 KB comprimidos), no los especialistas.
 *   - Las webs individuales de los 47 consejos federados no
 *     exponen padrones públicos navegables (auditado por muestra:
 *     CMGO, CMCG, AMIMC, CONAMEGE — todos requieren login o redirigen
 *     a CONACEM).
 *
 * Cobertura efectiva por otras fuentes de este repo:
 *   - `competitor-mx-doctoralia` cubre médicos privados con perfil
 *     público en Doctoralia MX (no necesariamente certificados).
 *   - `senasica-mx-vet` cubre veterinarios (otro registro).
 *   - El padrón certificado de CONACEM queda fuera hasta que:
 *       a) negociemos un convenio con CONACEM (acceso vía partner),
 *       b) un futuro adaptador Playwright resuelva el flujo SSR
 *          (presumiblemente bypasseando el header server-only via
 *           render del propio buscador y captura de window.__NUXT__),
 *       c) liberen una API pública.
 *
 * Patrón análogo en este repo: ver `fcarm-arquitectos.ts` (federación
 * MX con padrón inaccesible) y `cmic-constructoras.ts` (catálogo
 * público diminuto vs realidad). Mantenemos el stub para no perder
 * el research y reactivar fácilmente cuando alguno de a/b/c se cumpla.
 *
 * Off by default. `PROLIO_RUN_CONACEM_MX=true`.
 * Cap con `PROLIO_CONACEM_MX_LIMIT` (default 80000).
 */

const BASE_URL =
  process.env.PROLIO_CONACEM_MX_URL || "https://www.conacem.org.mx/buscador";
const DEFAULT_LIMIT = 80_000;
const CATEGORY: CategoryKey = "medicina";
void CATEGORY;
void BASE_URL;

/**
 * Catálogo de los 47 consejos federados (orden y nombres exactos
 * publicados en https://conacem.org.mx/catalogo-consejos, audit
 * 2026-05-14). Se mantiene aquí para referencia y para que un futuro
 * extractor pueda iterar `consejoId` 1..47 directamente cuando el
 * bloqueo SSR se levante. No se golpea hoy en runtime.
 */
const CONSEJOS_FEDERADOS_REF: ReadonlyArray<string> = [
  "Consejo Nacional de Certificación en Anestesiología, A.C.",
  "Consejo Mexicano de Angiología, Cirugía Vascular y Endovascular, A.C.",
  "Consejo Mexicano de Médicos Anatomopatólogos, A.C.",
  "Consejo Mexicano de Comunicación, Audiología, Otoneurología y Foniatría, A.C.",
  "Consejo Mexicano de Cardiología, A.C.",
  "Consejo Mexicano de Cirugía General, A.C.",
  "Consejo Mexicano de Cirugía Oral y Maxilofacial, A.C.",
  "Consejo Mexicano de Cirugía Neurológica, A.C.",
  "Consejo Mexicano de Cirugía Pediátrica, A.C.",
  "Consejo Mexicano de Cirugía Plástica, Estética y Reconstructiva, A.C.",
  "Consejo Nacional de Cirugía del Tórax, A.C.",
  "Consejo Mexicano de Dermatología, A.C.",
  "Consejo Mexicano de Endocrinología, A.C.",
  "Consejo Mexicano de Especialistas en Coloproctología, A.C.",
  "Consejo Mexicano de Gastroenterología, A.C.",
  "Consejo Mexicano de Genética, A.C.",
  "Consejo Mexicano de Geriatría, A.C.",
  "Consejo Mexicano de Ginecología y Obstetricia, A.C.",
  "Consejo Mexicano de Hematología, A.C.",
  "Consejo Mexicano de Certificación en Infectología, A.C.",
  "Consejo Nacional de Inmunología Clínica y Alergia, A.C.",
  "Consejo Mexicano de Medicina Aeroespacial, A.C.",
  "Consejo Mexicano de Medicina Crítica, A.C.",
  "Consejo Nacional de Medicina del Deporte, A.C.",
  "Consejo Mexicano de Certificación en Medicina Familiar, A.C.",
  "Consejo Mexicano de Medicina Interna, A.C.",
  "Consejo Mexicano de Medicina Legal y Forense, A.C.",
  "Consejo Mexicano de Medicina de Rehabilitación, A.C.",
  "Consejo Nacional Mexicano de Medicina del Trabajo, A.C.",
  "Consejo Mexicano de Medicina de Urgencias, A.C.",
  "Consejo Mexicano de Medicina Nuclear e Imagen Molecular, A.C.",
  "Consejo Mexicano de Nefrología, A.C.",
  "Consejo Nacional de Neumología, A.C.",
  "Consejo Mexicano de Neurofisiología Clínica, A.C.",
  "Consejo Mexicano de Neurología, A.C.",
  "Consejo Mexicano de Oftalmología, A.C.",
  "Consejo Mexicano de Oncología, A.C.",
  "Consejo Mexicano de Ortopedia y Traumatología, A.C.",
  "Consejo Mexicano de Otorrinolaringología y Cirugía de Cabeza y Cuello, A.C.",
  "Consejo Mexicano de Patología Clínica y Medicina de Laboratorio, A.C.",
  "Consejo Mexicano de Certificación en Pediatría, A.C.",
  "Consejo Mexicano de Psiquiatría, A.C.",
  "Consejo Mexicano de Radiología e Imagen, A.C.",
  "Consejo Mexicano de Certificación en Radioterapia, A.C.",
  "Consejo Mexicano de Reumatología, A.C.",
  "Consejo Nacional de Salud Pública, A.C.",
  "Consejo Nacional Mexicano de Urología, A.C.",
];
void CONSEJOS_FEDERADOS_REF;

async function fetchAll(_limit: number): Promise<ScrapedProfessional[]> {
  console.warn(
    `[conacem-mx] BLOCKED — el buscador requiere un token server-only ` +
      `inyectado por el SSR Nuxt. Sin acceso al runtime no podemos ` +
      `reproducirlo. Ver header del fichero para detalles. Salimos sin ` +
      `tocar la red.`,
  );
  return [];
}

export const conacemMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_CONACEM_MX === "true";

export const conacemMxSource: ScraperSource = {
  name: "conacem-mx" as ScrapeSource,
  enabled: conacemMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runConacemMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!conacemMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("conacem-mx", async () => {
    const rawLimit = Number(process.env.PROLIO_CONACEM_MX_LIMIT ?? DEFAULT_LIMIT);
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
 * CONACEM — probe (auditoría 2026-05-14)
 * ---------------------------------------------------------------------
 *
 *   GET  https://www.conacem.org.mx/buscador            HTTP 200 (HTML SPA)
 *   GET  https://conacem.org.mx/catalogo-consejos       HTTP 200 (47 consejos)
 *   GET  /api/buscador/consejos                         HTTP 502 (proxy → backend 403)
 *   GET  /api/buscador/medico-especialista/0/0/0/next/garcia
 *                                                       HTTP 403 ("Acceso denegado")
 *   GET  /__nuxt_content/consejos/sql_dump.txt          HTTP 200 (~2.7 KB, gzip+base64;
 *                                                                 solo tabla de consejos)
 *
 * Estrategia A (buscador central A-Z):  bloqueada por el 403 del backend
 *                                       Flask. No replicable sin token
 *                                       server-only.
 * Estrategia B (47 consejos):            inviable — los consejos
 *                                       federados no publican padrones.
 *
 * Probe rows: 0 (ningún endpoint público devuelve filas de especialistas
 * sin el token SSR). Esperado.
 *
 * Reactivación: cuando CONACEM libere API pública o se sume un
 * adaptador Playwright que renderice el buscador en navegador
 * headless (capturando window.__NUXT__.state tras submit), poblar
 * `fetchAll` con un loop sobre `CONSEJOS_FEDERADOS_REF` × A..Z.
 */
