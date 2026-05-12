/**
 * Fetch the BORME daily sumario (one XML per day) and return the per-province
 * PDF URLs for Section A (Empresarios. Actos inscritos). Section B is ignored
 * — Prolio only cares about incorporations, appointments, and dissolutions.
 *
 * API reference: https://www.boe.es/datosabiertos/faq/borme.php
 */

const API_BASE = "https://boe.es/datosabiertos/api/borme/sumario";

export interface SumarioItem {
  /** e.g. "BORME-A-2026-73-28" */
  identificador: string;
  /** Province name (uppercase) as published — e.g. "MADRID", "A CORUÑA". */
  provinceLabel: string;
  pdfUrl: string;
  sizeBytes: number;
}

function extract(xml: string, tag: string): string | undefined {
  const match = xml.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );
  return match?.[1].trim();
}

function extractAttr(node: string, attr: string): string | undefined {
  const match = node.match(new RegExp(`${attr}\\s*=\\s*"([^"]*)"`));
  return match?.[1];
}

export async function fetchSumario(date: Date): Promise<SumarioItem[]> {
  const yyyymmdd =
    date.getUTCFullYear().toString() +
    String(date.getUTCMonth() + 1).padStart(2, "0") +
    String(date.getUTCDate()).padStart(2, "0");

  const response = await fetch(`${API_BASE}/${yyyymmdd}`, {
    headers: { Accept: "application/xml" },
  });
  // 404 = no BORME that day (weekends/holidays). Treat as empty.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`BORME sumario ${yyyymmdd} → HTTP ${response.status}`);
  }
  const xml = await response.text();

  if (xml.includes("<code>404</code>") || xml.includes("<data/>")) {
    return []; // belt-and-braces: some responses 200-wrap a 404 payload.
  }

  // Slice out only Sección A. BORME structures sections as <seccion codigo="A"> ...
  const sectionA = xml.match(
    /<seccion[^>]*codigo="A"[\s\S]*?<\/seccion>/,
  )?.[0];
  if (!sectionA) return [];

  const items: SumarioItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  for (const match of sectionA.matchAll(itemRe)) {
    const block = match[1];
    const identificador = extract(block, "identificador");
    const provinceLabel = extract(block, "titulo");
    const pdfNode = block.match(/<url_pdf[^>]*>[\s\S]*?<\/url_pdf>/)?.[0] ?? "";
    const pdfUrl = extract(pdfNode, "url_pdf");
    const sizeBytes = Number(extractAttr(pdfNode, "szBytes") ?? 0);
    if (identificador && provinceLabel && pdfUrl) {
      items.push({ identificador, provinceLabel, pdfUrl, sizeBytes });
    }
  }
  return items;
}
