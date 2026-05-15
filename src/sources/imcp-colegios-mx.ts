import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * IMCP — Instituto Mexicano de Contadores Públicos (federation fan-out).
 *
 *   https://imcp.org.mx/colegios-federados/
 *
 * Discovery realizado 2026-05-15 contra el índice oficial.
 * El IMCP federa 60 colegios estatales/regionales de contadores
 * públicos en México. Solo ~19-37 tienen sitio web propio; el resto
 * publica solo teléfono.
 *
 * Clasificación de los colegios con web según accesibilidad pública
 * del padrón / directorio de socios:
 *
 *   A · scrapable público (lista de nombres):  2-3
 *        - CCPY (Yucatán)         — junta directiva + equipo
 *        - CCPSLP (San Luis Potosí) — junta directiva con fotos
 *        - CCPEP (Puebla)         — junta directiva en home
 *   B · solo home con consejo directivo:        ~5
 *   C · login wall / portal de socios:          ~8
 *        - CCPAGS, ICPNL, ICCPCH, ICCPS, CCPG, etc.
 *   D · 404 / Cloudflare / DNS roto:            ~5
 *   E · sin web (solo teléfono):                ~23
 *
 * Tabla detallada (colegios con web — 2026-05-15):
 *
 * | Colegio                         | URL                              | Tipo |
 * |---------------------------------|----------------------------------|------|
 * | CCP Yucatán                     | ccpy.com.mx/directorio           | A    |
 * | CCP San Luis Potosí             | ccpslp.org.mx/directorio         | A    |
 * | CCP Puebla                      | ccpep.org.mx                     | A/B  |
 * | CCP Yucatán (alt)               | ccpy.com.mx                      | A    |
 * | CCP México (CDMX)               | contadoresmexico.org.mx          | B/C  |
 * | CCP Guadalajara                 | ccpg.org.mx                      | B/C  |
 * | CCP Aguascalientes              | ccpags.com.mx                    | C    |
 * | ICP Nuevo León                  | icpnl.org.mx                     | C    |
 * | ICCP Chihuahua                  | iccpch.mx                        | C    |
 * | ICCP Sinaloa                    | iccps.org.mx                     | C    |
 * | CCP Querétaro                   | ccpq.com.mx → ccpq.org           | C    |
 * | CCP Baja California             | imcpbc.org                       | D    |
 * | CCP Sonora                      | ccpdesonora.org                  | D    |
 * | CCP Colima                      | ccpcolima.org                    | D    |
 * | CCP Durango                     | imcpdgo.org                      | D    |
 * | CCP Zacatecas                   | imcpz.org.mx                     | D    |
 * | CCP Cancún                      | ccpcancun.org.mx                 | D    |
 * | CCP Xalapa                      | ccpx.edu.mx                      | D    |
 * | CCP Michoacán                   | ccpmich.com                      | D    |
 * | CCP Morelos                     | contadoresdemorelos.com          | D    |
 * | CCP Valle de Toluca             | imcptoluca.com                   | D    |
 *
 * Volumen máximo realista sin login ≈ 30-80 nombres (mayoría junta
 * directiva). Los colegios "C" exigirían cuenta IMCP.
 *
 * Off by default. `PROLIO_RUN_IMCP_COLEGIOS_MX=true`.
 * Cap with `PROLIO_IMCP_COLEGIOS_MX_LIMIT` (default 1000).
 */

const BASE_URL =
  process.env.PROLIO_IMCP_COLEGIOS_MX_URL ||
  "https://imcp.org.mx/colegios-federados/";
const DEFAULT_LIMIT = 1_000;
const POLITE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CATEGORY: CategoryKey = "fiscal";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type ColegioSeed = {
  name: string;
  url: string;
  citySlug: string;
  rawState: string;
  /** Optional directory subpath to try in addition to the home. */
  directoryPaths?: string[];
};

const SEED_COLEGIOS: ColegioSeed[] = [
  // === Type A: public scrapable directory (junta directiva + equipo) ===
  {
    name: "Colegio de Contadores Públicos de Yucatán",
    url: "https://ccpy.com.mx/",
    citySlug: "merida",
    rawState: "Yucatán",
    directoryPaths: ["directorio", "directorio/"],
  },
  {
    name: "Colegio de Contadores Públicos de San Luis Potosí",
    url: "https://ccpslp.org.mx/",
    citySlug: "san-luis-potosi",
    rawState: "San Luis Potosí",
    directoryPaths: ["directorio", "directorio/", "consejo-directivo/"],
  },
  {
    name: "Colegio de Contadores Públicos del Estado de Puebla",
    url: "https://ccpep.org.mx/",
    citySlug: "puebla",
    rawState: "Puebla",
    directoryPaths: ["consejo-directivo/", "junta-directiva/"],
  },
  // === Type B: home only — generic extractor pulls junta directiva ===
  {
    name: "Colegio de Contadores Públicos de México",
    url: "https://contadoresmexico.org.mx/",
    citySlug: "cdmx",
    rawState: "Ciudad de México",
    directoryPaths: ["consejo-directivo/"],
  },
  {
    name: "Colegio de Contadores Públicos de Guadalajara",
    url: "https://ccpg.org.mx/",
    citySlug: "guadalajara",
    rawState: "Jalisco",
    directoryPaths: ["consejo-directivo/"],
  },
  {
    name: "Instituto de Contadores Públicos de Nuevo León",
    url: "https://icpnl.org.mx/",
    citySlug: "monterrey",
    rawState: "Nuevo León",
  },
  {
    name: "Colegio de Contadores Públicos de Aguascalientes",
    url: "https://ccpags.com.mx/",
    citySlug: "aguascalientes",
    rawState: "Aguascalientes",
  },
  {
    name: "Instituto y Colegio de Contadores Públicos de Chihuahua",
    url: "https://iccpch.mx/",
    citySlug: "chihuahua",
    rawState: "Chihuahua",
  },
  // === Type C/D: kept for documentation; many return 403/404/CF errors.
  //     Fetcher will attempt and just skip on failure (politeFetch returns null).
  // { name: "CCP Sonora",  url: "https://ccpdesonora.org/",  citySlug: "hermosillo", rawState: "Sonora" },
  // { name: "CCP Colima",  url: "https://ccpcolima.org/",    citySlug: "colima",     rawState: "Colima" },
  // { name: "CCP Durango", url: "https://imcpdgo.org/",      citySlug: "durango",    rawState: "Durango" },
];

async function politeFetch(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[imcp-colegios-mx] ${res.status} on ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[imcp-colegios-mx] network ${url}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Generic CPA extractor — looks for accountant name prefixes
 * (C.P., C.P.C., L.C., L.C.P., M.I., M.A., Dr.) followed by a name.
 *
 * Examples to match:
 *   C.P.C. y M.I. Alejandro José Ontiveros Gómez
 *   C.P. Álvaro Enrique Traconis Flores
 *   Dra y C.P.C. Guadalupe Izanamí Viera Bustos
 *   L.C.P. Juan Pérez García
 */
function extractMembers(html: string): Array<{ name: string; role?: string }> {
  const out: Array<{ name: string; role?: string }> = [];
  const seen = new Set<string>();
  const NAME_RE =
    /(?:(?:Dr\.?a?|Mtra?\.?)\s+y\s+)?(?:C\.?P\.?C\.?|C\.?P\.?|L\.?C\.?P\.?|L\.?C\.?|M\.?I\.?|M\.?A\.?|P\.?C\.?P\.?L\.?D\.?A\.?)\s+(?:y\s+(?:M\.?I\.?|M\.?A\.?|C\.?P\.?C\.?|P\.?C\.?P\.?L\.?D\.?A\.?)\s+)?([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.]+){1,5})/g;
  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(html)) !== null) {
    const name = m[1].trim().replace(/\s+/g, " ");
    if (name.length < 8) continue;
    if (name.split(" ").length < 2) continue;
    // Reject common false positives (page headings, etc.)
    if (/^(Consejo|Directorio|Junta|Mesa|Comité|Equipo|Socios)/i.test(name))
      continue;
    if (seen.has(name)) continue;
    seen.add(name);
    // Pull surrounding role hint (Presidente, Vicepresidente, etc.)
    const ctx = html.slice(Math.max(0, m.index - 200), m.index + 400);
    const roleMatch = ctx.match(
      /\b(Presidente|Vicepresidente|Secretario|Tesorero|Vocal|Gerente|Coordinador(?:a)?|Director(?:a)?)\b[^<]{0,80}/i,
    );
    out.push({ name, role: roleMatch?.[0]?.trim() });
  }
  return out;
}

function urlJoin(base: string, path: string): string {
  if (path.startsWith("http")) return path;
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const indexHtml = await politeFetch(BASE_URL);
  if (indexHtml) {
    console.log(`[imcp-colegios-mx] index OK (${indexHtml.length} bytes)`);
  } else {
    console.warn(`[imcp-colegios-mx] index unreachable, falling back to seed`);
  }

  for (const colegio of SEED_COLEGIOS) {
    if (out.length >= limit) break;

    // Build the list of URLs to try: home + any directory subpaths.
    const urls = [colegio.url];
    for (const p of colegio.directoryPaths ?? []) {
      urls.push(urlJoin(colegio.url, p));
    }

    const memberByName = new Map<string, { name: string; role?: string }>();
    for (const u of urls) {
      await sleep(REQUEST_DELAY_MS);
      const html = await politeFetch(u);
      if (!html) continue;
      const members = extractMembers(html);
      for (const m of members) {
        if (!memberByName.has(m.name)) memberByName.set(m.name, m);
      }
    }

    let added = 0;
    for (const member of memberByName.values()) {
      if (out.length >= limit) break;
      const sid = `imcp:${colegio.citySlug}:${slugify(member.name)}`;
      out.push(
        normalise({
          source: "imcp-colegios-mx" as ScrapeSource,
          sourceId: sid,
          name: member.name,
          categoryKey: CATEGORY,
          citySlug: colegio.citySlug,
          website: colegio.url,
          metadata: {
            country: "MX",
            authority: "IMCP",
            verified_by_authority: true,
            colegio_estatal: colegio.name,
            raw_state: colegio.rawState,
            role: member.role,
          },
        }),
      );
      added += 1;
    }
    console.log(
      `[imcp-colegios-mx] colegio=${colegio.citySlug} parsed=${memberByName.size} added=${added}`,
    );
  }

  return out;
}

export const imcpColegiosMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_IMCP_COLEGIOS_MX === "true";

export const imcpColegiosMxSource: ScraperSource = {
  name: "imcp-colegios-mx" as ScrapeSource,
  enabled: imcpColegiosMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runImcpColegiosMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!imcpColegiosMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("imcp-colegios-mx", async () => {
    const rawLimit = Number(
      process.env.PROLIO_IMCP_COLEGIOS_MX_LIMIT ?? DEFAULT_LIMIT,
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
