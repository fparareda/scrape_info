import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * CPSA — College of Physicians and Surgeons of Alberta.
 *
 * Public search at https://search.cpsa.ca/ is a JS-driven page that
 * issues XHR to /api/PhysicianSearch returning JSON. Endpoint shape
 * verified circa 2024 but not guaranteed; we parse defensively.
 *
 * Off by default; `PROLIO_RUN_CPSA=true`.
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const BASE = "https://search.cpsa.ca";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT_PER_CITY = 1000;
const PAGE_SIZE = 50;

const AB_CITIES: Array<{ slug: string; query: string }> = [
  { slug: "calgary", query: "Calgary" },
  { slug: "edmonton", query: "Edmonton" },
];

interface CpsaRow {
  Name?: string;
  FullName?: string;
  FirstName?: string;
  LastName?: string;
  PrimaryWorkLocation?: string;
  PracticeCity?: string;
  City?: string;
  RegistrationNumber?: string;
  Number?: string;
  Status?: string;
  [k: string]: unknown;
}

async function fetchPage(city: string, page: number): Promise<CpsaRow[]> {
  const candidates = [
    `${BASE}/api/PhysicianSearch?city=${encodeURIComponent(city)}&page=${page}&pageSize=${PAGE_SIZE}`,
    `${BASE}/api/physicians/search?city=${encodeURIComponent(city)}&page=${page}&pageSize=${PAGE_SIZE}`,
    `${BASE}/api/search?term=${encodeURIComponent(city)}&page=${page}`,
  ];
  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json,*/*" },
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const ct = response.headers.get("content-type") || "";
      if (!ct.includes("json")) continue;
      const json = (await response.json()) as unknown;
      if (Array.isArray(json)) return json as CpsaRow[];
      if (json && typeof json === "object") {
        const o = json as Record<string, unknown>;
        for (const k of ["data", "results", "items", "Results"]) {
          const v = o[k];
          if (Array.isArray(v)) return v as CpsaRow[];
        }
      }
    } catch {
      /* try next */
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

function rowName(r: CpsaRow): string | undefined {
  if (r.FullName) return r.FullName;
  if (r.Name) return r.Name;
  if (r.FirstName && r.LastName) return `${r.FirstName} ${r.LastName}`;
  return r.LastName ?? r.FirstName;
}

async function fetchAll(limitPerCity: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (const city of AB_CITIES) {
    let collected = 0;
    for (let p = 1; collected < limitPerCity; p += 1) {
      const rows = await fetchPage(city.query, p);
      if (rows.length === 0) break;
      for (const r of rows) {
        const name = rowName(r)?.trim();
        const num = (r.RegistrationNumber ?? r.Number ?? "").toString().trim();
        if (!name || !num) continue;
        const key = `cpsa:${num}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          normalise({
            source: "cpsbc" as ScrapeSource, // reuse college type; metadata.authority distinguishes
            country: "CA",
            sourceId: key,
            name: toTitleCase(name),
            categoryKey: "medicina",
            citySlug: city.slug,
            licenseNumber: num,
            metadata: {
              country: "CA",
              province: "AB",
              authority: "CPSA",
              verified_by_authority: true,
              status: r.Status,
            },
          }),
        );
        collected += 1;
        if (collected >= limitPerCity) break;
      }
      if (rows.length < PAGE_SIZE) break;
      await delay(1500);
    }
    console.log(`[cpsa] ${city.slug} → ${collected} rows`);
  }
  return out;
}

export const cpsaSource: ScraperSource = {
  name: "cpsbc" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CPSA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCpsa(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cpsaSource.enabled()) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_CPSA_LIMIT_PER_CITY ?? DEFAULT_LIMIT_PER_CITY);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT_PER_CITY;
  const records = await fetchAll(cap);
  if (records.length === 0) {
    console.warn("[cpsa] no rows fetched — endpoint may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cpsa] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
