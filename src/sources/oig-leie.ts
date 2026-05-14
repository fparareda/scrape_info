import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv, pick } from "./_bulk-utils.js";

/**
 * OIG LEIE — List of Excluded Individuals/Entities (HHS Office of
 * Inspector General). The federal blacklist of healthcare providers
 * barred from billing Medicare / Medicaid / any federal health program.
 *
 * Discovery (2026-05-14 probe):
 *   HEAD https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv
 *   →  200 OK · text/csv · 15,468,470 bytes · attachment "UPDATED.csv"
 *
 * Columns:
 *   LASTNAME, FIRSTNAME, MIDNAME, BUSNAME, GENERAL, SPECIALTY, UPIN,
 *   NPI, DOB, ADDRESS, CITY, STATE, ZIP, EXCLTYPE, EXCLDATE, REINDATE,
 *   WAIVERDATE, WVRSTATE
 *
 * Sample rows:
 *   "","","", "#1 MARKETING SERVICE, INC", "OTHER BUSINESS",
 *      "SOBER HOME", "", "0000000000", "",
 *      "239 BRIGHTON BEACH AVENUE","BROOKLYN","NY","11235",
 *      "1128a1","20200319","00000000","00000000",""
 *   "","","", "1 BEST CARE, INC", "OTHER BUSINESS",
 *      "HOME HEALTH AGENCY", ...
 *
 * ~75k rows expected (federal exclusions). REINDATE=00000000 means
 * still excluded; non-zero = reinstated (we drop reinstated rows).
 *
 * Categoría Prolio: `medicina` as a proxy (taxonomy doesn't have a
 * "healthcare-blacklist" slot; CIF/NPI cross-match is the real consumer).
 * `metadata.risk_flag = "OIG_LEIE_EXCLUDED"` is the trust-badge signal —
 * inverse of SAT-EFOS in MX.
 *
 * Off by default. `PROLIO_RUN_OIG_LEIE=true` activates. Cap via
 * `PROLIO_OIG_LEIE_LIMIT` (default 100000 = full list). Monthly cron —
 * see .github/workflows/scrape-oig-leie.yml.
 */

const DEFAULT_URL =
  process.env.PROLIO_OIG_LEIE_CSV ||
  "https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv";
const DEFAULT_LIMIT = 100_000;
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const CATEGORY: CategoryKey = "medicina";

function normaliseUsPhone(): undefined {
  return undefined; // LEIE doesn't expose phone numbers
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((p) => (p.length > 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ");
}

function buildName(row: Record<string, string>): string | undefined {
  const last = pick(row, ["lastname"]).trim();
  const first = pick(row, ["firstname"]).trim();
  const mid = pick(row, ["midname"]).trim();
  const bus = pick(row, ["busname"]).trim();
  if (last || first) {
    return [first, mid, last]
      .filter((p) => p.length > 0)
      .map(titleCase)
      .join(" ");
  }
  if (bus) return titleCase(bus);
  return undefined;
}

async function downloadCsv(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      console.error(`[oig-leie] ${response.status} on ${url}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    console.error(`[oig-leie] network error: ${(error as Error).message}`);
    return null;
  }
}

export const oigLeieEnabled = (): boolean =>
  process.env.PROLIO_RUN_OIG_LEIE === "true";

export const oigLeieSource: ScraperSource = {
  name: "oig-leie" as ScrapeSource,
  enabled: oigLeieEnabled,
  async fetch() {
    return [];
  },
};

export async function runOigLeie(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!oigLeieEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_OIG_LEIE_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const cityIndex = new Map<string, string>();
  try {
    const usCities = await getCities({ country: "US" });
    for (const c of usCities) {
      cityIndex.set(c.name.trim().toLowerCase(), c.slug);
    }
  } catch (e) {
    console.warn(`[oig-leie] failed to load US cities: ${(e as Error).message}`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  if (cityIndex.size === 0) {
    console.warn(`[oig-leie] no US cities loaded — aborting`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  return withScrapeRun("oig-leie", async () => {
    const csv = await downloadCsv(DEFAULT_URL);
    if (!csv) return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    const rows = parseCsv(csv);
    const out: ScrapedProfessional[] = [];
    const seen = new Set<string>();
    let droppedNoCity = 0;
    let droppedReinstated = 0;

    for (const row of rows) {
      if (out.length >= limit) break;
      const reindate = pick(row, ["reindate"]).trim();
      // REINDATE != "00000000" → reinstated, no longer excluded; drop.
      if (reindate && reindate !== "00000000" && reindate !== "0") {
        droppedReinstated += 1;
        continue;
      }
      const name = buildName(row);
      if (!name) continue;
      const npi = pick(row, ["npi"]).trim();
      const upin = pick(row, ["upin"]).trim();
      const excldate = pick(row, ["excldate"]).trim();
      const idCore =
        npi && npi !== "0000000000"
          ? `npi:${npi}`
          : upin
          ? `upin:${upin}`
          : `name:${name}:${excldate}`;
      const sourceId = `oig-leie:${idCore}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const cityRaw = pick(row, ["city"]).trim().toLowerCase();
      const citySlug = cityRaw ? cityIndex.get(cityRaw) : undefined;
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      const addrParts = [
        pick(row, ["address"]),
        pick(row, ["city"]),
        pick(row, ["state"]),
        pick(row, ["zip"]),
      ]
        .map((p) => (typeof p === "string" ? p.trim() : ""))
        .filter((p) => p.length > 0);

      out.push(
        normalise({
          source: "oig-leie" as ScrapeSource,
          sourceId,
          name,
          categoryKey: CATEGORY,
          citySlug,
          phone: normaliseUsPhone(),
          address: addrParts.length > 0 ? addrParts.join(", ") : undefined,
          licenseNumber: npi && npi !== "0000000000" ? npi : undefined,
          metadata: {
            country: "US",
            state: pick(row, ["state"]) || undefined,
            authority: "HHS OIG",
            verified_by_authority: true,
            risk_flag: "OIG_LEIE_EXCLUDED",
            npi: npi && npi !== "0000000000" ? npi : undefined,
            upin: upin || undefined,
            excl_type: pick(row, ["excltype"]) || undefined,
            excl_date: excldate || undefined,
            specialty: pick(row, ["specialty"]) || undefined,
            general_category: pick(row, ["general"]) || undefined,
            waiver_date:
              pick(row, ["waiverdate"]).trim() !== "00000000"
                ? pick(row, ["waiverdate"]) || undefined
                : undefined,
            fuente_url: DEFAULT_URL,
          },
        }),
      );
    }

    console.log(
      `[oig-leie] parsed=${out.length} of ${rows.length} csv rows ` +
        `(droppedNoCity=${droppedNoCity}, droppedReinstated=${droppedReinstated})`,
    );

    if (out.length === 0)
      return { rowsFetched: rows.length, rowsUpserted: 0, rowsSkipped: 0 };
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(out);
    return {
      rowsFetched: rows.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
      metadata: { kept: out.length, droppedNoCity, droppedReinstated },
    };
  }).then((r) => ({
    fetched: r?.rowsFetched ?? 0,
    inserted: 0,
    updated: 0,
    skipped: r?.rowsSkipped ?? 0,
  }));
}
