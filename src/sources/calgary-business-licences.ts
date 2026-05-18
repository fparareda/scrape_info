import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * City of Calgary — Business Licences (Open Data, Socrata).
 *
 * Catalog: https://data.calgary.ca/resource/vdjc-pybd.json
 * Curl-verified 2026-05-18 HTTP/2 200, no auth, 22,641 rows.
 *
 * Fields:
 *   getbusid, tradename, homeoccind, address, comdistcd, comdistnm,
 *   licencetypes, first_iss_dt, exp_dt, jobstatusdesc,
 *   point { type, coordinates: [lng, lat] }
 *
 * Realistic landing: 4-8k after CategoryKey filter (rest are wholesalers,
 * vending, retail food etc. that don't map).
 *
 * Env:
 *   PROLIO_RUN_CALGARY_BUSINESS_LICENCES=true   enable
 *   PROLIO_CALGARY_BUSINESS_LICENCES_LIMIT      cap (default 50_000)
 */

const ENDPOINT = "https://data.calgary.ca/resource/vdjc-pybd.json";
const DEFAULT_LIMIT = 50_000;
const PAGE_SIZE = 5_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const CATEGORY_MAP: Record<string, CategoryKey> = {
  "ELECTRICAL CONTRACTOR": "electricidad",
  ELECTRICIAN: "electricidad",
  "PLUMBING CONTRACTOR": "fontaneria",
  PLUMBER: "fontaneria",
  "GASFITTING CONTRACTOR": "fontaneria",
  "HEATING CONTRACTOR": "hvac",
  "REFRIGERATION CONTRACTOR": "hvac",
  "AIR CONDITIONING CONTRACTOR": "hvac",
  "AUTOMOTIVE REPAIR": "mecanica",
  "AUTO BODY SHOP": "mecanica",
  "VEHICLE REPAIR": "mecanica",
  "TIRE INSTALLATION": "mecanica",
  CARPENTER: "carpinteria",
  CARPENTRY: "carpinteria",
  "WOOD WORKING": "carpinteria",
  PHARMACY: "farmacia",
  "DRUG STORE": "farmacia",
  LOCKSMITH: "cerrajero",
  "LAW OFFICE": "abogado",
  "LEGAL SERVICES": "abogado",
  LAWYER: "abogado",
  "DENTAL OFFICE": "dentista",
  "DENTAL CLINIC": "dentista",
  DENTIST: "dentista",
  "MEDICAL CLINIC": "medicina",
  PHYSICIAN: "medicina",
  CHIROPRACTOR: "fisioterapia",
  PHYSIOTHERAPY: "fisioterapia",
  "PHYSIOTHERAPY CLINIC": "fisioterapia",
  VETERINARIAN: "veterinario",
  "VETERINARY CLINIC": "veterinario",
  "VETERINARY HOSPITAL": "veterinario",
  ARCHITECT: "arquitecto",
  ENGINEER: "ingenieria",
  "PROFESSIONAL ENGINEER": "ingenieria",
  PSYCHOLOGIST: "psicologia",
  ACCOUNTANT: "fiscal",
  NOTARY: "notario",
};

function mapCategory(raw: string | undefined): CategoryKey | undefined {
  if (!raw) return undefined;
  const norm = raw.trim().toUpperCase();
  if (CATEGORY_MAP[norm]) return CATEGORY_MAP[norm];
  for (const key of Object.keys(CATEGORY_MAP)) {
    if (norm.includes(key)) return CATEGORY_MAP[key];
  }
  return undefined;
}

interface CalgaryRow {
  getbusid?: string;
  tradename?: string;
  address?: string;
  licencetypes?: string;
  jobstatusdesc?: string;
  comdistnm?: string;
  first_iss_dt?: string;
  point?: { type?: string; coordinates?: [number, number] };
}

export const calgaryBusinessLicencesSource: ScraperSource = {
  name: "calgary-business-licences" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CALGARY_BUSINESS_LICENCES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCalgaryBusinessLicences(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!calgaryBusinessLicencesSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const cap = Number(
    process.env.PROLIO_CALGARY_BUSINESS_LICENCES_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_LIMIT;

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let totalRaw = 0;

  while (out.length < limit) {
    const url = `${ENDPOINT}?$limit=${PAGE_SIZE}&$offset=${offset}&$order=getbusid`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      console.error(`[calgary-business-licences] net: ${(e as Error).message}`);
      break;
    }
    if (!resp.ok) {
      console.error(`[calgary-business-licences] ${resp.status} on ${url}`);
      break;
    }
    const page = (await resp.json()) as CalgaryRow[];
    if (!Array.isArray(page) || page.length === 0) break;
    totalRaw += page.length;

    for (const row of page) {
      if (out.length >= limit) break;
      if (row.jobstatusdesc && row.jobstatusdesc.toLowerCase() !== "licensed")
        continue;
      const cat = mapCategory(row.licencetypes);
      if (!cat) continue;
      const id = row.getbusid;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = row.tradename?.trim();
      if (!name) continue;
      const coords = row.point?.coordinates;
      out.push(
        normalise({
          source: "calgary-business-licences",
          sourceId: `calgary-business-licences:${id}`,
          name,
          categoryKey: cat,
          citySlug: "calgary",
          address: row.address?.trim() || undefined,
          lat: coords && typeof coords[1] === "number" ? coords[1] : undefined,
          lng: coords && typeof coords[0] === "number" ? coords[0] : undefined,
          licenseNumber: id,
          metadata: {
            country: "CA",
            province: "AB",
            authority: "City of Calgary — Business Licensing",
            verified_by_authority: true,
            category_raw: row.licencetypes,
            district: row.comdistnm,
            issued: row.first_iss_dt,
          },
        }),
      );
    }
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }

  console.log(
    `[calgary-business-licences] raw=${totalRaw} mapped=${out.length}`,
  );

  const sink = getSink();
  const res = await sink.upsert(out);
  console.log(
    `[calgary-business-licences] done — inserted=${res.inserted} ` +
      `updated=${res.updated} skipped=${res.skipped}`,
  );
  return {
    fetched: out.length,
    inserted: res.inserted,
    updated: res.updated,
    skipped: res.skipped,
  };
}
