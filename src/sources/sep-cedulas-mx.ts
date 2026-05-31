import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeSource,
} from "../types.js";

/**
 * SEP — Cédulas Profesionales del Registro Nacional de Profesionistas (MX).
 *   STUB — API data endpoint blocked from GHA datacenter IPs.
 *
 *   https://www.cedulaprofesional.sep.gob.mx
 *
 * === What it is ===
 *
 * The SEP maintains a national registry of every professional title/cédula
 * issued in Mexico (~8-10M active credentials): doctors, lawyers, engineers,
 * nurses, dentists, accountants, architects, veterinarians, pharmacists,
 * psychologists, physiotherapists and hundreds more. Cédula numbers are
 * sequential integers (~1,000,000–15,000,000, >70% hit rate).
 *
 * === API (public, no user auth) ===
 *
 * config.json → { apiUrl, tokenApi, clientId, apiKey }
 * Token:  GET {tokenApi}/auth/token  (X-Client-Id + X-API-Key headers)
 *   → Bearer JWT, ~1-year TTL
 * Lookup: POST {apiUrl}/solr/profesionista/consultar/byDetalle
 *   Body: { numCedula: "1234567" }
 *   Headers: Authorization: Bearer {token}, X-Recaptcha-Token: {any string}
 *   Response: [{ cedula, nombre, primerApellido, segundoApellido, profesion,
 *               carrera, nivelEducativo, institucion, entidadInstitucion,
 *               anioRegistro, fechaTitulacion, areaConocimiento, genero }]
 *
 * Probe 2026-05-31 (residential IP):
 *   cédula 1,000,000 → Sergio Barajas | Cirugía de urgencia | 1987
 *   cédula 4,000,000 → Alfonso Gonzalez | Licenciatura en Derecho | 2003
 *   cédula 15,000,000 → Laura Veronica Tlatelpa | Ing. Tecnología | 2025
 *
 * === Why this is a STUB ===
 *
 * Two GHA runs confirmed the data endpoint is blocked from Azure egress IPs:
 *   - Run 26710851294: token was injected via PROLIO_SEP_BEARER_TOKEN secret
 *     (token endpoint also blocked from GHA), but all POST calls to the Solr
 *     search endpoint timed out at 20s × 5000 attempts = cancelled at 2h.
 *   - Same pattern as 411.ca: works from residential IP, 403/timeout from
 *     Azure datacenter ranges.
 *
 * The full implementation (category rules, state→city map, sequential
 * enumeration with configurable start/end/limit) lives in git history at
 * commit 776a596 and can be wired back in ~5 min.
 *
 * === Restore options ===
 *
 * 1. Self-hosted GHA runner on a residential/office connection.
 * 2. Residential proxy (Bright Data / Oxylabs) — same solution as 411.ca.
 * 3. Local bulk run: tsx src/sources/sep-cedulas-mx.ts from a non-datacenter
 *    machine with PROLIO_SEP_BEARER_TOKEN + PROLIO_RUN_SEP_CEDULAS=true.
 *    The token can be refreshed with one curl command (see commit 616463a).
 *
 * Off by default — PROLIO_RUN_SEP_CEDULAS=true.
 */

const SOURCE_NAME = "sep-cedulas-mx" as ScrapeSource;

export const sepCedulasMxSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_SEP_CEDULAS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runSepCedulasMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!sepCedulasMxSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  console.log(
    "[sep-cedulas] STUB — SEP API /solr/profesionista/consultar/byDetalle " +
      "times out from GHA datacenter IPs. Full implementation at commit " +
      "776a596; restore when residential proxy or self-hosted runner lands. " +
      "Token (1-year) stored in PROLIO_SEP_BEARER_TOKEN secret.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
