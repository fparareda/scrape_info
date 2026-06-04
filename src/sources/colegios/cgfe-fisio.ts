import type { ScrapedProfessional } from "../../types.js";
import { normalise } from "../../normalise.js";

/**
 * CGFE — Consejo General de Fisioterapeutas de España.
 * National census of all registered physiotherapists in Spain.
 *
 *   https://www.consejo-fisioterapia.org/vu_colegiados/pag_N.html
 *
 * Pre-flight 2026-06-04 (datacenter IP):
 *   HTTP 200, static HTML, no auth, no JS rendering.
 *   2,309 paginated pages × ~30 rows = ~69,270 colegiados.
 *   Pagination: clean GET /vu_colegiados/pag_N.html (1-based).
 *   Columns: Colegio | Nº Colegiado | Nombre completo
 *
 * City mapping: derived from the colegio name (autonomía).
 * SourceId: cgfe:{colegio_key}:{numero}
 *
 * Category: fisioterapia. Country: ES.
 */

const BASE_URL = "https://www.consejo-fisioterapia.org/vu_colegiados/pag_";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// Map colegio name patterns → {citySlug, key}
interface ColegioMapping {
  key: string;
  citySlug: string;
}

function colegioToMapping(name: string): ColegioMapping {
  const n = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (n.includes("andalucia") || n.includes("andalusia")) return { key: "and", citySlug: "sevilla" };
  if (n.includes("aragon")) return { key: "ara", citySlug: "zaragoza" };
  if (n.includes("asturias") || n.includes("asturias")) return { key: "ast", citySlug: "oviedo" };
  if (n.includes("baleares") || n.includes("illes balears")) return { key: "bal", citySlug: "palma" };
  if (n.includes("canarias")) return { key: "can", citySlug: "las-palmas-de-gran-canaria" };
  if (n.includes("cantabria")) return { key: "cnt", citySlug: "santander" };
  if (n.includes("castilla y leon") || n.includes("castilla-leon") || n.includes("castilla la mancha") || n.includes("castilla-la mancha")) {
    if (n.includes("leon")) return { key: "cyl", citySlug: "valladolid" };
    return { key: "clm", citySlug: "toledo" };
  }
  if (n.includes("castilla")) {
    if (n.includes("la mancha")) return { key: "clm", citySlug: "toledo" };
    return { key: "cyl", citySlug: "valladolid" };
  }
  if (n.includes("catalun") || n.includes("catalonia") || n.includes("catalunya")) return { key: "cat", citySlug: "barcelona" };
  if (n.includes("extremadura")) return { key: "ext", citySlug: "badajoz" };
  if (n.includes("galicia")) return { key: "gal", citySlug: "vigo" };
  if (n.includes("madrid")) return { key: "mad", citySlug: "madrid" };
  if (n.includes("murcia")) return { key: "mur", citySlug: "murcia" };
  if (n.includes("navarra") || n.includes("nafarroa")) return { key: "nav", citySlug: "pamplona" };
  if (n.includes("pais vasco") || n.includes("euskadi") || n.includes("bizkaia")) return { key: "pv", citySlug: "bilbao" };
  if (n.includes("rioja")) return { key: "rio", citySlug: "logrono" };
  if (n.includes("valencian") || n.includes("valencia")) return { key: "val", citySlug: "valencia" };
  if (n.includes("ceuta")) return { key: "ceu", citySlug: "ceuta" };
  if (n.includes("melilla")) return { key: "mel", citySlug: "melilla" };
  return { key: "es", citySlug: "madrid" }; // fallback
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

interface CgfeRow {
  colegio: string;
  numero: string;
  nombre: string;
}

function parseRows(html: string): CgfeRow[] {
  const out: CgfeRow[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  for (const tr of html.matchAll(trRe)) {
    const cells: string[] = [];
    for (const td of tr[1].matchAll(tdRe)) cells.push(stripTags(td[1]));
    if (cells.length < 3) continue;
    const colegio = cells[0];
    const numero = cells[1];
    const nombre = cells[2];
    if (!nombre || !numero || !colegio) continue;
    out.push({ colegio, numero, nombre });
  }
  return out;
}

async function fetchPage(pageNum: number): Promise<CgfeRow[]> {
  const url = `${BASE_URL}${pageNum}.html`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseRows(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCgfeFisio(
  limit: number,
  maxPages?: number,
): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let page = 1;
  const totalPages = maxPages ?? 2310;

  while (out.length < limit && page <= totalPages) {
    const rows = await fetchPage(page);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (out.length >= limit) break;
      const { key, citySlug } = colegioToMapping(r.colegio);
      const sourceId = `cgfe:${key}:${r.numero}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      out.push(
        normalise({
          source: "colegio",
          country: "ES",
          sourceId,
          name: r.nombre,
          categoryKey: "fisioterapia",
          citySlug,
          licenseNumber: r.numero || undefined,
          metadata: {
            country: "ES",
            authority: "CGFE (Consejo General de Fisioterapeutas de España)",
            verified_by_authority: true,
            colegio: r.colegio,
            numero_colegiado: r.numero || null,
          },
        }),
      );
    }
    if (page % 100 === 0) {
      console.log(`[cgfe-fisio] page=${page} accumulated=${out.length}`);
    }
    page += 1;
    // Small delay to avoid hammering the server
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`[cgfe-fisio] done pages=${page - 1} records=${out.length}`);
  return out;
}
