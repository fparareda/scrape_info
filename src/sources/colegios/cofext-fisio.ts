import type { ScrapedProfessional } from "../../types.js";
import { normalise } from "../../normalise.js";

/**
 * COFEXT — Colegio Oficial de Fisioterapeutas de Extremadura.
 *
 *   https://cofext.org/cms/colegiados.php
 *
 * Pre-flight 2026-05-31 (datacenter IP):
 *   HTTP 200, 442 KB HTML, no auth, no JS rendering.
 *   The page is a single static HTML table with 1,378 rows:
 *     Nombre | Apellidos | Nº Colegiado
 *   No pagination — the full roster is shipped in one GET.
 *
 * Category: fisioterapia. Province: EX (Extremadura). Country: ES.
 */

const URL = "https://cofext.org/cms/colegiados.php";
const AUTHORITY = "COFEXT";
const PROVINCE = "EX";
const DEFAULT_CITY = "badajoz";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface CofextRow {
  firstName: string;
  surname: string;
  numero: string;
}

function parseRows(html: string): CofextRow[] {
  const out: CofextRow[] = [];
  // Match any <tr> containing <td> cells
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  for (const tr of html.matchAll(trRe)) {
    const cells: string[] = [];
    for (const td of tr[1].matchAll(tdRe)) cells.push(stripTags(td[1]));
    if (cells.length < 3) continue;
    const firstName = cells[0];
    const surname = cells[1];
    const numero = cells[2];
    if (!firstName && !surname) continue;
    out.push({ firstName, surname, numero });
  }
  return out;
}

export async function fetchCofextFisio(): Promise<ScrapedProfessional[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let html: string;
  try {
    const res = await fetch(URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[cofext-fisio] HTTP ${res.status}`);
      return [];
    }
    html = await res.text();
  } catch (e) {
    console.warn(`[cofext-fisio] fetch error: ${(e as Error).message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }

  const rows = parseRows(html);
  console.log(`[cofext-fisio] parsed ${rows.length} rows`);

  return rows.map((r) => {
    const name = `${r.firstName} ${r.surname}`.trim();
    return normalise({
      source: "colegio",
      country: "ES",
      sourceId: `cofext-fisio:${r.numero || name.toLowerCase()}`,
      name,
      categoryKey: "fisioterapia",
      citySlug: DEFAULT_CITY,
      licenseNumber: r.numero || undefined,
      metadata: {
        country: "ES",
        province: PROVINCE,
        authority: AUTHORITY,
        verified_by_authority: true,
        numero_colegiado: r.numero || null,
      },
    });
  });
}
