import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * JCYL Instaladoras — Empresas Instaladoras y Mantenedoras de Castilla y León.
 *
 * Open-data XML feed published by the Junta de Castilla y León,
 * Dirección General de Industria, under CC-BY 4.0:
 *   https://datosabiertos.jcyl.es/web/jcyl/risp/es/industria/instalad_mantened/1284208617621.xml
 *   (redirects to the live endpoint at servicios3.jcyl.es)
 *
 * Pre-flight 2026-05-29 (datacenter IP):
 *   robots.txt — User-agent: * path /web/jcyl/risp/ is NOT disallowed.
 *     No crawl-delay. Full allow for the dataset URL.
 *   Record count — 40,781 rows total; 3,188 unique companies with
 *     I-BT* (baja tensión / electricidad) ambitoActuacion codes.
 *   Auth / WAF — no login required, no Cloudflare, no captcha.
 *   Format — plain XML, no JS required, CC-BY 4.0 license.
 *
 * The XML has one <empresaInstaladoraYMantenedora> element per
 * (company × ambitoActuacion) pair. We deduplicate by CIF and only
 * keep companies that have at least one I-BT* (low-voltage electrical
 * installer) or M-BT* (low-voltage maintainer) category.
 *
 * Fields extracted:
 *   razonSocial   → name
 *   cif           → sourceId suffix + licenseNumber
 *   localidad     → city slug
 *   provincia     → province (metadata)
 *   direccion     → address
 *   codigoPostal  → postal code (metadata)
 *   ambitoActuacion → list of installer categories (metadata)
 *
 * Category: `electricidad`. Authority: Junta de Castilla y León.
 * Off by default — `PROLIO_RUN_JCYL_INSTALADORAS_ES=true` to enable.
 * Cap via `PROLIO_JCYL_INSTALADORAS_ES_LIMIT` (default 5,000).
 */

const SOURCE_NAME = "jcyl-instaladoras-es" as ScrapeSource;
const CATEGORY: CategoryKey = "electricidad";
const DEFAULT_LIMIT = 5_000;
const REQUEST_TIMEOUT_MS = 60_000;

const FEED_URL =
  process.env.PROLIO_JCYL_INSTALADORAS_URL ??
  "https://datosabiertos.jcyl.es/web/jcyl/risp/es/industria/instalad_mantened/1284208617621.xml";

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// --- Electrical BT codes -------------------------------------------------
// We include both instaladores (I-BT*) and mantenedores (M-BT*) as they
// represent electricians / low-voltage electrical companies.
function isElectrical(ambitoActuacion: string): boolean {
  return /^[IM]-BT/i.test(ambitoActuacion.trim());
}

// --- XML helpers ---------------------------------------------------------

function xmlText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return "";
  return decodeXmlEntities(m[1].trim());
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

interface InstaladoraRow {
  cif: string;
  razonSocial: string;
  direccion: string;
  codigoPostal: string;
  localidad: string;
  municipio: string;
  provincia: string;
  categorias: string[];
}

function parseXml(xml: string): InstaladoraRow[] {
  // One XML row = one (company × ambitoActuacion). Deduplicate by CIF,
  // collecting all BT categories. Filter to companies that have ≥1 BT entry.

  // Split on empresa elements (they are flat, no nesting)
  const empresaRe =
    /<empresaInstaladoraYMantenedora>([\s\S]*?)<\/empresaInstaladoraYMantenedora>/gi;

  // Map of CIF → InstaladoraRow
  const byId = new Map<string, InstaladoraRow>();

  for (const m of xml.matchAll(empresaRe)) {
    const block = m[1];
    const cif = xmlText(block, "cif");
    if (!cif) continue;
    const ambito = xmlText(block, "ambitoActuacion");
    if (!isElectrical(ambito)) continue;

    let row = byId.get(cif);
    if (!row) {
      row = {
        cif,
        razonSocial: xmlText(block, "razonSocial"),
        direccion: xmlText(block, "direccion"),
        codigoPostal: xmlText(block, "codigoPostal"),
        localidad: xmlText(block, "localidad"),
        municipio: xmlText(block, "municipio"),
        provincia: xmlText(block, "provincia"),
        categorias: [],
      };
      byId.set(cif, row);
    }
    if (ambito && !row.categorias.includes(ambito)) {
      row.categorias.push(ambito);
    }
  }

  return Array.from(byId.values());
}

// --- City slug -----------------------------------------------------------

const PROVINCE_CAPITAL: Record<string, string> = {
  "avila": "avila",
  "burgos": "burgos",
  "leon": "leon",
  "palencia": "palencia",
  "salamanca": "salamanca",
  "segovia": "segovia",
  "soria": "soria",
  "valladolid": "valladolid",
  "zamora": "zamora",
};

function citySlugFromRow(row: InstaladoraRow): string {
  // Prefer the localidad (city); fall back to province capital.
  if (row.localidad) {
    const slug = slugify(row.localidad);
    if (slug) return slug;
  }
  if (row.municipio) {
    const slug = slugify(row.municipio);
    if (slug) return slug;
  }
  const prov = slugify(row.provincia);
  return PROVINCE_CAPITAL[prov] ?? prov ?? "castilla-y-leon";
}

// --- Fetch ---------------------------------------------------------------

async function fetchXml(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(FEED_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/xml,text/xml,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[jcyl-instaladoras-es] HTTP ${res.status} from ${FEED_URL}`);
      return null;
    }
    const text = await res.text();
    console.log(
      `[jcyl-instaladoras-es] fetched ${(text.length / 1024 / 1024).toFixed(1)} MB`,
    );
    return text;
  } catch (e) {
    console.warn(
      `[jcyl-instaladoras-es] fetch error: ${(e as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- ScraperSource shim --------------------------------------------------

export const jcylInstaladoresEsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_JCYL_INSTALADORAS_ES === "true";
  },
  async fetch() {
    return [];
  },
};

// --- Main run ------------------------------------------------------------

export async function runJcylInstaladoresEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!jcylInstaladoresEsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(
    process.env.PROLIO_JCYL_INSTALADORAS_ES_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  console.log(`[jcyl-instaladoras-es] starting, limit=${cap}`);

  const xml = await fetchXml();
  if (!xml) {
    console.warn(
      "[jcyl-instaladoras-es] XML fetch failed — endpoint may be down",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rows = parseXml(xml);
  console.log(`[jcyl-instaladoras-es] parsed ${rows.length} unique BT companies`);

  if (rows.length === 0) {
    console.warn(
      "[jcyl-instaladoras-es] 0 records parsed — XML schema may have changed",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const records: ScrapedProfessional[] = [];
  for (const row of rows) {
    if (records.length >= cap) break;

    const citySlug = citySlugFromRow(row);
    const record = normalise({
      source: SOURCE_NAME,
      country: "ES",
      sourceId: `jcyl:${row.cif}`,
      name: row.razonSocial,
      categoryKey: CATEGORY,
      citySlug,
      address: row.direccion || undefined,
      metadata: {
        country: "ES",
        authority: "Junta de Castilla y León",
        verified_by_authority: true,
        cif: row.cif,
        postal_code: row.codigoPostal || null,
        localidad: row.localidad || null,
        municipio: row.municipio || null,
        provincia: row.provincia || null,
        categorias_bt: row.categorias,
      },
    });
    records.push(record);
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[jcyl-instaladoras-es] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
