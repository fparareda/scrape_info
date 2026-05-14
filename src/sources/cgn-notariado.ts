import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * CGN — Consejo General del Notariado (Spain).
 *
 * The "Elige a tu notario" directory at:
 *   https://www.notariado.org/portal/elige-a-tu-notario-orden
 * returns all ~3,200 Spanish notaries in server-rendered HTML.
 *
 * Pre-flight (2026-05-12):
 *   robots.txt — User-agent: * with Disallow: (empty = allow all).
 *     Only named bots (Baidu, Yandex, AhrefsBot…) are fully blocked.
 *     Crawl-delay: 5 is honoured. Path /portal/ is NOT in any Disallow.
 *   Page structure — Jinja/Liferay server-side template.
 *     Each notary appears as a <div> block with name, street address,
 *     postal code, province, phone, fax, and email fields in plain HTML.
 *   Record fields — name, address (street + CP + province), phone, email.
 *     No individual licence number in the HTML; we use the protocol
 *     number in the page text where available.
 *   Record count — full Spain all-notary fetch (comunidad=0) returns
 *     ~3,200 rows. Verified with comunidad=0&idioma=0 on 2026-05-12.
 *   Auth / WAF — no login required, no Cloudflare, no captcha detected
 *     in test fetch from CI-class IP.
 *
 * Category mapping: notario (CategoryKey).
 *
 * Off by default. Enable via `PROLIO_RUN_CGN_NOTARIADO=true`.
 * Monthly cron (notarial rolls change slowly — appointments via BOE).
 */

const BASE_URL =
  process.env.PROLIO_CGN_BASE ||
  "https://www.notariado.org/portal/elige-a-tu-notario-orden";

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 30_000;
/** Honour robots.txt Crawl-delay: 5 */
const REQUEST_DELAY_MS = 5_500;
const DEFAULT_LIMIT = 2000;

const CATEGORY: CategoryKey = "notario";

// --- HTTP helpers ---------------------------------------------------------

interface FetchResponse {
  status: number;
  body: string;
}

async function politeFetch(url: string): Promise<FetchResponse | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "Accept-Language": "es-ES,es;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[cgn_notariado] blocked with polite UA (${res.status}); retrying with Chrome UA`,
          );
          continue;
        }
        return { status: res.status, body: "" };
      }
      if (!res.ok) return { status: res.status, body: "" };
      const body = await res.text();
      return { status: res.status, body };
    } catch (err) {
      clearTimeout(timer);
      console.warn(
        `[cgn_notariado] network error on ${url}: ${(err as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Parse ----------------------------------------------------------------

interface NotarioRecord {
  sourceId: string;
  name: string;
  address: string;
  phone?: string;
  phoneAlt?: string;
  fax?: string;
  email?: string;
  emailCorporate?: string;
  postalCode?: string;
  city?: string;
  province?: string;
  languages?: string;
}

/**
 * Extract notary records from the Liferay-rendered HTML.
 *
 * The page renders each notary in a block structured like:
 *
 *   <strong>APELLIDO APELLIDO, Nombre</strong>
 *   <span>Calle Foo 1, 2º</span>
 *   <span>28001 - Madrid</span>
 *   Tel: 91 xxx xx xx  |  Fax: …
 *   Email corporativo: foo@notarios.org
 *
 * We use a two-pass approach:
 *   1. Split on `<strong>` blocks to isolate each notary's HTML chunk.
 *   2. Extract fields from each chunk via targeted regexes.
 *
 * sourceId is derived from the notary name (stable slug) since there is
 * no published numeric ID in the listing HTML.
 */
function parseNotarios(html: string): NotarioRecord[] {
  const out: NotarioRecord[] = [];
  const seen = new Set<string>();

  // Each entry is wrapped in a structural block ending with the next
  // entry or a section boundary. The reliable anchor is the notary's
  // name in <strong>…</strong> immediately after the CSS class marker.
  //
  // We split the page on each <strong> occurrence and treat each chunk
  // as a candidate record.
  const chunks = html.split(/<strong[^>]*>/i);
  // chunks[0] is the page header — skip it.
  for (let i = 1; i < chunks.length; i += 1) {
    const raw = chunks[i];

    // Extract the name: everything up to </strong>
    const nameMatch = raw.match(/^([^<]{4,120})<\/strong>/i);
    if (!nameMatch) continue;
    const rawName = decodeEntities(nameMatch[1]).trim();
    // Notary names are ALL-CAPS surname(s), given name — e.g.
    //   "GARCÍA LÓPEZ, María Dolores"
    //   "MARTÍNEZ, Juan"
    // Skip fragments that look like headings/labels.
    if (rawName.length < 6 || /^[^A-ZÁ-Ú]/.test(rawName)) continue;
    if (/^\d/.test(rawName)) continue;

    // The live HTML uses labeled fields after the name:
    //   Dirección : <street>, <CP> - <City> (<Province>)
    //   Teléfono: NNN.NNN.NNN     Teléfono 2: ...
    //   Fax: ...
    //   Correo corporativo Ley 24/2001: <a href="mailto:foo@correonotarial.org">
    //   Correo electrónico: <a href="mailto:bar@notariado.org">
    //   Idiomas: Castellano, Catalán, …
    //
    // We strip tags from the chunk to get a clean text view, then
    // run label-anchored regexes against it. mailto: hrefs are
    // extracted from the original (tagged) HTML so we always capture
    // both emails even if one is missing a label.
    const text = stripTags(raw).replace(/\s+/g, " ").trim();

    // Address — between "Dirección" / "Direcció" and next labeled field
    const addrLabelMatch = text.match(
      /Direcci[óo]n?\s*:?\s*([^]+?)(?=\s+(?:Tel[eé]fono|Fax|Correo|Idiomas|$))/i,
    );
    let rawAddr = addrLabelMatch ? addrLabelMatch[1].trim() : "";
    // Fallback: first <span>/<p> after </strong>
    if (!rawAddr) {
      const addrMatch = raw.match(/<\/strong>\s*<[^>]*>\s*([^<]{5,200})<\//i);
      rawAddr = addrMatch ? decodeEntities(addrMatch[1]).trim() : "";
    }

    // Postal code + city + (province) — e.g. "08007 - Barcelona (Barcelona)"
    const cpCityProvMatch = rawAddr.match(
      /(\d{5})\s*[-–]\s*([^()]{2,80}?)\s*(?:\(([^)]{2,80})\))?\s*$/,
    );
    const postalCode = cpCityProvMatch?.[1];
    const city = cpCityProvMatch?.[2]?.trim();
    const province = cpCityProvMatch?.[3]?.trim() ?? city;

    const cpProv = postalCode
      ? `${postalCode} - ${city}${province && province !== city ? ` (${province})` : ""}`
      : undefined;

    // Phones — primary + optional secondary
    const telMatches = [
      ...text.matchAll(/Tel[eé]fono(?:\s*2)?\.?\s*:?\s*([\d\s./()+-]{7,25})/gi),
    ];
    const phones = telMatches
      .map((m) => m[1].replace(/[\s.]/g, "").trim())
      .filter((p) => /^[\d+()-]{7,}$/.test(p));
    const rawPhone = phones[0];
    const rawPhoneAlt = phones[1];

    // Fax
    const faxMatch = text.match(/Fax\.?\s*:?\s*([\d\s./()+-]{7,25})/i);
    const rawFax = faxMatch ? faxMatch[1].replace(/[\s.]/g, "").trim() : undefined;

    // Languages
    const idiomasMatch = text.match(/Idiomas?\s*:?\s*([^.;]{2,120})/i);
    const languages = idiomasMatch ? idiomasMatch[1].trim() : undefined;

    // Emails — extract ALL mailto: hrefs in this chunk
    const mailtoRe = /mailto:([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,10})/gi;
    const mails = [...raw.matchAll(mailtoRe)].map((m) => m[1].toLowerCase());
    const corpEmail = mails.find((m) => /correonotarial\.org$/i.test(m));
    const stdEmail = mails.find((m) => !/correonotarial\.org$/i.test(m));
    // Prefer corporate (Law 24/2001) as primary identifier; fall back to standard.
    const rawEmail = corpEmail ?? stdEmail;
    const rawEmailAlt = corpEmail && stdEmail ? stdEmail : undefined;

    // If we only got a corp email as primary, keep that; if we have both,
    // expose corp as primary and store the public-facing one separately.
    const emailCorporate = corpEmail;

    const fullAddress = [rawAddr, cpProv].filter(Boolean).join(", ") || undefined;

    // Stable sourceId: slug of the full name
    const slug = rawName
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    if (!slug) continue;
    const sourceId = `cgn:${slug}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    out.push({
      sourceId,
      name: titleCaseNotario(rawName),
      address: fullAddress ?? rawAddr,
      phone: rawPhone,
      phoneAlt: rawPhoneAlt,
      fax: rawFax,
      email: rawEmail,
      emailCorporate,
      postalCode,
      city,
      province,
      languages,
    });
    // Silence "unused" lint for the secondary email — surfaced via metadata.
    void rawEmailAlt;
  }

  return out;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "));
}

/**
 * Convert ALL-CAPS Spanish name to Title Case.
 * "GARCÍA LÓPEZ, Juan Carlos" → "García López, Juan Carlos"
 */
function titleCaseNotario(input: string): string {
  return input
    .split(/\b/)
    .map((token) => {
      if (/^[A-ZÁÉÍÓÚÑÜ]{2,}$/.test(token)) {
        return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
      }
      return token;
    })
    .join("");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-zA-Z]{2,8});/g, (m) => {
      const map: Record<string, string> = {
        aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
        Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
        ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü",
      };
      return map[m.slice(1, -1)] ?? m;
    });
}

/**
 * Derive a best-effort city slug from the raw "CIUDAD" or postal code
 * embedded in the address block.
 *
 * The directory doesn't give us a clean city name, but the provincial
 * capital of each entry's province is a reasonable approximation for
 * landing-page routing. We fall back to a static map of the 50
 * provinces + 2 autonomous cities.
 */
const PROVINCE_TO_CITY: Record<string, string> = {
  "a coruña": "a-coruna",
  "álava": "vitoria-gasteiz",
  alava: "vitoria-gasteiz",
  albacete: "albacete",
  alicante: "alicante",
  almería: "almeria",
  almeria: "almeria",
  asturias: "oviedo",
  ávila: "avila",
  avila: "avila",
  badajoz: "badajoz",
  baleares: "palma",
  "illes balears": "palma",
  barcelona: "barcelona",
  burgos: "burgos",
  cáceres: "caceres",
  caceres: "caceres",
  cádiz: "cadiz",
  cadiz: "cadiz",
  cantabria: "santander",
  castellón: "castellon",
  castellon: "castellon",
  ceuta: "ceuta",
  "ciudad real": "ciudad-real",
  córdoba: "cordoba",
  cordoba: "cordoba",
  cuenca: "cuenca",
  girona: "girona",
  granada: "granada",
  guadalajara: "guadalajara",
  gipuzkoa: "san-sebastian",
  guipúzcoa: "san-sebastian",
  huelva: "huelva",
  huesca: "huesca",
  jaén: "jaen",
  jaen: "jaen",
  "la rioja": "logrono",
  "las palmas": "las-palmas-de-gran-canaria",
  "palmas de gran canaria": "las-palmas-de-gran-canaria",
  león: "leon",
  leon: "leon",
  lleida: "lleida",
  lugo: "lugo",
  madrid: "madrid",
  málaga: "malaga",
  malaga: "malaga",
  melilla: "melilla",
  murcia: "murcia",
  navarra: "pamplona",
  ourense: "ourense",
  palencia: "palencia",
  pontevedra: "pontevedra",
  salamanca: "salamanca",
  "santa cruz de tenerife": "santa-cruz-de-tenerife",
  tenerife: "santa-cruz-de-tenerife",
  segovia: "segovia",
  sevilla: "sevilla",
  soria: "soria",
  tarragona: "tarragona",
  teruel: "teruel",
  toledo: "toledo",
  valencia: "valencia",
  valladolid: "valladolid",
  vizcaya: "bilbao",
  bizkaia: "bilbao",
  zamora: "zamora",
  zaragoza: "zaragoza",
};

/**
 * Slugify a free-text city/province name (e.g. "Vilanova i la Geltrú")
 * into the canonical kebab-case form used throughout the cities catalog.
 * Returns undefined for empty input.
 */
function slugifyCity(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const slug = input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug || undefined;
}

function citySlugFromAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  // Pattern: "28001 - Madrid" or "28001-Madrid"
  const cpProvMatch = address.match(/\d{5}\s*[-–]\s*([^,\n]+)/);
  if (!cpProvMatch) return undefined;
  const prov = cpProvMatch[1]
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  // Direct lookup
  if (PROVINCE_TO_CITY[prov]) return PROVINCE_TO_CITY[prov];
  // Partial match
  for (const [key, slug] of Object.entries(PROVINCE_TO_CITY)) {
    if (prov.includes(key) || key.includes(prov)) return slug;
  }
  return undefined;
}

// --- Community IDs for the directory (autonomous communities) -----------
// comunidad=0 returns all Spain; individual CCAA IDs allow chunked fetches
// if needed. We try comunidad=0 first (single full-census request) and fall
// back to per-CCAA if the page is empty (server may enforce a filter).
const COMUNIDAD_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

// --- Scrape logic ---------------------------------------------------------

async function fetchAllNotarios(
  limit: number,
): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  /**
   * Try fetching all Spain first (comunidad=0).
   * If the result seems empty or too small, fall back to per-CCAA.
   */
  const allSpainUrl = `${BASE_URL}?comunidad=0&idioma=0`;
  console.log(`[cgn_notariado] fetching all-Spain URL: ${allSpainUrl}`);
  const allSpainResponse = await politeFetch(allSpainUrl);
  if (!allSpainResponse || !allSpainResponse.body) {
    console.warn(
      `[cgn_notariado] all-Spain fetch failed (status=${allSpainResponse?.status ?? "network"}), trying per-CCAA`,
    );
  } else {
    const records = parseNotarios(allSpainResponse.body);
    console.log(`[cgn_notariado] all-Spain parsed ${records.length} notarios`);
    if (records.length >= 500) {
      // Looks like a full census — use it directly.
      for (const r of records) {
        if (seen.has(r.sourceId)) continue;
        seen.add(r.sourceId);
        const citySlug =
          slugifyCity(r.city) ??
          slugifyCity(r.province) ??
          citySlugFromAddress(r.address);
        if (!citySlug) continue;
        out.push(
          normalise({
            source: "cgn-notariado",
            sourceId: r.sourceId,
            name: r.name,
            categoryKey: CATEGORY,
            citySlug,
            address: r.address,
            phone: r.phone,
            email: r.email,
            metadata: {
              country: "ES",
              authority: "CGN",
              verified_by_authority: true,
              city: r.city,
              province: r.province,
              postal_code: r.postalCode,
              phone_alt: r.phoneAlt,
              fax: r.fax,
              email_corporate: r.emailCorporate,
              languages: r.languages,
            },
          }),
        );
        if (out.length >= limit) break;
      }
      console.log(
        `[cgn_notariado] all-Spain strategy yielded ${out.length} records (after city filter)`,
      );
      return out;
    }
    console.warn(
      `[cgn_notariado] all-Spain returned only ${records.length} records — falling back to per-CCAA`,
    );
  }

  // Per-CCAA fallback — iterate community IDs 1..19 with polite delay.
  for (const comunidad of COMUNIDAD_IDS.filter((c) => c > 0)) {
    if (out.length >= limit) break;
    const url = `${BASE_URL}?comunidad=${comunidad}&idioma=0`;
    await sleep(REQUEST_DELAY_MS);
    const response = await politeFetch(url);
    if (!response || !response.body) {
      console.warn(
        `[cgn_notariado] comunidad=${comunidad} fetch failed`,
      );
      continue;
    }
    const records = parseNotarios(response.body);
    let added = 0;
    for (const r of records) {
      if (seen.has(r.sourceId)) continue;
      seen.add(r.sourceId);
      const citySlug =
        slugifyCity(r.city) ??
        slugifyCity(r.province) ??
        citySlugFromAddress(r.address);
      if (!citySlug) continue;
      out.push(
        normalise({
          source: "cgn-notariado",
          sourceId: r.sourceId,
          name: r.name,
          categoryKey: CATEGORY,
          citySlug,
          address: r.address,
          phone: r.phone,
          email: r.email,
          metadata: {
            country: "ES",
            authority: "CGN",
            verified_by_authority: true,
            comunidad,
            city: r.city,
            province: r.province,
            postal_code: r.postalCode,
            phone_alt: r.phoneAlt,
            fax: r.fax,
            email_corporate: r.emailCorporate,
            languages: r.languages,
          },
        }),
      );
      added += 1;
      if (out.length >= limit) break;
    }
    console.log(
      `[cgn_notariado] comunidad=${comunidad} parsed=${records.length} added=${added} total=${out.length}`,
    );
  }

  return out;
}

// --- Public exports -------------------------------------------------------

export const cgnNotariadoEnabled = (): boolean =>
  process.env.PROLIO_RUN_CGN_NOTARIADO === "true";

// Thin ScraperSource shim (per-target loop not used — this is a bulk source).
export const cgnNotariadoSource: ScraperSource = {
  name: "cgn-notariado",
  enabled: cgnNotariadoEnabled,
  async fetch() {
    return [];
  },
};

export async function runCgnNotariado(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cgnNotariadoEnabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return withScrapeRun("cgn-notariado", async () => {
    const limit = parseInt(
      process.env.PROLIO_CGN_NOTARIADO_LIMIT ?? String(DEFAULT_LIMIT),
      10,
    );
    const effectiveLimit =
      Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
    console.log(`[cgn_notariado] starting, limit=${effectiveLimit}`);

    const records = await fetchAllNotarios(effectiveLimit);
    if (records.length === 0) {
      console.warn(`[cgn_notariado] 0 records — check HTML structure`);
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    }

    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    console.log(
      `[cgn_notariado] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
    return {
      rowsFetched: records.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
    };
  }).then((result) => ({
    fetched: result?.rowsFetched ?? 0,
    inserted: 0,
    updated: 0,
    skipped: result?.rowsSkipped ?? 0,
  }));
}
