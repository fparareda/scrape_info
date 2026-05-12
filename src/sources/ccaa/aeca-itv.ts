import type { ScrapedProfessional } from "../../types.js";
import type { CcaaSource } from "./types.js";
import { normalise, slugify } from "../../normalise.js";

/**
 * AECA-ITV — national directory of every ITV station in Spain.
 *
 * The Asociación Española de Entidades Colaboradoras de la Administración
 * (AECA) maintains a single public page listing all ITV stations by
 * autonomous community. ~400 stations total, fully enumerated, so one
 * HTML fetch gives us 100% category coverage for `itv`.
 *
 * URL: https://www.aeca-itv.com/la-itv/listado-por-comunidades-autonomas/
 *
 * HTML structure (verified): each row is
 *   <tr>
 *     <td>municipio</td>
 *     <td>codigo postal</td>
 *     <td>domicilio</td>
 *     <td>[optional <a href=...>] nombre entidad</td>
 *     <td>nº estacion</td>
 *     <td>lineas</td>
 *     <td>telefono</td>
 *     <td>[optional <a href="mailto:..."> email</td>
 *   </tr>
 *
 * When AECA changes template we'll log "parsed 0 rows" and skip — the
 * orchestrator tolerates an empty return.
 */

const ENDPOINT =
  "https://www.aeca-itv.com/la-itv/listado-por-comunidades-autonomas/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Prolio/0.1";

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#8211;/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

interface Cell {
  text: string;
  href?: string;
}

function extractCells(rowHtml: string): Cell[] {
  const out: Cell[] = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rowHtml)) !== null) {
    const inner = match[1];
    const hrefMatch = inner.match(/href="([^"]+)"/i);
    const href = hrefMatch?.[1];
    out.push({ text: stripTags(inner), href });
  }
  return out;
}

export const aecaItv: CcaaSource = {
  name: "aeca-itv",
  ccaaCode: "ES",
  categories: ["itv"],

  enabled() {
    return process.env.PROLIO_SCRAPE_CCAA === "true";
  },

  async fetch(): Promise<ScrapedProfessional[]> {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "es-ES,es;q=0.9",
        },
      });
    } catch (error) {
      console.error(
        `[aeca-itv] network error: ${(error as Error).message}`,
      );
      return [];
    }
    if (!response.ok) {
      console.error(`[aeca-itv] ${response.status} on ${ENDPOINT}`);
      return [];
    }
    const html = await response.text();
    const out: ScrapedProfessional[] = [];

    // Every row of interest has exactly 8 tds. We reject anything with
    // fewer — headers, colspans, section titles.
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let match: RegExpExecArray | null;
    while ((match = rowRe.exec(html)) !== null) {
      const cells = extractCells(match[1]);
      if (cells.length < 7) continue;

      const municipio = cells[0]?.text ?? "";
      const cp = cells[1]?.text ?? "";
      const direccion = cells[2]?.text ?? "";
      const entidad = cells[3]?.text ?? "";
      const numEstacion = cells[4]?.text ?? "";
      const telefono = (cells[6]?.text ?? "").replace(/\s+/g, "");
      const email = cells[7]?.href?.replace(/^mailto:/i, "");
      const website = cells[3]?.href?.startsWith("http")
        ? cells[3].href
        : undefined;

      // Skip rows that look like section headers (e.g. no municipio or no
      // phone) rather than actual station entries.
      if (!municipio || !entidad || !telefono) continue;
      if (municipio.toLowerCase().includes("localidad")) continue;

      const citySlug = slugify(municipio);
      if (!citySlug) continue;
      const address = [direccion, cp, municipio].filter(Boolean).join(", ");
      const name = entidad.replace(/\s*\([^)]+\)\s*$/, "").trim();

      out.push(
        normalise({
          source: "ccaa_registry",
          sourceId: `aeca-itv:${numEstacion || slugify(`${name}-${municipio}`)}`,
          name: name || entidad,
          categoryKey: "itv",
          citySlug,
          phone: telefono,
          email,
          website,
          address,
          licenseNumber: numEstacion || undefined,
          metadata: {
            registry: "aeca-itv",
            ccaa: "ES",
            station_number: numEstacion,
          },
        }),
      );
    }

    console.log(`[aeca-itv] parsed ${out.length} ITV stations`);
    return out;
  },
};
