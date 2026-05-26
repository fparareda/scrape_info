import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * Colegio de Mediadores de Seguros de Madrid — public colegiados directory.
 *
 * Source URL (single HTML page, no JS required):
 *   https://mediadoresseguros.madrid/listado-de-colegiados/
 *
 * Pre-flight 2026-05-26 (datacenter IP):
 *   GET https://mediadoresseguros.madrid/listado-de-colegiados/
 *     → 200, server-rendered HTML (WordPress), no auth, no captcha,
 *       no Cloudflare challenge.
 *   robots.txt: User-agent: * / Disallow: (nothing) → full crawl allowed.
 *   Single non-paginated HTML page listing all colegiados in alphabetical
 *   order as a plain <table>.
 *
 * Record count: ~1,000+ mediadores de seguros in Madrid province.
 * Table columns:
 *   1. Nombre del colegiado (Last name, First name — comma separated)
 *   2. Empresa (company/firm name, may be empty for individual brokers)
 *   3. Direccion (address + phone + email combined with <br> tags)
 *   4. Forma (registration type code: 1=Corredor PF, 2=Corredor PJ,
 *        7=Agente exclusivo PF, 8=Agente exclusivo PJ, 11=Entidad bancaria,
 *        15=Operador banca-seguros vinculado, 17=Agente vinculado PF,
 *        18=Agente vinculado PJ, 19=Operador banca-seguros exclusivo PF,
 *        20=Operador banca-seguros exclusivo PJ)
 *
 * The page states: "El presente listado tiene el caracter de fuente
 * accesible al publico, de acuerdo con la normativa de proteccion de datos."
 * (This list has the status of a publicly accessible source, in accordance
 * with data protection regulations.)
 *
 * Candidates researched on 2026-05-26 before settling on this source:
 *   1. CGCGA Gestores Administrativos (registro.consejogestores.org) — NOT
 *      VIABLE: robots.txt has Disallow: /*?* which blocks all query-string
 *      URLs needed for the paginated search interface.
 *   2. Colegios Mediadores de Seguros Madrid — VIABLE: open robots.txt,
 *      server-rendered HTML, 1000+ records, no login/captcha.
 *
 * Authority: Colegio de Mediadores de Seguros de Madrid.
 * Category: fiscal (insurance brokers/agents handle financial advisory and
 *   regulated insurance intermediation in Spain under Ley 26/2006 and
 *   RD-ley 3/2020).
 * Country: ES. City slug: madrid (province capital).
 * Off by default — PROLIO_RUN_MEDIADORES_SEGUROS_MADRID=true to enable.
 * Cap via PROLIO_MEDIADORES_SEGUROS_MADRID_LIMIT (default 5_000).
 */

const SOURCE_URL =
  "https://mediadoresseguros.madrid/listado-de-colegiados/";
const CATEGORY: CategoryKey = "fiscal";
const COUNTRY = "ES";
const DEFAULT_CITY = "madrid";
const DEFAULT_LIMIT = 5_000;
const REQUEST_TIMEOUT_MS = 60_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

/**
 * Forma type code to human label (for metadata only).
 * Source: Ley 26/2006 de Mediacion de Seguros y Reaseguros Privados and
 * RD-ley 3/2020 (updated Spanish insurance distribution framework).
 */
const FORMA_LABELS: Record<string, string> = {
  "1": "Corredor de Seguros (Persona Fisica)",
  "2": "Corredor de Seguros (Persona Juridica)",
  "7": "Agente de Seguros Exclusivo (Persona Fisica)",
  "8": "Agente de Seguros Exclusivo (Persona Juridica)",
  "11": "Entidad de Credito (bancassurance)",
  "15": "Operador de Banca-Seguros Vinculado",
  "17": "Agente de Seguros Vinculado (Persona Fisica)",
  "18": "Agente de Seguros Vinculado (Persona Juridica)",
  "19": "Operador de Banca-Seguros Exclusivo (Persona Fisica)",
  "20": "Operador de Banca-Seguros Exclusivo (Persona Juridica)",
};

export const mediadoresSegurosMadridSource: ScraperSource = {
  name: "mediadores-seguros-madrid" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_MEDIADORES_SEGUROS_MADRID === "true";
  },
  async fetch() {
    return [];
  },
};

interface MediadorRow {
  /** Raw name as listed, typically "APELLIDO APELLIDO, Nombre" */
  nameRaw: string;
  empresa?: string;
  address?: string;
  phone?: string;
  email?: string;
  forma?: string;
}

function clean(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8203;/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the HTML page into an array of MediadorRow objects.
 *
 * The directory is a plain <table> where each <tr> corresponds to one
 * colegiado with four <td> cells:
 *   0: NAME (LastName, FirstName)
 *   1: EMPRESA (company name, may be empty)
 *   2: ADDRESS/CONTACT (address + phone + email, combined with <br> tags)
 *   3: FORMA (registration type code)
 *
 * We skip the header row (which contains "NOMBRE COLEGIADO", etc.).
 */
function parseRows(html: string): MediadorRow[] {
  const rows: MediadorRow[] = [];

  // Match all <tr> blocks
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const trMatch of html.matchAll(trRe)) {
    const trInner = trMatch[1];

    // Collect all <td> cells within this row
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    for (const tdMatch of trInner.matchAll(tdRe)) {
      cells.push(tdMatch[1]);
    }

    if (cells.length < 3) continue;

    const col0 = clean(cells[0] ?? "");
    const col1 = clean(cells[1] ?? "");
    const col2Raw = cells[2] ?? "";
    const col3 = clean(cells[3] ?? "");

    // Skip header row
    if (/nombre\s+colegiado|apellido|nombre/i.test(col0)) continue;

    // Name must be non-trivial
    if (!col0 || col0.length < 2) continue;

    // Parse address/contact column: split by <br> tags
    const contactParts = col2Raw
      .split(/<br\s*\/?>/i)
      .map(clean)
      .filter(Boolean);

    // Extract email from mailto link
    const emailMatch = col2Raw.match(/href="mailto:([^"]+)"/i);
    const emailRaw = emailMatch ? emailMatch[1].trim() : undefined;

    // Phone is typically a numeric string (may include spaces, dashes, +)
    let phone: string | undefined;
    const addressParts: string[] = [];
    for (const part of contactParts) {
      // Spanish phone patterns: starts with 6,7,8,9 or +34, 9+ digits
      if (/^[+\d][\d\s\-().]{5,}$/.test(part)) {
        phone = phone ?? part.replace(/\s+/g, "");
      } else if (emailRaw && part === emailRaw) {
        // skip — it's the email text repeated
      } else {
        addressParts.push(part);
      }
    }
    const address = addressParts.join(", ") || undefined;

    rows.push({
      nameRaw: col0,
      empresa: col1 || undefined,
      address,
      phone,
      email: emailRaw,
      forma: col3 || undefined,
    });
  }

  return rows;
}

/**
 * Convert "APELLIDO APELLIDO, Nombre" to "Nombre Apellido Apellido".
 * Falls back to title-casing the raw string if no comma is found.
 */
function normaliseDisplayName(raw: string): string {
  const idx = raw.indexOf(",");
  if (idx > 0) {
    const last = raw.slice(0, idx).trim();
    const first = raw.slice(idx + 1).trim();
    const full = `${first} ${last}`;
    return full
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // No comma — return title-cased
  return raw
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Stable source ID derived from the colegiado name (no numeric ID exposed). */
function makeSourceId(nameRaw: string, empresa?: string): string {
  const key = nameRaw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  const empresaKey = empresa
    ? empresa
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 30)
    : "";
  return `mediadores-seguros-madrid:${key}${empresaKey ? ":" + empresaKey : ""}`;
}

function toRecord(row: MediadorRow): ScrapedProfessional | null {
  const displayName = normaliseDisplayName(row.nameRaw);
  if (!displayName || displayName.length < 2) return null;
  const sourceId = makeSourceId(row.nameRaw, row.empresa);
  const formaLabel = row.forma
    ? (FORMA_LABELS[row.forma] ?? `Forma ${row.forma}`)
    : undefined;
  // For corporate mediators, use the empresa name as the display name;
  // for individual brokers (forma 1, 7, 17, 19), use the person name.
  const isIndividual = !row.empresa || row.empresa.length < 2;
  const name = isIndividual ? displayName : row.empresa!;
  return normalise({
    source: "mediadores-seguros-madrid" as ScrapeSource,
    country: COUNTRY,
    sourceId,
    name,
    categoryKey: CATEGORY,
    citySlug: DEFAULT_CITY,
    phone: row.phone,
    email: row.email,
    address: row.address,
    metadata: {
      country: COUNTRY,
      province: "Madrid",
      authority: "Colegio de Mediadores de Seguros de Madrid",
      verified_by_authority: true,
      colegiado_name: displayName,
      empresa: row.empresa ?? null,
      forma_code: row.forma ?? null,
      forma_label: formaLabel ?? null,
    },
  });
}

async function fetchPage(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(SOURCE_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[mediadores-seguros-madrid] HTTP ${res.status} from ${SOURCE_URL}`,
      );
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(
      `[mediadores-seguros-madrid] fetch error: ${(e as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function runMediadoresSegurosMadrid(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!mediadoresSegurosMadridSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_MEDIADORES_SEGUROS_MADRID_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const html = await fetchPage();
  if (!html) {
    console.warn(
      "[mediadores-seguros-madrid] failed to fetch directory page — endpoint may be down",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawRows = parseRows(html);
  console.log(
    `[mediadores-seguros-madrid] parsed ${rawRows.length} rows from directory`,
  );

  const records: ScrapedProfessional[] = [];
  const seenSourceIds = new Set<string>();
  for (const row of rawRows) {
    if (records.length >= cap) break;
    const rec = toRecord(row);
    if (!rec) continue;
    if (seenSourceIds.has(rec.sourceId)) continue;
    seenSourceIds.add(rec.sourceId);
    records.push(rec);
  }

  if (records.length === 0) {
    console.warn(
      "[mediadores-seguros-madrid] 0 records after parsing — HTML structure may have changed",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[mediadores-seguros-madrid] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
