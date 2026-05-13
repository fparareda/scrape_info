import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * FedMVZ — Federación de Colegios y Asociaciones de Médicos
 * Veterinarios Zootecnistas de México.
 *
 *   https://www.federacionmvz.org/asociaciones
 *
 * ~33 colegios estatales afiliados. Patrón análogo a CSCAE/ES y
 * fcarm-arquitectos (federación → colegios estatales).
 *
 * IMPLEMENTACIÓN v1: discovery + 4 colegios principales (CDMX,
 * Jalisco, NL, Edomex) con extractor genérico de miembros. El resto
 * de los ~29 colegios queda como TODO.
 *
 * Off by default. `PROLIO_RUN_FEDMVZ_COLEGIOS_VET=true`.
 * Cap with `PROLIO_FEDMVZ_COLEGIOS_VET_LIMIT` (default 1000).
 */

const BASE_URL =
  process.env.PROLIO_FEDMVZ_COLEGIOS_VET_URL ||
  "https://www.federacionmvz.org/asociaciones";
const DEFAULT_LIMIT = 1_000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "veterinario";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const SEED_COLEGIOS: Array<{ name: string; url: string; citySlug: string }> = [
  { name: "Colegio MVZ CDMX", url: "https://cmvzdf.org.mx/", citySlug: "cdmx" },
  { name: "Colegio MVZ Jalisco", url: "https://cmvzj.org.mx/", citySlug: "guadalajara" },
  { name: "Colegio MVZ Nuevo León", url: "https://cmvznl.org.mx/", citySlug: "monterrey" },
  { name: "Colegio MVZ Estado de México", url: "https://cmvzedomex.org.mx/", citySlug: "tlalnepantla" },
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
      console.warn(`[fedmvz-colegios-vet] ${res.status} on ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[fedmvz-colegios-vet] network ${url}: ${(err as Error).message}`);
    return null;
  }
}

function extractMembers(html: string): Array<{ name: string; licenseNumber?: string }> {
  const out: Array<{ name: string; licenseNumber?: string }> = [];
  const NAME_RE = /<h[234][^>]*>\s*((?:MVZ\.?|Dr\.?|Dra\.?|Med\.?\s*Vet\.?)\s*[A-ZÁÉÍÓÚÑa-záéíóúñ.\s]{6,80})\s*<\/h[234]>/gi;
  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(html)) !== null) {
    const name = m[1].trim().replace(/\s+/g, " ");
    const after = html.slice(m.index, m.index + 300);
    const licMatch = after.match(/(?:Cédula|Registro|No\.?)\s*:?\s*([A-Z0-9\-]{3,15})/i);
    out.push({ name, licenseNumber: licMatch?.[1] });
  }
  return out;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const indexHtml = await politeFetch(BASE_URL);
  if (indexHtml) {
    console.log(`[fedmvz-colegios-vet] index OK (${indexHtml.length} bytes)`);
  } else {
    console.warn(`[fedmvz-colegios-vet] index unreachable, falling back to seed`);
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
      const sid = `fedmvz:${colegio.citySlug}:${slugify(member.name)}`;
      out.push(
        normalise({
          source: "fedmvz-colegios-vet" as ScrapeSource,
          sourceId: sid,
          name: member.name,
          categoryKey: CATEGORY,
          citySlug: colegio.citySlug,
          licenseNumber: member.licenseNumber,
          website: colegio.url,
          metadata: {
            country: "MX",
            authority: "FedMVZ",
            verified_by_authority: true,
            colegio_estatal: colegio.name,
          },
        }),
      );
      added += 1;
    }
    console.log(
      `[fedmvz-colegios-vet] colegio=${colegio.citySlug} parsed=${members.length} added=${added}`,
    );
  }

  // TODO: discovery automático del listado completo desde la página
  // /asociaciones, y per-colegio scraping para los ~29 restantes.
  return out;
}

export const fedmvzColegiosVetEnabled = (): boolean =>
  process.env.PROLIO_RUN_FEDMVZ_COLEGIOS_VET === "true";

export const fedmvzColegiosVetSource: ScraperSource = {
  name: "fedmvz-colegios-vet" as ScrapeSource,
  enabled: fedmvzColegiosVetEnabled,
  async fetch() {
    return [];
  },
};

export async function runFedmvzColegiosVet(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!fedmvzColegiosVetEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("fedmvz-colegios-vet", async () => {
    const rawLimit = Number(
      process.env.PROLIO_FEDMVZ_COLEGIOS_VET_LIMIT ?? DEFAULT_LIMIT,
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
