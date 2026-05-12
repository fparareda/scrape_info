import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Parse a single BORME Section A PDF into individual company entries.
 *
 * BORME entries follow a predictable layout:
 *
 *   {entryNum} - {COMPANY NAME}.
 *      Constitución. Comienzo de operaciones: ... Objeto social: ... Domicilio: ... Capital: ...
 *      Nombramientos. ...
 *      Datos registrales.   S 8 , H {REG_ABBREV} {HOJA}, I/A ... ({DATE}).
 *      {entryNum+1} - {COMPANY NAME}.
 *      ...
 *
 * We extract the constitución acts (only act type Prolio cares about) and the
 * "Datos registrales" trailer so each record has a stable source_id of
 * `{registroAbbrev}:{hoja}` (or CIF when present) — persists across future
 * BORMEs for the same company.
 */

export interface BormeEntry {
  entryNum: number;
  companyName: string;
  acts: string[];
  objetoSocial?: string;
  domicilio?: string;
  capital?: string;
  registroAbbrev?: string;
  hoja?: string;
  /** Spanish CIF, when present in the entry body. */
  cif?: string;
  /** ISO date (YYYY-MM-DD) of the constitución act, parsed from the
   *  `Datos registrales` trailer. Undefined when format is unfamiliar. */
  constitutedAt?: string;
  /** Names appearing under `Nombramientos.` (administradores, consejeros,
   *  apoderados). Capped at 10 to bound bad parses. */
  administrators: string[];
  body: string;
}

const SECTION_KEYS = [
  "Constitución.",
  "Objeto social:",
  "Domicilio:",
  "Capital:",
  "Nombramientos.",
  "Ceses/Dimisiones.",
  "Revocaciones.",
  "Disolución.",
  "Declaración de unipersonalidad.",
  "Reapertura hoja registral.",
  "Cambio de denominación social.",
  "Cambio de objeto social.",
  "Cambio de domicilio social.",
  "Ampliación de capital.",
  "Reducción de capital.",
  "Otros conceptos:",
  "Situación concursal.",
  "Fe de erratas:",
  "Datos registrales.",
];

async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  const doc = await getDocument({ data: pdfBytes, useSystemFonts: true })
    .promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" "),
    );
  }
  return pages.join("\n");
}

function extractField(
  body: string,
  key: string,
  nextKeys: string[],
): string | undefined {
  const idx = body.indexOf(key);
  if (idx === -1) return undefined;
  const start = idx + key.length;
  let end = body.length;
  for (const k of nextKeys) {
    const at = body.indexOf(k, start);
    if (at !== -1 && at < end) end = at;
  }
  const value = body.slice(start, end).trim();
  return value.length > 0 ? value : undefined;
}

const ENTRY_ANCHOR =
  /(^|\s)(\d{4,7})\s*-\s*([A-ZÁÉÍÓÚÜÑ0-9][^.]{1,200}?)\.(?=\s)/g;

const DATOS_REG_RE =
  /Datos registrales\.\s*S\s*\d+\s*,?\s*H\s*([A-Z]{1,4})?\s*(\d{3,})/i;

// CIF: letter + 7 digits + control char (digit or letter). Supports
// "B12345678" and "A1234567C" forms BORME publishes.
const CIF_RE = /\b([A-HJ-NP-SUVW]\d{7}[\dA-J])\b/;

// `Datos registrales` trailer often ends with `(YYYY.MM.DD)` or
// `(DD.MM.YYYY)` — the inscription date, treated as constitución date
// for `Constitución` acts.
const REG_DATE_RE =
  /\((\d{4})\.(\d{2})\.(\d{2})\)|\((\d{2})\.(\d{2})\.(\d{4})\)/;

export async function parseBormePdf(
  pdfBytes: Uint8Array,
): Promise<BormeEntry[]> {
  const text = await extractPdfText(pdfBytes);

  const anchors: Array<{ num: number; name: string; start: number; end: number }> =
    [];
  ENTRY_ANCHOR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENTRY_ANCHOR.exec(text)) !== null) {
    anchors.push({
      num: Number(match[2]),
      name: match[3].trim(),
      start: match.index + match[1].length,
      end: ENTRY_ANCHOR.lastIndex,
    });
  }

  const entries: BormeEntry[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    const bodyStart = anchor.end;
    const bodyEnd = i + 1 < anchors.length ? anchors[i + 1].start : text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();

    const acts: string[] = [];
    for (const key of SECTION_KEYS) {
      if (key.endsWith(".") && body.includes(key)) acts.push(key.slice(0, -1));
    }

    const objetoSocial = extractField(body, "Objeto social:", SECTION_KEYS);
    const domicilio = extractField(body, "Domicilio:", SECTION_KEYS);
    const capital = extractField(body, "Capital:", SECTION_KEYS);

    const regMatch = body.match(DATOS_REG_RE);
    const registroAbbrev = regMatch?.[1]?.trim();
    const hoja = regMatch?.[2];

    const cifMatch = body.match(CIF_RE);
    const cif = cifMatch?.[1];

    let constitutedAt: string | undefined;
    const dateMatch = body.match(REG_DATE_RE);
    if (dateMatch) {
      if (dateMatch[1]) {
        constitutedAt = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
      } else if (dateMatch[6]) {
        constitutedAt = `${dateMatch[6]}-${dateMatch[5]}-${dateMatch[4]}`;
      }
    }

    const administrators = extractAdministrators(body);

    entries.push({
      entryNum: anchor.num,
      companyName: cleanupCompanyName(anchor.name),
      acts,
      objetoSocial: objetoSocial ? collapse(objetoSocial) : undefined,
      domicilio: domicilio ? collapse(domicilio) : undefined,
      capital: capital ? collapse(capital) : undefined,
      registroAbbrev,
      hoja,
      cif,
      constitutedAt,
      administrators,
      body,
    });
  }

  return entries;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Pull names listed under `Nombramientos.` until the next section key.
 * BORME shapes vary; most common is:
 *   `Nombramientos. Adm. Unico: GARCIA LOPEZ JUAN. Adm. solidario: ...`
 * Splits on role markers and captures the trailing name token before
 * the next sentence terminator. Capped at 10.
 */
function extractAdministrators(body: string): string[] {
  const start = body.indexOf("Nombramientos.");
  if (start === -1) return [];
  const tail = body.slice(start + "Nombramientos.".length);
  let stop = tail.length;
  for (const k of [
    "Ceses/Dimisiones.",
    "Datos registrales.",
    "Revocaciones.",
    "Disolución.",
    "Otros conceptos:",
  ]) {
    const at = tail.indexOf(k);
    if (at !== -1 && at < stop) stop = at;
  }
  const slice = tail.slice(0, stop);
  const out: string[] = [];
  const roleRe =
    /(?:Adm\.[^:]*|Administrador[^:]*|Consejero[^:]*|Apoderado[^:]*|Liquidador[^:]*|Auditor[^:]*|Presidente[^:]*|Secretario[^:]*):\s*([^.;]+?)(?=\.|;|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = roleRe.exec(slice)) !== null && out.length < 10) {
    const name = collapse(m[1]).replace(/\s*\([^)]*\)\s*$/, "");
    if (name.length >= 4 && name.length <= 80) out.push(name);
  }
  return out;
}

/** BORME names come SHOUTED. Leave SL/SA/SLP/SLU/SAU and initials as-is. */
function cleanupCompanyName(raw: string): string {
  return raw
    .split(/\s+/)
    .map((token) => {
      if (/^(SL|SA|SLP|SLU|SAU|SCP|SAL|SLL|SRL|S\.L\.|S\.A\.)$/i.test(token)) {
        return token.toUpperCase();
      }
      if (token.length <= 2) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join(" ")
    .replace(/\s+\./g, ".")
    .trim();
}
