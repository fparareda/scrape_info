import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { splitCsvLine } from "./_bulk-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * Virginia DPOR — Department of Professional and Occupational Regulation.
 *
 * Real bulk source: DPOR publishes free "Regulant Lists" as ASCII
 * TAB-DELIMITED .txt files, refreshed every ~5 business days.
 *
 *   https://www.dpor.virginia.gov/RegulantLists
 *
 * We ingest the tradesman list (board 27 / occupation 10 — individual
 * electricians, plumbers, HVAC, gas fitters) plus the Class A/B/C
 * contractor lists (board 27 / occupation 01/05). Each row's LICENSE
 * SPECIALTY column carries one or more space-separated trade codes; a
 * single regulant can hold several (e.g. "MPLB MHVA MGFC MELE"), so we
 * emit one professional row per distinct matched category.
 *
 * Pre-flight (2026-06-19) — all verified HTTP 200, tab-delimited:
 *   2710  tradesmen (electrician/plumber/HVAC)  ~4.0 MB
 *   2701  Class A contractor                    ~0.5 MB
 *   2705a Class A contractor (cont.)            ~4.3 MB
 *   2705b Class B contractor                    ~1.2 MB
 *   2705c Class C contractor                    ~1.5 MB
 *  Combined ~45k+ active regulants.
 *
 * Columns (tab-separated header):
 *   BOARD, OCCUPATION, CERTIFICATE #, INDIVIDUAL NAME, BUSINESS NAME,
 *   FIRST LINE ADDRESS, SECOND LINE ADDRESS, P O BOX #, CITY, STATE,
 *   FIVE DIGIT ZIP CODE, ZIP CODE EXTENSION, PROVINCE, COUNTRY,
 *   POSTAL CODE, EXPIRATION DATE, CERTIFICATION DATE, LICENSE RANK,
 *   LICENSE SPECIALTY, EMAILADDRESS
 * (Phone numbers are NOT included — DPOR strips them.)
 *
 * Specialty trade codes → CategoryKey (substring match on each token):
 *   *ELE* (MELE/JELE/ELE)         → electricidad
 *   *PLB* (MPLB/JPLB/PLB)         → fontaneria
 *   token has HVA or GFC (MHVA/JHVA/MGFC) → hvac (HVAC + gas fitting)
 *   CBC/RBC/BLD (building classes)        → carpinteria (general construction)
 *
 * Off by default. Enable via `PROLIO_RUN_VIRGINIA_DPOR=true`.
 * Cap via `PROLIO_VIRGINIA_DPOR_LIMIT` (default 100000).
 */

const SOURCE_NAME = "virginia-dpor" as const;
const DEFAULT_LIMIT = 100_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const BASE =
  "https://www.dpor.virginia.gov/sites/default/files/Records%20and%20Documents/Regulant%20List";

// Default regulant lists to ingest. Override the whole set with a
// comma-separated PROLIO_VIRGINIA_DPOR_FILES (file stems, no extension).
const DEFAULT_FILES = ["2710", "2701", "2705a", "2705b", "2705c"];

function specialtyToCategories(specialty: string): CategoryKey[] {
  const cats = new Set<CategoryKey>();
  for (const tokenRaw of specialty.split(/\s+/)) {
    const t = tokenRaw.trim().toUpperCase();
    if (!t) continue;
    if (t.includes("ELE")) cats.add("electricidad");
    else if (t.includes("PLB")) cats.add("fontaneria");
    else if (t.includes("HVA") || t.includes("GFC")) cats.add("hvac");
    else if (t === "CBC" || t === "RBC" || t === "BLD")
      cats.add("carpinteria");
  }
  return [...cats];
}

function normaliseHeaderKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseTsv(text: string): Array<Record<string, string>> {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0], "\t").map(normaliseHeaderKey);
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i], "\t");
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = (cells[j] ?? "").trim();
    }
    out.push(row);
  }
  return out;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchFile(stem: string): Promise<Array<Record<string, string>>> {
  const url = `${BASE}/${stem}__crnt.txt`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/plain" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      console.error(`[virginia-dpor] HTTP ${res.status} on ${url}`);
      return [];
    }
    return parseTsv(await res.text());
  } catch (error) {
    console.error(
      `[virginia-dpor] network error on ${stem}: ${(error as Error).message}`,
    );
    return [];
  }
}

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
}

export async function runVirginiaDporFiles(
  client: SupabaseClient,
  opts: RunOptions = {},
): Promise<{ scanned: number; accepted: number; written: number }> {
  const batchSize = opts.batchSize ?? 500;
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const sink = getSink({ trustCitySlugs: true });
  const files = (process.env.PROLIO_VIRGINIA_DPOR_FILES
    ? process.env.PROLIO_VIRGINIA_DPOR_FILES.split(",").map((s) => s.trim())
    : DEFAULT_FILES
  ).filter(Boolean);

  let scanned = 0;
  let accepted = 0;
  let written = 0;
  let buffer: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const res = await sink.upsert(buffer);
    written += res.inserted + res.updated;
    buffer = [];
  };

  for (const stem of files) {
    if (accepted >= maxRows) break;
    const rows = await fetchFile(stem);
    for (const row of rows) {
      if (accepted >= maxRows) break;
      scanned += 1;

      const specialty =
        row["license_specialty"] ?? row["license_specialty_"] ?? "";
      const categories = specialtyToCategories(specialty);
      if (categories.length === 0) continue;

      const licNum = row["certificate"] ?? row["certificate_"];
      if (!licNum) continue;

      const rawName =
        row["business_name"] || row["individual_name"] || "";
      const name = rawName ? titleCase(rawName) : "";
      if (!name) continue;

      const cityRaw = row["city"];
      const stateRaw = row["state"] || "VA";
      let citySlug = "";
      if (cityRaw && stateRaw.toUpperCase() === "VA") {
        const cityResult = await ensureCity(client, {
          name: titleCase(cityRaw),
          state: "VA",
          country: "US",
        });
        if (cityResult) citySlug = cityResult.slug;
      }

      const street = [row["first_line_address"], row["second_line_address"]]
        .filter(Boolean)
        .join(" ")
        .trim();
      const zip = row["five_digit_zip_code"];
      const address = [street, cityRaw, stateRaw, zip]
        .filter(Boolean)
        .join(", ");

      for (const category of categories) {
        if (accepted >= maxRows) break;
        const dedupeKey = `${licNum}:${category}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        buffer.push({
          source: SOURCE_NAME as ScrapeSource,
          sourceId: `virginia-dpor:${licNum}:${category}`,
          name,
          categoryKey: category,
          country: "US",
          citySlug,
          address: address || undefined,
          licenseNumber: licNum,
          metadata: {
            country: "US",
            state: "VA",
            authority: "Virginia DPOR",
            verified_by_authority: true,
            dpor_specialty: specialty.trim(),
            dpor_rank: row["license_rank"],
            expiration_date: row["expiration_date"],
          },
        });
        accepted += 1;
        if (buffer.length >= batchSize) await flush();
      }
    }
  }
  await flush();

  const cs = getCityUpsertStats();
  console.log(
    `[virginia-dpor] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

export const virginiaDporSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_VIRGINIA_DPOR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runVirginiaDpor(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!virginiaDporSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_VIRGINIA_DPOR_LIMIT ?? DEFAULT_LIMIT);
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runVirginiaDporFiles(client, {
    maxRows,
  });
  return {
    fetched: accepted,
    inserted: written,
    updated: 0,
    skipped: scanned - accepted,
  };
}
