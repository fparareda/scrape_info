import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * APEGA — Association of Professional Engineers and Geoscientists of
 * Alberta. Member directory at
 *   https://www.apega.ca/members/member-directory
 *
 * Pre-flight 2026-05: the directory is an ASP.NET WebForms search that
 * posts an antiforgery / __VIEWSTATE / __EVENTVALIDATION tuple before
 * returning rows. A complete reverse-engineering is out of scope for
 * this commit; we ship as a STUB that attempts the public XHR shape
 * if it exists (some deployments expose /api/Directory/Search) and
 * cleanly degrades to 0 rows + warning otherwise. Replace the body of
 * \`fetchAll\` once the endpoint is reverse-engineered.
 *
 * Off by default; \`PROLIO_RUN_APEGA=true\`.
 */

const BASE = "https://www.apega.ca";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 5000;
const PAGE_SIZE = 50;
const CATEGORY: CategoryKey = "ingenieria";

const AB_CITY_MAP: Record<string, string> = {
  calgary: "calgary",
  edmonton: "edmonton",
};
const DEFAULT_CITY = "calgary";

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return AB_CITY_MAP[k] ?? DEFAULT_CITY;
}

interface ApegaRow {
  Name?: string;
  FullName?: string;
  FirstName?: string;
  LastName?: string;
  City?: string;
  MemberId?: string;
  RegistrationNumber?: string;
  MembershipType?: string;
  [k: string]: unknown;
}

async function tryEndpoint(page: number): Promise<ApegaRow[]> {
  const candidates = [
    `${BASE}/api/Directory/Search?page=${page}&pageSize=${PAGE_SIZE}`,
    `${BASE}/Members/MemberDirectory/Search?page=${page}&pageSize=${PAGE_SIZE}`,
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
      if (Array.isArray(json)) return json as ApegaRow[];
      if (json && typeof json === "object") {
        const o = json as Record<string, unknown>;
        for (const k of ["data", "results", "items", "Results"]) {
          const v = o[k];
          if (Array.isArray(v)) return v as ApegaRow[];
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

function rowName(r: ApegaRow): string | undefined {
  if (r.FullName) return r.FullName;
  if (r.Name) return r.Name;
  if (r.FirstName && r.LastName) return `${r.FirstName} ${r.LastName}`;
  return r.LastName ?? r.FirstName;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (let page = 1; out.length < limit; page += 1) {
    const rows = await tryEndpoint(page);
    if (rows.length === 0) break;
    for (const r of rows) {
      const name = rowName(r)?.trim();
      const num = (r.MemberId ?? r.RegistrationNumber ?? "").toString().trim();
      if (!name || !num) continue;
      const key = `apega:${num}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        normalise({
          source: "tssa" as ScrapeSource,
          sourceId: key,
          name: toTitleCase(name),
          categoryKey: CATEGORY,
          citySlug: mapCity(r.City),
          licenseNumber: num,
          metadata: {
            country: "CA",
            province: "AB",
            authority: "APEGA",
            verified_by_authority: true,
            membership_type: r.MembershipType,
          },
        }),
      );
      if (out.length >= limit) return out;
    }
    if (rows.length < PAGE_SIZE) break;
    await delay(1500);
  }
  return out;
}

export const apegaSource: ScraperSource = {
  name: "tssa" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_APEGA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runApega(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!apegaSource.enabled()) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_APEGA_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const records = await fetchAll(cap);
  if (records.length === 0) {
    console.warn(
      "[apega] no rows — directory likely requires __VIEWSTATE handshake (TODO)",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[apega] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
