import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Colegios de Notarios — fan-out a 6 colegios estatales mexicanos
 * (excluyendo CDMX que ya cubre `colegio-notarios-cdmx`).
 *
 *   - Jalisco         https://notariosjalisco.com/directorio/        (~285 HTML tabla)
 *   - Puebla          https://notariospuebla.mx/  PDF + páginas por distrito (~200)
 *   - Estado de Méx.  https://colegiodenotariosedomex.org.mx/        (~300+)
 *   - Yucatán         https://www.notariadoyucateco.org.mx/notarios.php (~140)
 *   - Nuevo León      http://cnpnl.org.mx/directorio/                (~161 HTML)
 *   - Baja Calif. Sur https://colegiodenotariosbcs.org.mx/directorio-consulta.php (~50)
 *
 * Cada sub-fetcher es tolerante a fallos: si el parser no encuentra filas
 * devuelve []. La métrica final agrega por estado en logs.
 *
 * Off by default. `PROLIO_RUN_COLEGIOS_NOTARIOS_MX=true`.
 * Cap con `PROLIO_COLEGIOS_NOTARIOS_MX_LIMIT` (default 1500).
 */

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const CATEGORY: CategoryKey = "notario";
const REQUEST_TIMEOUT_MS = 45_000;
const REQUEST_DELAY_MS = 800;
const DEFAULT_LIMIT = 1500;
const SOURCE: ScrapeSource = "colegios-notarios-mx" as ScrapeSource;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpGet(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html,*/*",
        "Accept-Language": "es-MX,es;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[colegios-notarios-mx] ${res.status} ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[colegios-notarios-mx] network ${url}: ${(err as Error).message}`);
    return null;
  }
}

async function httpGetBinary(url: string): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": CHROME_UA },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[colegios-notarios-mx] ${res.status} PDF ${url}`);
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[colegios-notarios-mx] network PDF ${url}: ${(err as Error).message}`);
    return null;
  }
}

async function httpPost(url: string, body: URLSearchParams): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html,*/*",
        "Accept-Language": "es-MX,es;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[colegios-notarios-mx] ${res.status} POST ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[colegios-notarios-mx] network POST ${url}: ${(err as Error).message}`);
    return null;
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&oacute;/g, "ó")
    .replace(/&uacute;/g, "ú")
    .replace(/&ntilde;/g, "ñ")
    .replace(/\s+/g, " ")
    .trim();
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE =
  /(?:\(?\d{2,3}\)?[\s.-]?)?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?:[\s.-]?\d{1,4})?/;

interface NotarioRow {
  num: string;
  name: string;
  address?: string;
  phone?: string;
  email?: string;
}

interface ColegioResult {
  estado: string;
  estadoSlug: string;
  citySlug: string;
  colegio: string;
  rows: NotarioRow[];
}

// ---------------------------------------------------------------------------
// Jalisco — tabla HTML server-side renderizada
// ---------------------------------------------------------------------------
async function fetchJalisco(): Promise<NotarioRow[]> {
  const html = await httpGet("https://notariosjalisco.com/directorio/");
  if (!html) return [];
  const rows: NotarioRow[] = [];
  // Greedy <tr>…</tr> match — table is the main structure on the page.
  const TR_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = TR_RE.exec(html)) !== null) {
    const cells: string[] = [];
    const TD_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c: RegExpExecArray | null;
    while ((c = TD_RE.exec(m[1])) !== null) cells.push(stripHtml(c[1]));
    if (cells.length < 6) continue;
    const numRaw = cells[0];
    if (!/^\d{1,4}$/.test(numRaw)) continue;
    // Header guard
    const joined = cells.join(" ");
    if (/NOTARIO|NOMBRE|APELLIDO/i.test(cells[1])) continue;
    // Heuristic: name = cells[1..3], notaria-col often cells[4], rest address/phone/email.
    const nameParts = [cells[1], cells[2], cells[3]].filter(Boolean).join(" ").trim();
    if (nameParts.length < 4) continue;
    const emailMatch = joined.match(EMAIL_RE);
    const phoneMatch = joined.match(PHONE_RE);
    const addressCell =
      cells.slice(5, Math.min(cells.length, 9)).find((x) => /[A-Z]{3,}/.test(x)) ?? undefined;
    rows.push({
      num: numRaw,
      name: nameParts.replace(/\s+/g, " ").trim(),
      address: addressCell,
      phone: phoneMatch?.[0],
      email: emailMatch?.[0]?.toLowerCase(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Puebla — PDF oficial + páginas distrito (fallback)
// ---------------------------------------------------------------------------
const PUEBLA_PDF_CANDIDATES = [
  "https://notariospuebla.mx/assets/files/DIRECTORIO-DENOTARIOS2025-2027_18ago25.pdf",
  "https://notariospuebla.mx/assets/files/DIRECTORIO-DENOTARIOS.pdf",
];
const PUEBLA_DISTRITOS = [
  "puebla-puebla",
  "atlixco-puebla",
  "cholula-puebla",
  "huejotzingo-puebla",
  "tehuacan-puebla",
  "tepeaca-puebla",
  "san-juan-de-los-llanos-puebla",
  "chalchicomula-puebla",
  "izucar-de-matamoros-puebla",
  "acatlan-de-osorio-puebla",
  "tecali-puebla",
  "chiautla-de-tapia-puebla",
  "huauchinango-puebla",
  "zacapoaxtla-puebla",
  "tetela-de-ocampo-puebla",
  "zacatlan-puebla",
  "tlatlauquitepec-puebla",
  "alatriste-puebla",
  "teziutlan-puebla",
];

async function fetchPueblaPdf(): Promise<NotarioRow[]> {
  for (const url of PUEBLA_PDF_CANDIDATES) {
    const pdf = await httpGetBinary(url);
    if (!pdf) continue;
    try {
      const doc = await getDocument({ data: pdf, useSystemFonts: true }).promise;
      const lines: string[] = [];
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const yMap = new Map<number, Array<{ x: number; str: string }>>();
        for (const item of content.items) {
          if (!("str" in item) || !item.str) continue;
          const tx = (item as { transform: number[] }).transform;
          const y = Math.round(tx[5]);
          const arr = yMap.get(y) ?? [];
          arr.push({ x: tx[4], str: item.str });
          yMap.set(y, arr);
        }
        const ys = [...yMap.keys()].sort((a, b) => b - a);
        for (const y of ys) {
          const cells = yMap.get(y)!.sort((a, b) => a.x - b.x);
          lines.push(cells.map((c) => c.str).join(" "));
        }
      }
      const rows: NotarioRow[] = [];
      // Match "NOTARIA NUM. NN <NOMBRE>"
      const HEAD_RE = /NOTAR[ÍI]A\s+(?:N[ÚU]M\.?|N[º°.])\s*0*(\d{1,4})\s+([A-ZÁÉÍÓÚÑa-záéíóúñ.\s']{6,120})/i;
      let cur: NotarioRow | null = null;
      let buffer = "";
      const flush = () => {
        if (!cur) return;
        const emailMatch = buffer.match(EMAIL_RE);
        const phoneMatch = buffer.match(PHONE_RE);
        cur.email = emailMatch?.[0]?.toLowerCase();
        cur.phone = phoneMatch?.[0];
        const addr = buffer
          .replace(EMAIL_RE, " ")
          .replace(/(?:\(\d{2,3}\)|\d{2,3})[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{1,4})?/g, " ")
          .replace(/\s{2,}/g, " ")
          .trim();
        if (addr.length > 8) cur.address = addr;
        rows.push(cur);
      };
      for (const line of lines) {
        const h = line.match(HEAD_RE);
        if (h) {
          flush();
          cur = { num: h[1].padStart(2, "0"), name: h[2].trim().replace(/\s+/g, " ") };
          buffer = "";
        } else if (cur) {
          buffer += " " + line;
        }
      }
      flush();
      if (rows.length > 0) return rows;
    } catch (err) {
      console.warn(`[colegios-notarios-mx] puebla PDF parse error: ${(err as Error).message}`);
    }
  }
  // Fallback: HTML distrito pages
  const out: NotarioRow[] = [];
  for (const d of PUEBLA_DISTRITOS) {
    await sleep(300);
    const html = await httpGet(
      `https://notariospuebla.mx/directorio-de-notarios-distrito-judicial-${d}.html`,
    );
    if (!html) continue;
    const TR_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m: RegExpExecArray | null;
    while ((m = TR_RE.exec(html)) !== null) {
      const cells: string[] = [];
      const TD_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let c: RegExpExecArray | null;
      while ((c = TD_RE.exec(m[1])) !== null) cells.push(stripHtml(c[1]));
      if (cells.length < 3) continue;
      const numRaw = cells[0].replace(/[^\d]/g, "");
      if (!/^\d{1,4}$/.test(numRaw)) continue;
      const joined = cells.join(" ");
      const emailMatch = joined.match(EMAIL_RE);
      const phoneMatch = joined.match(PHONE_RE);
      const nameCell = cells[1];
      if (!nameCell || nameCell.length < 4) continue;
      out.push({
        num: numRaw.padStart(2, "0"),
        name: nameCell.replace(/^NOT\.\s*/i, "").trim(),
        address: cells[4] || cells[3],
        phone: phoneMatch?.[0],
        email: emailMatch?.[0]?.toLowerCase(),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Estado de México — página directorio HTML + bloques por municipio
// ---------------------------------------------------------------------------
async function fetchEdomex(): Promise<NotarioRow[]> {
  const urls = [
    "https://colegiodenotariosedomex.org.mx/directorio-de-notarios",
    "https://colegiodenotariosedomex.org.mx/directorio-de-notarios.html",
    "https://colegiodenotariosedomex.org.mx/directorio.html",
  ];
  let html: string | null = null;
  for (const u of urls) {
    html = await httpGet(u);
    if (html && html.length > 1000) break;
  }
  if (!html) return [];
  const rows: NotarioRow[] = [];
  // Pattern: "Notaría NN" followed by name + contact block
  const RE = /Notar[íi]a\s+(?:No\.?|N[úu]m\.?)?\s*0*(\d{1,4})\s*[-–:]?\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\s']{4,120})/g;
  const text = stripHtml(html);
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = RE.exec(text)) !== null) {
    const num = m[1].padStart(2, "0");
    if (seen.has(num)) continue;
    seen.add(num);
    const ctxStart = m.index + m[0].length;
    const ctx = text.slice(ctxStart, ctxStart + 400);
    const emailMatch = ctx.match(EMAIL_RE);
    const phoneMatch = ctx.match(PHONE_RE);
    rows.push({
      num,
      name: m[2].trim().replace(/\s+/g, " "),
      phone: phoneMatch?.[0],
      email: emailMatch?.[0]?.toLowerCase(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Yucatán — notarios.php
// ---------------------------------------------------------------------------
async function fetchYucatan(): Promise<NotarioRow[]> {
  const html = await httpGet("https://www.notariadoyucateco.org.mx/notarios.php");
  if (!html) return [];
  const rows: NotarioRow[] = [];
  const text = stripHtml(html);
  const RE =
    /NOTARI[OA]\s+(?:N[ÚU]M\.?|N[º°.])\s*0*(\d{1,4})\s*[:.\-–]?\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\s']{4,120})/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = RE.exec(text)) !== null) {
    const num = m[1].padStart(2, "0");
    if (seen.has(num)) continue;
    seen.add(num);
    const ctx = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const emailMatch = ctx.match(EMAIL_RE);
    const phoneMatch = ctx.match(PHONE_RE);
    rows.push({
      num,
      name: m[2].trim().replace(/\s+/g, " "),
      phone: phoneMatch?.[0],
      email: emailMatch?.[0]?.toLowerCase(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Nuevo León — http://cnpnl.org.mx/directorio/  (HTTP only)
// ---------------------------------------------------------------------------
async function fetchNuevoLeon(): Promise<NotarioRow[]> {
  // Try HTTP first (site is HTTP-only per audit), fall back to HTTPS.
  let html =
    (await httpGet("http://cnpnl.org.mx/directorio/")) ??
    (await httpGet("https://cnpnl.org.mx/directorio/"));
  if (!html) return [];
  const rows: NotarioRow[] = [];
  const text = stripHtml(html);
  const RE =
    /Notar[íi]a\s+0*(\d{1,4})\s*[-–:]?\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\s']{4,120})/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = RE.exec(text)) !== null) {
    const num = m[1].padStart(2, "0");
    if (seen.has(num)) continue;
    seen.add(num);
    const ctx = text.slice(m.index + m[0].length, m.index + m[0].length + 500);
    const emailMatch = ctx.match(EMAIL_RE);
    const phoneMatch = ctx.match(PHONE_RE);
    rows.push({
      num,
      name: m[2].trim().replace(/\s+/g, " "),
      phone: phoneMatch?.[0],
      email: emailMatch?.[0]?.toLowerCase(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Baja California Sur — directorio-consulta.php (form POST)
// ---------------------------------------------------------------------------
async function fetchBcs(): Promise<NotarioRow[]> {
  const base = "https://colegiodenotariosbcs.org.mx/directorio-consulta.php";
  // Strategy: GET landing first, then POST empty filters to retrieve full table.
  await httpGet(base);
  const body = new URLSearchParams();
  body.append("numero", "");
  body.append("nombre", "");
  body.append("ciudad", "");
  body.append("colonia", "");
  body.append("buscar", "Buscar");
  let html = await httpPost(base, body);
  if (!html || html.length < 500) {
    // Fallback: maybe GET shows all
    html = await httpGet(base);
  }
  if (!html) return [];
  const rows: NotarioRow[] = [];
  const TR_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = TR_RE.exec(html)) !== null) {
    const cells: string[] = [];
    const TD_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c: RegExpExecArray | null;
    while ((c = TD_RE.exec(m[1])) !== null) cells.push(stripHtml(c[1]));
    if (cells.length < 3) continue;
    const numRaw = cells[0].replace(/[^\d]/g, "");
    if (!/^\d{1,4}$/.test(numRaw)) continue;
    const joined = cells.join(" ");
    if (/N[úu]mero|Nombre|Tel[eé]fono/i.test(cells[1])) continue;
    const emailMatch = joined.match(EMAIL_RE);
    const phoneMatch = joined.match(PHONE_RE);
    const nameCell = cells[1];
    if (!nameCell || nameCell.length < 4) continue;
    rows.push({
      num: numRaw.padStart(2, "0"),
      name: nameCell.replace(/\s+/g, " ").trim(),
      address: cells.find((x) => /col\.?|calle|av\.|avenida/i.test(x)),
      phone: phoneMatch?.[0],
      email: emailMatch?.[0]?.toLowerCase(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const colegios: Array<{
    estado: string;
    estadoSlug: string;
    citySlug: string;
    colegio: string;
    fetcher: () => Promise<NotarioRow[]>;
  }> = [
    {
      estado: "Jalisco",
      estadoSlug: "jalisco",
      citySlug: "guadalajara",
      colegio: "Colegio de Notarios de Jalisco",
      fetcher: fetchJalisco,
    },
    {
      estado: "Puebla",
      estadoSlug: "puebla",
      citySlug: "puebla",
      colegio: "Colegio de Notarios de Puebla",
      fetcher: fetchPueblaPdf,
    },
    {
      estado: "Estado de México",
      estadoSlug: "estado-de-mexico",
      citySlug: "tlalnepantla",
      colegio: "Colegio de Notarios del Estado de México",
      fetcher: fetchEdomex,
    },
    {
      estado: "Yucatán",
      estadoSlug: "yucatan",
      citySlug: "merida-mx",
      colegio: "Colegio de Notarios de Yucatán",
      fetcher: fetchYucatan,
    },
    {
      estado: "Nuevo León",
      estadoSlug: "nuevo-leon",
      citySlug: "monterrey",
      colegio: "Colegio de Notarios Públicos de Nuevo León",
      fetcher: fetchNuevoLeon,
    },
    {
      estado: "Baja California Sur",
      estadoSlug: "baja-california-sur",
      citySlug: "mazatlan",
      colegio: "Colegio de Notarios de Baja California Sur",
      fetcher: fetchBcs,
    },
  ];

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (const c of colegios) {
    if (out.length >= limit) break;
    await sleep(REQUEST_DELAY_MS);
    let rows: NotarioRow[] = [];
    try {
      rows = await c.fetcher();
    } catch (err) {
      console.warn(
        `[colegios-notarios-mx] ${c.estadoSlug} fetcher error: ${(err as Error).message}`,
      );
    }
    let added = 0;
    for (const r of rows) {
      if (out.length >= limit) break;
      const sid = `colegios-notarios-mx:${c.estadoSlug}:${r.num}`;
      if (seen.has(sid)) continue;
      seen.add(sid);
      out.push(
        normalise({
          source: SOURCE,
          sourceId: sid,
          name: r.name,
          categoryKey: CATEGORY,
          citySlug: c.citySlug,
          licenseNumber: r.num,
          phone: r.phone,
          email: r.email,
          address: r.address,
          metadata: {
            country: "MX",
            authority: `Colegio Notarios ${c.estado}`,
            colegio: c.colegio,
            estado: c.estado,
            estado_slug: c.estadoSlug,
            notaria_num: r.num,
            verified_by_authority: true,
          },
        }),
      );
      added += 1;
    }
    console.log(
      `[colegios-notarios-mx] estado="${c.estado}" parsed=${rows.length} added=${added} total=${out.length}`,
    );
  }
  return out;
}

export const colegiosNotariosMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_COLEGIOS_NOTARIOS_MX === "true";

export const colegiosNotariosMxSource: ScraperSource = {
  name: SOURCE,
  enabled: colegiosNotariosMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runColegiosNotariosMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!colegiosNotariosMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("colegios-notarios-mx", async () => {
    const rawLimit = Number(process.env.PROLIO_COLEGIOS_NOTARIOS_MX_LIMIT ?? DEFAULT_LIMIT);
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
