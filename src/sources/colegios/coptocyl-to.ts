import type { ScrapedProfessional } from "../../types.js";
import { normalise } from "../../normalise.js";

/**
 * COPTOCYL — Colegio de Terapeutas Ocupacionales de Castilla y León.
 *
 *   https://coptocyl.com/listado-de-colegiados/
 *
 * Pre-flight 2026-06-04 (datacenter IP):
 *   HTTP 200, 440 KB HTML, no auth, no JS rendering.
 *   Single page with ~840 rows (full roster).
 *   Columns: Apellidos | Nombre | Nº Colegiado
 *
 * Terapeutas ocupacionales (occupational therapists) → fisioterapia.
 * Province: CYL (Castilla y León). Country: ES.
 * Default city: valladolid (capital of CyL).
 */

const URL = "https://coptocyl.com/listado-de-colegiados/";
const AUTHORITY = "COPTOCYL (Col. Terapeutas Ocupacionales Castilla y León)";
const DEFAULT_CITY = "valladolid";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

interface CoptocylRow {
  apellidos: string;
  nombre: string;
  numero: string;
}

function parseRows(html: string): CoptocylRow[] {
  const out: CoptocylRow[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  for (const tr of html.matchAll(trRe)) {
    const cells: string[] = [];
    for (const td of tr[1].matchAll(tdRe)) cells.push(stripTags(td[1]));
    if (cells.length < 3) continue;
    const apellidos = cells[0];
    const nombre = cells[1];
    const numero = cells[2];
    // Skip header rows
    if (!apellidos || apellidos.toLowerCase().includes("apellido")) continue;
    out.push({ apellidos, nombre, numero });
  }
  return out;
}

export async function fetchCoptocylTo(): Promise<ScrapedProfessional[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let html: string;
  try {
    const res = await fetch(URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[coptocyl-to] HTTP ${res.status}`);
      return [];
    }
    html = await res.text();
  } catch (e) {
    console.warn(`[coptocyl-to] fetch error: ${(e as Error).message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }

  const rows = parseRows(html);
  console.log(`[coptocyl-to] parsed ${rows.length} rows`);

  return rows.map((r) => {
    const name = `${r.nombre} ${r.apellidos}`.trim();
    return normalise({
      source: "colegio",
      country: "ES",
      sourceId: `coptocyl-to:${r.numero || name.toLowerCase().replace(/\s+/g, "-")}`,
      name,
      categoryKey: "fisioterapia",
      citySlug: DEFAULT_CITY,
      licenseNumber: r.numero || undefined,
      metadata: {
        country: "ES",
        province: "CYL",
        authority: AUTHORITY,
        verified_by_authority: true,
        numero_colegiado: r.numero || null,
      },
    });
  });
}
