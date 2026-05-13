import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * FCARM — Federación de Colegios de Arquitectos de la República
 * Mexicana.
 *
 *   https://fcarm.org.mx/colegios/
 *
 * Patrón "federación → colegios estatales" (análogo a CSCAE/ES en
 * src/sources/cscae.ts). La federación lista ~33 colegios estatales,
 * cada uno con su propia web y directorio.
 *
 * IMPLEMENTACIÓN v1 (stub honesto):
 *   - Descubrir lista de colegios desde el índice federal.
 *   - Para v1 implementamos solo discovery + per-colegio shells
 *     para los 4 metros principales: CDMX, Jalisco, NL, Edomex.
 *   - El resto queda como TODO documentado.
 *
 * Off by default. `PROLIO_RUN_FCARM_ARQUITECTOS=true`.
 * Cap with `PROLIO_FCARM_ARQUITECTOS_LIMIT` (default 1000).
 */

const BASE_URL =
  process.env.PROLIO_FCARM_ARQUITECTOS_URL ||
  "https://fcarm.org.mx/colegios/";
const DEFAULT_LIMIT = 1_000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "arquitecto";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Static seed of the top-tier estatales — discovered manually
 * 2026-05-13 from fcarm.org.mx/colegios/. URLs may change; the
 * discovery step (extractColegios) will eventually overwrite this.
 */
const SEED_COLEGIOS: Array<{ name: string; url: string; citySlug: string }> = [
  { name: "Colegio de Arquitectos de la CDMX", url: "https://cam-sam.org/", citySlug: "cdmx" },
  { name: "Colegio de Arquitectos de Jalisco", url: "https://www.colegiodearquitectosjalisco.org.mx/", citySlug: "guadalajara" },
  { name: "Colegio de Arquitectos de Nuevo León", url: "https://colarq.com.mx/", citySlug: "monterrey" },
  { name: "Colegio de Arquitectos del Estado de México", url: "https://caem.org.mx/", citySlug: "tlalnepantla" },
];

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
      console.warn(`[fcarm-arquitectos] ${res.status} on ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[fcarm-arquitectos] network ${url}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Best-effort per-colegio member extractor. Each colegio has a
 * different HTML structure; this regex matches a common card pattern
 * with a name + matching ARC/MX licence number nearby. Anything that
 * doesn't match is logged and skipped — explicitly NOT brittle.
 */
function extractMembers(html: string): Array<{ name: string; licenseNumber?: string }> {
  const out: Array<{ name: string; licenseNumber?: string }> = [];
  // Pattern: <h3|h4>NAME</h3>  ...  Cédula|Reg|ARC: NUMBER
  const NAME_RE = /<h[234][^>]*>\s*((?:Arq\.?|Arquitect[oa]\.?)\s*[A-ZÁÉÍÓÚÑa-záéíóúñ.\s]{6,80})\s*<\/h[234]>/gi;
  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(html)) !== null) {
    const name = m[1].trim().replace(/\s+/g, " ");
    // Look for a licence number in the next 300 chars
    const after = html.slice(m.index, m.index + 300);
    const licMatch = after.match(/(?:Cédula|Registro|ARC|No\.?)\s*:?\s*([A-Z0-9\-]{3,15})/i);
    out.push({ name, licenseNumber: licMatch?.[1] });
  }
  return out;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  // Discovery — verify federation index is reachable.
  const indexHtml = await politeFetch(BASE_URL);
  if (indexHtml) {
    console.log(`[fcarm-arquitectos] index OK (${indexHtml.length} bytes)`);
  } else {
    console.warn(`[fcarm-arquitectos] index unreachable, falling back to seed`);
  }

  for (const colegio of SEED_COLEGIOS) {
    if (out.length >= limit) break;
    await sleep(REQUEST_DELAY_MS);
    const html = await politeFetch(colegio.url);
    if (!html) continue;
    const members = extractMembers(html);
    let added = 0;
    for (const member of members) {
      if (out.length >= limit) break;
      const sid = `fcarm:${slugify(colegio.citySlug)}:${slugify(member.name)}`;
      out.push(
        normalise({
          source: "fcarm-arquitectos" as ScrapeSource,
          sourceId: sid,
          name: member.name,
          categoryKey: CATEGORY,
          citySlug: colegio.citySlug,
          licenseNumber: member.licenseNumber,
          website: colegio.url,
          metadata: {
            country: "MX",
            authority: "FCARM",
            verified_by_authority: true,
            colegio_estatal: colegio.name,
          },
        }),
      );
      added += 1;
    }
    console.log(
      `[fcarm-arquitectos] colegio=${colegio.citySlug} parsed=${members.length} added=${added}`,
    );
  }

  // TODO: implement discovery of the remaining ~29 colegios from the
  // federation index, and per-colegio scraping for each. Many of the
  // smaller colegios publish only a contact page and no member roster,
  // in which case we'd emit the colegio itself as a single row.
  return out;
}

export const fcarmArquitectosEnabled = (): boolean =>
  process.env.PROLIO_RUN_FCARM_ARQUITECTOS === "true";

export const fcarmArquitectosSource: ScraperSource = {
  name: "fcarm-arquitectos" as ScrapeSource,
  enabled: fcarmArquitectosEnabled,
  async fetch() {
    return [];
  },
};

export async function runFcarmArquitectos(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!fcarmArquitectosEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("fcarm-arquitectos", async () => {
    const rawLimit = Number(
      process.env.PROLIO_FCARM_ARQUITECTOS_LIMIT ?? DEFAULT_LIMIT,
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
