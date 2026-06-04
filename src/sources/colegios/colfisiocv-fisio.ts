import type { ScrapedProfessional } from "../../types.js";
import { normalise } from "../../normalise.js";

/**
 * COLFISIOCV — Col·legi de Fisioterapeutes de la Comunitat Valenciana.
 *
 *   https://www.colfisiocv.com/node/26074?page=N
 *
 * Pre-flight 2026-06-04 (datacenter IP):
 *   HTTP 200, static HTML, no auth, no JS rendering.
 *   199 pages (0-indexed) × ~20 rows = ~3,960 fisioterapeutas.
 *   Pagination: GET via ?page=N (0-based).
 *   Columns: Tipo (ej/co/no) | Número | Nombre | Apellidos | Provincia
 *     Tipo: ej=ejerciente, co=colaborador, no=no ejerciente
 *     Provincias: Valencia / Alicante / Castellón
 *
 * City mapping by province.
 * SourceId: colfisiocv:{numero}
 * Category: fisioterapia. Country: ES.
 */

const BASE_URL = "https://www.colfisiocv.com/node/26074?page=";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const PROVINCE_TO_CITY: Record<string, string> = {
  valencia: "valencia",
  alicante: "alicante",
  castellon: "castellon-de-la-plana",
  castellón: "castellon-de-la-plana",
};

function provinceToCity(province: string): string {
  const key = province
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return PROVINCE_TO_CITY[key] ?? "valencia";
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

interface ColfisiocvRow {
  tipo: string;
  numero: string;
  nombre: string;
  apellidos: string;
  provincia: string;
}

function parseRows(html: string): ColfisiocvRow[] {
  const out: ColfisiocvRow[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  for (const tr of html.matchAll(trRe)) {
    const cells: string[] = [];
    for (const td of tr[1].matchAll(tdRe)) cells.push(stripTags(td[1]));
    if (cells.length < 5) continue;
    const tipo = cells[0];
    const numero = cells[1];
    const nombre = cells[2];
    const apellidos = cells[3];
    const provincia = cells[4];
    if (!nombre && !apellidos) continue;
    if (nombre.toLowerCase().includes("nombre")) continue; // header row
    out.push({ tipo, numero, nombre, apellidos, provincia });
  }
  return out;
}

async function fetchPage(pageNum: number): Promise<ColfisiocvRow[] | null> {
  const url = `${BASE_URL}${pageNum}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const rows = parseRows(html);
    // If page has no data rows, we've gone past the end
    if (rows.length === 0) return null;
    return rows;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchColfisiocvFisio(
  limit: number,
): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let page = 0;

  while (out.length < limit) {
    const rows = await fetchPage(page);
    if (rows === null) break;
    for (const r of rows) {
      if (out.length >= limit) break;
      const sourceId = `colfisiocv:${r.numero}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      const name = `${r.nombre} ${r.apellidos}`.trim();
      const citySlug = provinceToCity(r.provincia);
      out.push(
        normalise({
          source: "colegio",
          country: "ES",
          sourceId,
          name,
          categoryKey: "fisioterapia",
          citySlug,
          licenseNumber: r.numero || undefined,
          metadata: {
            country: "ES",
            province: "CV",
            authority: "COLFISIOCV (Col·legi de Fisioterapeutes de la Comunitat Valenciana)",
            verified_by_authority: true,
            numero_colegiado: r.numero || null,
            tipo_colegiado: r.tipo || null,
          },
        }),
      );
    }
    if (page % 50 === 0 && page > 0) {
      console.log(`[colfisiocv-fisio] page=${page} accumulated=${out.length}`);
    }
    page += 1;
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`[colfisiocv-fisio] done pages=${page} records=${out.length}`);
  return out;
}
