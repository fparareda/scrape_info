import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * Connecticut eLicense — State Licenses and Credentials.
 *
 * Source: Connecticut Department of Administrative Services / DCP.
 * Dataset: https://data.ct.gov/Business/State-Licenses-and-Credentials/ngch-56tr/about_data
 * Socrata JSON API: https://data.ct.gov/resource/ngch-56tr.json
 *
 * Pre-flight (2026-05-16):
 *   - 866,855 active records across 800+ credential types.
 *   - No login, no captcha, no Cloudflare. Socrata open government
 *     platform, designed for programmatic bulk access.
 *   - robots.txt returns 404 (no disallow rules).
 *   - Fields: credentialid, name, businessname, dba, fullcredentialcode,
 *     credentialtype, credentialnumber, credential, status, active,
 *     address, city, state, zip, issuedate, expirationdate.
 *   - Updated daily by the state.
 *
 * Taxonomy-mapped credential types (active counts):
 *   electricidad   — Electrical Unlimited Contractor (5,632)
 *                  + Electrical Unlimited Journeyperson (6,611)
 *                  + Electrical Limited Contractor/Journeyperson
 *   fontaneria     — Plumbing & Piping (all sub-types, ~2k)
 *   hvac           — Heating, Piping & Cooling (4,120)
 *   carpinteria    — Home Improvement Contractor (27,249)
 *   arquitecto     — Architect (4,903)
 *   ingenieria     — Professional Engineer (13,962)
 *   medicina       — Physician/Surgeon (24,275) + RN + PA + EMT
 *   dentista       — Dentist (3,435) + Dental Hygienist (3,711)
 *   fisioterapia   — Physical Therapist (5,941)
 *   veterinario    — Veterinarian (~800)
 *   psicologia     — Psychologist (~1,500)
 *
 * Off by default. Enable via `PROLIO_RUN_CONNECTICUT_ELICENSE=true`.
 * Weekly via .github/workflows/scrape-connecticut-elicense.yml.
 */

const SOCRATA_API =
  "https://data.ct.gov/resource/ngch-56tr.json";
const DEFAULT_LIMIT = 5000;
const PAGE_SIZE = 1000; // Socrata default max per request
const REQUEST_DELAY_MS = 1100;
const REQUEST_TIMEOUT_MS = 60_000;

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// ---------------------------------------------------------------------------
// Credential → CategoryKey mapping
// ---------------------------------------------------------------------------

/**
 * Map a Connecticut credential label to our taxonomy.
 * The credential field is already human-readable (e.g. "Dentist",
 * "Electrical Unlimited Contractor").
 */
function credentialToCategory(credential: string): CategoryKey | undefined {
  const c = credential.toLowerCase();

  // electricidad
  if (c.includes("electrical") || c.includes("electrician")) return "electricidad";

  // fontaneria — plumbing (but NOT heating/cooling piping which is HVAC)
  if (
    (c.includes("plumb") || c.includes("piping")) &&
    !c.includes("heating") &&
    !c.includes("cooling")
  )
    return "fontaneria";

  // hvac — heating, piping & cooling
  if (c.includes("heating") || c.includes("cooling") || c.includes("refrigerat")) return "hvac";

  // carpinteria — home improvement / general contractor / builder
  if (
    c.includes("home improvement") ||
    c.includes("general contractor") ||
    c.includes("building contractor") ||
    c.includes("new home") ||
    c.includes("residential builder")
  )
    return "carpinteria";

  // arquitecto
  if (c.includes("architect")) return "arquitecto";

  // ingenieria
  if (
    c.includes("professional engineer") ||
    c.includes("land surveyor") ||
    c.includes("engineer - ")
  )
    return "ingenieria";

  // medicina — physicians, nurses, EMTs, PAs
  if (
    c.includes("physician") ||
    c.includes("surgeon") ||
    c.includes("registered nurse") ||
    c.includes("practical nurse") ||
    c.includes("advanced practice registered") ||
    c.includes("physician assistant") ||
    c.includes("emergency medical") ||
    c.includes("radiographer") ||
    c.includes("radiologist")
  )
    return "medicina";

  // dentista
  if (c.includes("dentist") || c.includes("dental")) return "dentista";

  // fisioterapia
  if (c.includes("physical therap") || c.includes("physiotherap")) return "fisioterapia";

  // veterinario
  if (c.includes("veterinar")) return "veterinario";

  // psicologia
  if (c.includes("psycholog")) return "psicologia";

  // cerrajero — not present in CT dataset (no locksmith credential type)

  return undefined;
}

// ---------------------------------------------------------------------------
// Socrata API types
// ---------------------------------------------------------------------------

interface SocrataRow {
  credentialid?: string;
  name?: string;
  businessname?: string;
  dba?: string;
  fullcredentialcode?: string;
  credentialtype?: string;
  credentialnumber?: string;
  credential?: string;
  status?: string;
  statusreason?: string;
  active?: string | number;
  issuedate?: string;
  effectivedate?: string;
  expirationdate?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  recordrefreshedon?: string;
}

// ---------------------------------------------------------------------------
// Delay helper
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchPage(offset: number): Promise<SocrataRow[] | null> {
  const url =
    `${SOCRATA_API}?$where=active=1` +
    `&$limit=${PAGE_SIZE}` +
    `&$offset=${offset}` +
    `&$order=credentialid`;

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
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(
        `[connecticut-elicense] HTTP ${response.status} on offset=${offset}`,
      );
      return null;
    }
    const data = await response.json() as SocrataRow[];
    return data;
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[connecticut-elicense] fetch error offset=${offset}: ${(err as Error).message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main fetch loop
// ---------------------------------------------------------------------------

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCategory = 0;
  let droppedNoCity = 0;
  let droppedNoName = 0;
  let offset = 0;

  while (out.length < limit) {
    const rows = await fetchPage(offset);

    if (!rows) {
      console.warn(`[connecticut-elicense] empty/error at offset=${offset}, stopping`);
      break;
    }
    if (rows.length === 0) {
      console.log(`[connecticut-elicense] no more rows at offset=${offset}`);
      break;
    }

    for (const row of rows) {
      if (out.length >= limit) break;

      // Resolve display name: prefer businessname/dba, fall back to name
      const name = (
        row.businessname?.trim() ||
        row.dba?.trim() ||
        row.name?.trim() ||
        ""
      );
      if (!name) {
        droppedNoName += 1;
        continue;
      }

      const credLabel = (row.credential ?? "").trim();
      const category = credentialToCategory(credLabel);
      if (!category) {
        droppedNoCategory += 1;
        continue;
      }

      const cityRaw = (row.city ?? "").trim();
      const citySlug = slugify(cityRaw);
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      // credentialid is the stable unique key in the dataset
      const credId = (row.credentialid ?? "").trim();
      const sourceId = `connecticut-elicense:${credId || row.fullcredentialcode || name}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const address = [
        row.address?.trim(),
        cityRaw,
        row.state?.trim() || "CT",
        row.zip?.trim(),
      ]
        .filter(Boolean)
        .join(", ");

      out.push(
        normalise({
          source: "connecticut-elicense",
          sourceId,
          name,
          categoryKey: category,
          citySlug,
          address: address || undefined,
          licenseNumber: row.fullcredentialcode?.trim() || row.credentialnumber?.trim() || undefined,
          metadata: {
            country: "US",
            state: "CT",
            authority: "Connecticut DCP / eLicense",
            verified_by_authority: true,
            credential_type: credLabel,
            credential_status: row.status?.trim(),
            issue_date: row.issuedate?.trim(),
            expiration_date: row.expirationdate?.trim(),
          },
        }),
      );
    }

    offset += rows.length;
    console.log(
      `[connecticut-elicense] offset=${offset} parsed=${out.length} dropped_nocat=${droppedNoCategory} dropped_nocity=${droppedNoCity}`,
    );

    if (rows.length < PAGE_SIZE) {
      // Last page
      break;
    }

    await delay(REQUEST_DELAY_MS);
  }

  console.log(
    `[connecticut-elicense] total parsed=${out.length} ` +
      `droppedNoName=${droppedNoName} droppedNoCategory=${droppedNoCategory} ` +
      `droppedNoCity=${droppedNoCity}`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const connecticutElicenseSource: ScraperSource = {
  name: "connecticut-elicense",
  enabled() {
    return process.env.PROLIO_RUN_CONNECTICUT_ELICENSE === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runConnecticutElicense(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!connecticutElicenseSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(
    process.env.PROLIO_CONNECTICUT_ELICENSE_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[connecticut-elicense] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
