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
 *   https://www.federacionmvz.org/colegios
 *
 * Discovery realizado 2026-05-13 contra la página oficial de colegios.
 * Resultado: ~29 colegios estatales (no ~33 como se asumió en v1).
 *
 * Clasificación de los 29 colegios según accesibilidad pública del
 * padrón / directorio de miembros:
 *
 *   A · scrapable público:      1   (SLP)
 *   B · solo junta directiva:   3   (CDMX, Jalisco, Edomex)
 *   C · login / Facebook:      25
 *   D · Cloudflare/CAPTCHA:     0
 *   E · 404 / web rota:         0
 *
 * Tabla detallada por colegio:
 *
 * | Estado                | URL principal                                  | Tipo |
 * |-----------------------|------------------------------------------------|------|
 * | Aguascalientes        | facebook.com/CEMVZAGS                          | C    |
 * | Baja California       | facebook.com/CMVZBC                            | C    |
 * | Baja California Sur   | facebook.com/colegiomvzbcs                     | C    |
 * | Campeche              | facebook.com/COMVEZCAM                         | C    |
 * | Chiapas               | facebook.com/CEMVZCHIS                         | C    |
 * | Chihuahua             | facebook.com/veterinarios.chihuahua            | C    |
 * | Coahuila              | facebook.com/CRNMVZC                           | C    |
 * | Colima                | facebook.com/cmvzc14                           | C    |
 * | Ciudad de México      | colvetcdmx.org                                 | B    |
 * | Comarca Lagunera      | facebook.com/ColegioMVZLaguna                  | C    |
 * | Durango               | facebook.com/coldemedsvetsdedgo                | C    |
 * | Estado de México      | colegiomvzedomex.wixsite.com/cemvzem           | B    |
 * | Hidalgo               | facebook.com/CMVZH                             | C    |
 * | Jalisco               | cmvzej.com                                     | B    |
 * | Michoacán             | facebook.com/CmvzMichoacan                     | C    |
 * | Nayarit               | facebook.com/CEMVZNAY                          | C    |
 * | Nuevo León            | facebook.com/cmvdenl                           | C    |
 * | Oaxaca                | facebook.com/CMVZOAX                           | C    |
 * | Puebla                | facebook.com/ColegioMVZPuebla                  | C    |
 * | Querétaro             | facebook.com/cmvzeqro                          | C    |
 * | Quintana Roo          | facebook.com/colmevetqroo                      | C    |
 * | San Luis Potosí       | cmvzslp.org                                    | A    |
 * | Sinaloa               | (sin web)                                      | E    |
 * | Sonora                | facebook.com/cmvzson                           | C    |
 * | Tabasco               | facebook.com/cmvztab                           | C    |
 * | Tamaulipas            | facebook.com/col.mvz.tamaulipas                | C    |
 * | Tlaxcala              | facebook.com/cmvztlax                          | C    |
 * | Veracruz              | facebook.com/CEMVZV                            | C    |
 * | Zacatecas             | facebook.com/cmvzac                            | C    |
 *
 * Implementación actual: SEED_COLEGIOS contiene los pocos con web
 * propia. Solo SLP (tipo A) tiene directorio público parseable.
 * Los tipo B se mantienen en seed para emitir al menos la junta
 * directiva si el extractor genérico encuentra nombres en la home.
 *
 * Blockers conocidos:
 *   - Facebook bloquea scraping anónimo (25/29 colegios).
 *   - Tres colegios "B" exponen solo Mesa Directiva (~5 nombres c/u).
 *   - SLP publica ~10-30 miembros en la home + un PDF mensual.
 *
 * Volumen máximo alcanzable sin Facebook ≈ 30-50 profesionales.
 *
 * Off by default. `PROLIO_RUN_FEDMVZ_COLEGIOS_VET=true`.
 * Cap with `PROLIO_FEDMVZ_COLEGIOS_VET_LIMIT` (default 1000).
 */

const BASE_URL =
  process.env.PROLIO_FEDMVZ_COLEGIOS_VET_URL ||
  "https://www.federacionmvz.org/colegios";
const DEFAULT_LIMIT = 1_000;
const POLITE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CATEGORY: CategoryKey = "veterinario";
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
  /** Optional specific extractor for non-generic sites. */
  extractor?: (html: string) => Array<{ name: string; phone?: string; clinic?: string; specialty?: string }>;
};

const SEED_COLEGIOS: ColegioSeed[] = [
  // === Type A: public scrapable directory ===
  {
    name: "Colegio MVZ San Luis Potosí",
    url: "https://cmvzslp.org/",
    citySlug: "san-luis-potosi",
    rawState: "San Luis Potosí",
    extractor: extractSlpMembers,
  },
  // === Type B: own website, only board/junta directiva ===
  {
    name: "Colegio MVZ Ciudad de México",
    url: "https://colvetcdmx.org/",
    citySlug: "cdmx",
    rawState: "Ciudad de México",
  },
  {
    name: "Colegio MVZ Jalisco",
    url: "https://cmvzej.com/",
    citySlug: "guadalajara",
    rawState: "Jalisco",
  },
  {
    name: "Colegio MVZ Estado de México",
    url: "https://colegiomvzedomex.wixsite.com/cemvzem",
    citySlug: "tlalnepantla",
    rawState: "Estado de México",
  },
  // === Type C: Facebook-only — listed here as documentation; the
  //     fetcher will not attempt these because Facebook rejects
  //     anonymous bots. Kept commented for future authenticated
  //     scraping (Graph API or similar).
  // { name: "Colegio MVZ Nuevo León", url: "https://www.facebook.com/cmvdenl", citySlug: "monterrey", rawState: "Nuevo León" },
  // { name: "Colegio MVZ Puebla", url: "https://www.facebook.com/ColegioMVZPuebla", citySlug: "puebla", rawState: "Puebla" },
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

/**
 * Generic member extractor — looks for veterinary name prefixes
 * (MVZ, Dr., Dra., Med. Vet.) inside heading tags.
 */
function extractMembers(html: string): Array<{ name: string; licenseNumber?: string }> {
  const out: Array<{ name: string; licenseNumber?: string }> = [];
  const seen = new Set<string>();
  const NAME_RE =
    /<h[234][^>]*>\s*((?:M\.?V\.?Z\.?|MVZ|Dr\.?|Dra\.?|Med\.?\s*Vet\.?)\s*[A-ZÁÉÍÓÚÑa-záéíóúñ.\s]{6,80})\s*<\/h[234]>/gi;
  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(html)) !== null) {
    const name = m[1].trim().replace(/\s+/g, " ");
    if (seen.has(name)) continue;
    seen.add(name);
    const after = html.slice(m.index, m.index + 300);
    const licMatch = after.match(/(?:Cédula|Registro|No\.?)\s*:?\s*([A-Z0-9\-]{3,15})/i);
    out.push({ name, licenseNumber: licMatch?.[1] });
  }
  return out;
}

/**
 * SLP-specific extractor — cmvzslp.org publishes a flat list of
 * vets on its home with phone + clinic + city, but no consistent
 * heading structure. We match common "MVZ <Name>" / "M.V.Z. <Name>"
 * patterns anywhere in the document body and pull the surrounding
 * context to extract phone & clinic.
 */
function extractSlpMembers(
  html: string,
): Array<{ name: string; phone?: string; clinic?: string; specialty?: string }> {
  const out: Array<{ name: string; phone?: string; clinic?: string; specialty?: string }> = [];
  const seen = new Set<string>();
  // Names look like:  M.V.Z. José Domingo Viramontes Azua
  // or               MVZ Keyla Lorena López Pérez
  // or               Dra. Isaura Méndez Rodríguez
  const NAME_RE =
    /(?:M\.?V\.?Z\.?|MVZ|Dra?\.)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.]+){1,5})/g;
  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(html)) !== null) {
    const name = m[1].trim().replace(/\s+/g, " ");
    if (name.length < 8 || name.split(" ").length < 2) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const ctx = html.slice(m.index, m.index + 600);
    const phoneMatch = ctx.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
    const clinicMatch = ctx.match(/(?:Clínica|Consultorio|Hospital)\s+[A-ZÁÉÍÓÚÑ][\w\sÁÉÍÓÚÑáéíóúñ.'"-]{3,60}/);
    out.push({
      name,
      phone: phoneMatch?.[0],
      clinic: clinicMatch?.[0]?.trim(),
    });
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

    if (colegio.extractor) {
      const members = colegio.extractor(html);
      let added = 0;
      for (const member of members) {
        if (out.length >= limit) break;
        const sid = `fedmvz:${colegio.citySlug}:${slugify(member.name)}`;
        out.push(
          normalise({
            source: "fedmvz-colegios-vet" as ScrapeSource,
            country: "MX",
            sourceId: sid,
            name: member.name,
            categoryKey: CATEGORY,
            citySlug: colegio.citySlug,
            phone: member.phone,
            website: colegio.url,
            metadata: {
              country: "MX",
              authority: "FedMVZ",
              verified_by_authority: true,
              colegio_estatal: colegio.name,
              raw_state: colegio.rawState,
              clinic: member.clinic,
              specialty: member.specialty,
            },
          }),
        );
        added += 1;
      }
      console.log(
        `[fedmvz-colegios-vet] colegio=${colegio.citySlug} (specific) parsed=${members.length} added=${added}`,
      );
      continue;
    }

    const members = extractMembers(html);
    let added = 0;
    for (const member of members) {
      if (out.length >= limit) break;
      const sid = `fedmvz:${colegio.citySlug}:${slugify(member.name)}`;
      out.push(
        normalise({
          source: "fedmvz-colegios-vet" as ScrapeSource,
          country: "MX",
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
            raw_state: colegio.rawState,
          },
        }),
      );
      added += 1;
    }
    console.log(
      `[fedmvz-colegios-vet] colegio=${colegio.citySlug} parsed=${members.length} added=${added}`,
    );
  }

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
