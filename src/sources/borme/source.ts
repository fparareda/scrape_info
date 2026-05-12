import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeTarget,
} from "../../types.js";
import { normalise } from "../../normalise.js";
import { fetchSumario, type SumarioItem } from "./fetch-sumario.js";
import { parseBormePdf, type BormeEntry } from "./parse-pdf.js";
import {
  CATEGORY_TO_CNAE,
  classifyCategory,
  extractCnaeCode,
  matchCitySlug,
} from "./filter.js";

/**
 * BORME (Boletín Oficial del Registro Mercantil) source — CNAE-filtered.
 *
 * Daily, BORME publishes every company formation in Spain. We pull the
 * BOE Open Data sumario (PRIMARY: https://boe.es/datosabiertos/api/borme/sumario/{date}.json,
 * actually XML in practice — the JSON endpoint is alias-only and
 * empty for some days), grab Section A PDFs, and extract entries whose
 * CNAE / Objeto social matches Prolio's target professions.
 *
 * Why not Libre BORME (https://libreborme.net) or datos.gob.es bulk?
 *   - Libre BORME's public API was last updated in 2022 and pre-flight
 *     2026-04-24 returned 503 on /v1/companies — kept as documented
 *     fallback only.
 *   - datos.gob.es ships monthly bulk dumps; resolution is too coarse
 *     for a daily backfill cron.
 * BOE Open Data wins on freshness + uptime + zero-auth.
 *
 * Scope kept deliberately narrow:
 *   - Only Section A (Empresarios. Actos inscritos) — new registrations.
 *   - Only acts that include "Constitución" — ignores later modifications.
 *   - CNAE filter: see `filter.ts > CNAE_TO_CATEGORY`. Entries whose
 *     CNAE doesn't map to a CategoryKey are dropped (logged for backfill).
 *   - City resolution by substring match against Prolio's ES city slugs;
 *     anything outside is dropped.
 *   - source_id prefers CIF (stable, unique per company); falls back to
 *     `borme:{registroAbbrev}:{hoja}` when CIF can't be parsed.
 *
 * Env:
 *   - PROLIO_SCRAPE_BORME=true   to enable
 *   - PROLIO_BORME_DAYS=90       default trailing-day window for backfill
 *   - PROLIO_BORME_LIMIT=1000    cap per run (defends against runaway
 *                                processing on long backfills)
 */

const DEFAULT_DAYS_BACK = 90;
const DEFAULT_LIMIT = 1000;
const FETCH_DELAY_MS = 800;
const BUSINESS_PURPOSE_MAX = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daysBackList(days: number): Date[] {
  const now = new Date();
  const list: Date[] = [];
  for (let i = 1; i <= days; i += 1) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i),
    );
    list.push(d);
  }
  return list;
}

async function downloadPdf(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`BORME PDF ${url} → HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function entryToProfessional(
  entry: BormeEntry,
  item: SumarioItem,
): ScrapedProfessional | null {
  if (!entry.acts.includes("Constitución")) return null;

  // Prefer an explicit CNAE in the Objeto social — fall back to keyword
  // classification when (as usual) BORME omits the code.
  const explicitCnae = extractCnaeCode(entry.objetoSocial);
  const categoryKey = classifyCategory(entry.objetoSocial);
  if (!categoryKey) return null;

  const cnae = explicitCnae ?? CATEGORY_TO_CNAE[categoryKey] ?? null;

  const citySlug = matchCitySlug(entry.domicilio);
  if (!citySlug) return null;

  // CIF is the most stable per-company identifier; reg/hoja is only as
  // unique as the registry sheet (rare collisions when companies move).
  const sourceId = entry.cif
    ? `borme:${entry.cif}`
    : entry.registroAbbrev && entry.hoja
      ? `borme:${entry.registroAbbrev}:${entry.hoja}`
      : `borme:${item.identificador}:${entry.entryNum}`;

  const businessPurpose = entry.objetoSocial?.slice(0, BUSINESS_PURPOSE_MAX);

  return normalise({
    source: "borme",
    sourceId,
    name: entry.companyName,
    categoryKey,
    citySlug,
    address: entry.domicilio,
    cif: entry.cif,
    foundedAt: entry.constitutedAt,
    headline: businessPurpose?.slice(0, 160),
    description: businessPurpose,
    metadata: {
      source: "borme",
      cnae,
      administrators: entry.administrators,
      business_purpose: businessPurpose,
      constituted_at: entry.constitutedAt,
      entryNum: entry.entryNum,
      identificador: item.identificador,
      provinceLabel: item.provinceLabel,
      registroAbbrev: entry.registroAbbrev,
      hoja: entry.hoja,
      capital: entry.capital,
      pdfUrl: item.pdfUrl,
    },
  });
}

let cache: Promise<ScrapedProfessional[]> | null = null;

async function fetchAllBorme(): Promise<ScrapedProfessional[]> {
  const days = Number(process.env.PROLIO_BORME_DAYS ?? DEFAULT_DAYS_BACK);
  const limit = Number(process.env.PROLIO_BORME_LIMIT ?? DEFAULT_LIMIT);
  const dates = daysBackList(days);

  console.log(
    `[borme] fetching last ${dates.length} days, cap=${limit} ` +
      `(${dates[0]?.toISOString().slice(0, 10)} → ${
        dates[dates.length - 1]?.toISOString().slice(0, 10)
      })`,
  );

  const out = new Map<string, ScrapedProfessional>();
  let pdfsProcessed = 0;
  let entriesKept = 0;

  outer: for (const date of dates) {
    let items: SumarioItem[];
    try {
      items = await fetchSumario(date);
    } catch (error) {
      console.error(`[borme] sumario failed:`, error);
      continue;
    }
    if (items.length === 0) continue;

    for (const item of items) {
      if (out.size >= limit) {
        console.log(`[borme] hit PROLIO_BORME_LIMIT=${limit}, stopping`);
        break outer;
      }
      await delay(FETCH_DELAY_MS);
      try {
        const bytes = await downloadPdf(item.pdfUrl);
        const entries = await parseBormePdf(bytes);
        pdfsProcessed += 1;

        for (const entry of entries) {
          const record = entryToProfessional(entry, item);
          if (!record) continue;
          if (!out.has(record.sourceId)) {
            out.set(record.sourceId, record);
            entriesKept += 1;
            if (out.size >= limit) break;
          }
        }
      } catch (error) {
        console.error(`[borme] ${item.identificador} failed:`, error);
      }
    }
  }

  console.log(
    `[borme] processed ${pdfsProcessed} PDFs, kept ${entriesKept} matches`,
  );
  return Array.from(out.values());
}

export const bormeSource: ScraperSource = {
  name: "borme",

  enabled() {
    return process.env.PROLIO_SCRAPE_BORME === "true";
  },

  async fetch(target: ScrapeTarget): Promise<ScrapedProfessional[]> {
    if (!cache) cache = fetchAllBorme();
    const all = await cache;
    return all.filter(
      (r) =>
        r.citySlug === target.citySlug && r.categoryKey === target.categoryKey,
    );
  },
};
