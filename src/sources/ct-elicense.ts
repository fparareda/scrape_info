import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * Connecticut DCP eLicensing — State Licenses and Credentials.
 *
 * Socrata SODA API (open, no auth):
 *   https://data.ct.gov/resource/ngch-56tr.json
 *
 * Pre-flight 2026-05-27:
 *   - robots.txt at data.ct.gov only disallows /api/odata/ and
 *     /api/collocate* — the /resource/ Socrata SODA endpoint is allowed.
 *   - Total records: 2,636,505 across all statuses.
 *   - Active records: ~814k (ACTIVE + ACTIVE IN RENEWAL + subvariants).
 *   - Credentials map to 8 Prolio taxonomy categories (see CREDENTIAL_MAP).
 *   - city + state + address fields are populated on most records.
 *   - Professionals are licensed by CT but may reside anywhere in the US,
 *     so records land across all seeded US cities — not just Hartford.
 *   - Updated daily by CT DCP.
 *
 * Columns used:
 *   credentialid, name, credential, status, credentialnumber,
 *   issuedate, effectivedate, expirationdate, address, city, state, zip
 *
 * Strategy: paginated SODA fetch filtered to active statuses + credentials
 * that map to our taxonomy. We skip rows whose city doesn't match a seeded
 * US city (droppedNoCity). Cap via PROLIO_CT_ELICENSE_LIMIT (default 50000).
 *
 * Category: multiple (see CREDENTIAL_MAP). Off by default:
 * PROLIO_RUN_CT_ELICENSE=true. Monthly cron.
 */

const BASE_URL = "https://data.ct.gov/resource/ngch-56tr.json";
const AUTHORITY = "Connecticut DCP";
const STATE = "CT";
const DEFAULT_LIMIT = 50_000;
const PAGE_SIZE = 5_000;
const REQUEST_TIMEOUT_MS = 60_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

/**
 * Map from CT DCP credential label → Prolio CategoryKey.
 * Only credentials that map to a known category are scraped.
 * Case-insensitive substring matching is used for each key.
 */
const CREDENTIAL_MAP: Array<[string, CategoryKey]> = [
  // medicina
  ["Physician/Surgeon", "medicina"],
  ["Resident Physician", "medicina"],
  ["Podiatrist", "medicina"],
  ["Chiropractor", "medicina"],
  // enfermeria
  ["Registered Nurse", "enfermeria"],
  ["Licensed Practical Nurse", "enfermeria"],
  ["Advanced Practice Registered Nurse", "enfermeria"],
  // fisioterapia
  ["Physical Therapist", "fisioterapia"],
  ["Physical Therapist Assistant", "fisioterapia"],
  // dentista
  ["Dentist", "dentista"],
  ["Dental Hygienist", "dentista"],
  // farmacia
  ["Pharmacist", "farmacia"],
  ["Pharmacy Technician", "farmacia"],
  // arquitecto
  ["Architect", "arquitecto"],
  // ingenieria
  ["Professional Engineer", "ingenieria"],
  ["Land Surveyor", "ingenieria"],
  // electricidad
  ["Electrical Unlimited Contractor", "electricidad"],
  ["Electrical Unlimited Journeyperson", "electricidad"],
  ["Electrical Limited Contractor", "electricidad"],
  ["Electrical Limited Journeyperson", "electricidad"],
  ["Electrical Unlimited Apprentice", "electricidad"],
  // fontaneria
  ["Plumbing & Piping Unlimited Journeyperson", "fontaneria"],
  ["Plumbing & Piping Unlimited Contractor", "fontaneria"],
  ["Plumbing & Piping Limited Journeyperson", "fontaneria"],
  ["Plumbing & Piping Limited Contractor", "fontaneria"],
  // hvac
  ["Heating, Piping & Cooling", "hvac"],
  // carpinteria
  ["Home Improvement Contractor", "carpinteria"],
  ["New Home Construction Contractor", "carpinteria"],
  // psicologia
  ["Psychologist", "psicologia"],
  ["Licensed Clinical Social Worker", "psicologia"],
  ["Marriage and Family Therapist", "psicologia"],
  ["Licensed Professional Counselor", "psicologia"],
];

/** Active status values from the dataset. */
const ACTIVE_STATUSES = new Set([
  "ACTIVE",
  "ACTIVE IN RENEWAL",
  "ACTIVE UNDER REVIEW",
  "ACTIVE BY PROVISIONAL",
  "ACTIVE MILITARY",
]);

function mapCredential(credential: string): CategoryKey | undefined {
  const lower = credential.toLowerCase();
  for (const [key, cat] of CREDENTIAL_MAP) {
    if (lower.includes(key.toLowerCase())) return cat;
  }
  return undefined;
}

function buildSodaUrl(offset: number, limit: number): string {
  const params = new URLSearchParams({
    $limit: String(limit),
    $offset: String(offset),
    $order: "credentialid ASC",
  });
  return `${BASE_URL}?${params.toString()}`;
}

interface CtRecord {
  credentialid?: string;
  name?: string;
  credential?: string;
  status?: string;
  credentialnumber?: string;
  issuedate?: string;
  effectivedate?: string;
  expirationdate?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
}

async function fetchPage(url: string): Promise<CtRecord[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[ct-elicense] HTTP ${response.status} on ${url}`);
      return null;
    }
    return (await response.json()) as CtRecord[];
  } catch (e) {
    console.warn(`[ct-elicense] fetch failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const ctElicenseSource: ScraperSource = {
  name: "ct-elicense" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CT_ELICENSE === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCtElicense(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!ctElicenseSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_CT_ELICENSE_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  // Build city index: city name (lowercase) → slug.
  const cityIndex = new Map<string, string>();
  try {
    const usCities = await getCities({ country: "US" });
    for (const c of usCities) {
      cityIndex.set(c.name.trim().toLowerCase(), c.slug);
    }
  } catch (e) {
    console.warn(
      `[ct-elicense] failed to load US cities: ${(e as Error).message}`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  if (cityIndex.size === 0) {
    console.warn("[ct-elicense] no US cities loaded — aborting");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let droppedNoCity = 0;
  let droppedNoCategory = 0;
  let droppedInactive = 0;
  let totalFetched = 0;

  outer: while (records.length < cap) {
    const batchSize = Math.min(PAGE_SIZE, cap - records.length + 2_000);
    const url = buildSodaUrl(offset, batchSize);
    const page = await fetchPage(url);
    if (!page || page.length === 0) break;
    totalFetched += page.length;

    for (const row of page) {
      if (records.length >= cap) break outer;

      // Filter by active status
      const status = (row.status ?? "").toUpperCase().trim();
      if (!ACTIVE_STATUSES.has(status)) {
        droppedInactive += 1;
        continue;
      }

      // Map credential to category
      const credential = (row.credential ?? "").trim();
      const category = mapCredential(credential);
      if (!category) {
        droppedNoCategory += 1;
        continue;
      }

      // Require a name
      const name = (row.name ?? "").trim();
      if (!name) continue;

      // Map city to seeded slug
      const cityRaw = (row.city ?? "").trim().toLowerCase();
      const citySlug = cityRaw ? cityIndex.get(cityRaw) : undefined;
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      const credentialNumber = (row.credentialnumber ?? "").trim();
      const credentialId = (row.credentialid ?? "").trim();
      const sourceId = `ct-elicense:${credentialId || credentialNumber || `${name}:${credential}`}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const addrParts = [
        row.address ?? "",
        row.city ?? "",
        row.state ?? "",
        row.zip ?? "",
      ]
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      records.push(
        normalise({
          source: "ct-elicense" as ScrapeSource,
          country: "US",
          sourceId,
          name,
          categoryKey: category,
          citySlug,
          address: addrParts.length > 0 ? addrParts.join(", ") : undefined,
          licenseNumber: credentialNumber || undefined,
          metadata: {
            country: "US",
            state: STATE,
            authority: AUTHORITY,
            verified_by_authority: true,
            credential,
            credential_id: credentialId || undefined,
            status,
            issue_date: row.issuedate || undefined,
            effective_date: row.effectivedate || undefined,
            expiration_date: row.expirationdate || undefined,
            licensee_state: (row.state ?? "").trim() || undefined,
          },
        }),
      );
    }

    // If the page returned fewer than requested, we've hit the end.
    if (page.length < batchSize) break;
    offset += page.length;
  }

  console.log(
    `[ct-elicense] totalFetched=${totalFetched} kept=${records.length} ` +
      `droppedInactive=${droppedInactive} droppedNoCategory=${droppedNoCategory} ` +
      `droppedNoCity=${droppedNoCity}`,
  );

  if (records.length === 0) {
    console.warn("[ct-elicense] no records — dataset structure may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[ct-elicense] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
