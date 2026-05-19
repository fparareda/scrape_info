import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, frPostalCodeToCitySlug, toTitleCase } from "./_bulk-utils.js";

/**
 * Ordre National des Vétérinaires (CNOV) — French national veterinary registry.
 *
 * Source: https://extranet.veterinaire.fr/annuaires/veterinaires (React SPA
 * fronted by /api/directories/search-veterinaries — JSON, no auth, no
 * captcha). Verified 2026-05-07 via Chrome MCP + curl.
 *
 * The public web page lives at https://www.veterinaire.fr/annuaires (Drupal
 * landing) which links into the SPA. The SPA's React bundle revealed the
 * full API surface — the relevant endpoint for the *Tableau de l'Ordre*
 * (full registry, ~24k vets) is:
 *
 *     GET /api/directories/search-veterinaries
 *         ?departmentId=<int 1..110>
 *         &page=<0-based>
 *         &limit=<int, default 10, server-clamped to dataset size>
 *
 * Response shape:
 *   {
 *     pagination: { page, total, limit },
 *     veterinaries: [
 *       { ordinalNumber: 18613, lastname: "ACHARD", firstname: "Cécile",
 *         dpes: [
 *           { name: "CLINIQUE VÉTÉRINAIRE …", phone, ordinalNumber,
 *             address: { way, additionalAddress1, additionalAddress2,
 *                        zipCode, city, countryId } } ] } ]
 *   }
 *
 * The server requires *exactly one* filter, so we iterate department IDs.
 * Probed 2026-05-07: department IDs are dense from 1..95 (metropolitan
 * France) plus 96..109 for special administrative units (DOM-TOM and
 * military). IDs above 110 return 0 results. Total ≈ 24,400 vets.
 *
 * We cap the request volume per run via PROLIO_ORDRE_VET_FR_LIMIT
 * (default 2000), looping departments in numeric order and paging
 * inside each. With ~1 req/s + 100 rows/page, a 2000-row run takes
 * ~25s; a full sweep of all 24k rows takes ~5 minutes.
 *
 * Off by default. Toggle with PROLIO_RUN_ORDRE_VET_FR=true.
 */

const ENDPOINT =
  "https://extranet.veterinaire.fr/api/directories/search-veterinaries";
const PUBLIC_PAGE = "https://www.veterinaire.fr/annuaires";
const DEFAULT_LIMIT = 2000;
const PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 1000;
const REQUEST_JITTER_MS = 400;
const MAX_DEPARTMENT_ID = 110;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

interface VetAddress {
  way: string | null;
  additionalAddress1: string | null;
  additionalAddress2: string | null;
  zipCode: string | null;
  city: string | null;
  countryId: number | null;
}

interface VetDpe {
  name: string | null;
  phone: string | null;
  address: VetAddress | null;
  ordinalNumber: string | null;
}

interface VetRecord {
  ordinalNumber: number;
  lastname: string | null;
  firstname: string | null;
  dpes: VetDpe[] | null;
}

interface ApiResponse {
  pagination: { page: number; total: number; limit: number };
  veterinaries: VetRecord[];
}

function jitter(): number {
  return Math.floor(Math.random() * REQUEST_JITTER_MS);
}

async function fetchPage(
  departmentId: number,
  page: number,
): Promise<ApiResponse | null> {
  const url = `${ENDPOINT}?departmentId=${departmentId}&page=${page}&limit=${PAGE_SIZE}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Referer: `${PUBLIC_PAGE}/tableau-de-lordre`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    console.error(
      `[ordre-vet-fr] dept=${departmentId} page=${page} network: ${(error as Error).message}`,
    );
    return null;
  }
  if (!response.ok) {
    if (response.status === 403 || response.status === 503) {
      console.error(
        `[ordre-vet-fr] dept=${departmentId} page=${page} blocked ${response.status} — aborting`,
      );
      throw new Error(`ordre-vet-fr blocked: ${response.status}`);
    }
    console.error(
      `[ordre-vet-fr] dept=${departmentId} page=${page} ${response.status}`,
    );
    return null;
  }
  try {
    const json = (await response.json()) as ApiResponse;
    if (!json || !Array.isArray(json.veterinaries)) return null;
    return json;
  } catch (error) {
    console.error(
      `[ordre-vet-fr] dept=${departmentId} page=${page} parse: ${(error as Error).message}`,
    );
    return null;
  }
}

function buildAddress(addr: VetAddress | null | undefined): string | undefined {
  if (!addr) return undefined;
  const parts = [
    addr.way,
    addr.additionalAddress1,
    addr.additionalAddress2,
    [addr.zipCode, addr.city].filter(Boolean).join(" "),
  ]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function normalisePhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function recordToScraped(
  vet: VetRecord,
  departmentId: number,
): ScrapedProfessional | null {
  const last = (vet.lastname ?? "").trim();
  const first = (vet.firstname ?? "").trim();
  if (!last && !first) return null;
  const fullName = toTitleCase([first, last].filter(Boolean).join(" "));
  const dpe = (vet.dpes ?? [])[0] ?? null;
  const zip = dpe?.address?.zipCode ?? undefined;
  const citySlug = frPostalCodeToCitySlug(zip ?? undefined);
  if (!citySlug) return null;
  const address = buildAddress(dpe?.address ?? null);
  const phone = normalisePhone(dpe?.phone ?? null);
  return normalise({
    source: "ordre-vet-fr",
    country: "FR",
    sourceId: `ordre-vet-fr:${vet.ordinalNumber}`,
    name: fullName || "(Vétérinaire)",
    categoryKey: "veterinario",
    citySlug,
    licenseNumber: String(vet.ordinalNumber),
    phone,
    address,
    metadata: {
      country: "FR",
      authority: "Ordre National des Vétérinaires",
      verified_by_authority: true,
      department_id: departmentId,
      dpe_name: dpe?.name ?? null,
      dpe_ordinal_number: dpe?.ordinalNumber ?? null,
      postal_code: zip ?? null,
      city_raw: dpe?.address?.city ?? null,
    },
  });
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let totalProbed = 0;
  let totalSkipped = 0;

  for (let dept = 1; dept <= MAX_DEPARTMENT_ID; dept++) {
    if (out.length >= limit) break;
    // First page also gives us total — skip empty depts immediately.
    const first = await fetchPage(dept, 0);
    await delay(REQUEST_DELAY_MS + jitter());
    if (!first || first.pagination.total === 0) continue;
    const total = first.pagination.total;
    const pages = Math.ceil(total / PAGE_SIZE);
    let pageResults: ApiResponse | null = first;
    for (let page = 0; page < pages; page++) {
      if (out.length >= limit) break;
      if (page > 0) {
        pageResults = await fetchPage(dept, page);
        await delay(REQUEST_DELAY_MS + jitter());
        if (!pageResults) break;
      }
      for (const vet of pageResults.veterinaries) {
        if (out.length >= limit) break;
        totalProbed++;
        const key = `ordre-vet-fr:${vet.ordinalNumber}`;
        if (seen.has(key)) {
          totalSkipped++;
          continue;
        }
        const record = recordToScraped(vet, dept);
        if (!record) {
          totalSkipped++;
          continue;
        }
        seen.add(key);
        out.push(record);
      }
    }
    console.log(
      `[ordre-vet-fr] dept=${dept} total=${total} cumulative=${out.length}`,
    );
  }
  console.log(
    `[ordre-vet-fr] done — probed=${totalProbed} kept=${out.length} skipped=${totalSkipped}`,
  );
  return out;
}

export const ordreVetFrSource: ScraperSource = {
  name: "ordre-vet-fr",
  enabled() {
    return process.env.PROLIO_RUN_ORDRE_VET_FR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOrdreVetFr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!ordreVetFrSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_ORDRE_VET_FR_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[ordre-vet-fr] fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
