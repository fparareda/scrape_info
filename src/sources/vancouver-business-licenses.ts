import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, pick } from "./_bulk-utils.js";

/**
 * City of Vancouver — Business Licences (Open Data Portal).
 *
 * Bulk export (CSV, ~60k rows/year, no auth, no Cloudflare):
 *   https://opendata.vancouver.ca/explore/dataset/business-licences/
 *
 * Direct CSV (Opendatasoft v2.1, semicolon-separated):
 *   https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/
 *     business-licences/exports/csv?lang=en&timezone=UTC&use_labels=true
 *
 * Curl-verified 2026-05-18:
 *   HTTP/2 200 · content-type text/csv · rate-limit 15000/day.
 *
 * Columns (semicolon-separated):
 *   FOLDERYEAR;LicenceRSN;LicenceNumber;LicenceRevisionNumber;
 *   BusinessName;BusinessTradeName;Status;IssuedDate;ExpiredDate;
 *   BusinessType;BusinessSubType;Unit;UnitType;House;Street;City;
 *   Province;Country;PostalCode;LocalArea;NumberofEmployees;FeePaid;
 *   ExtractDate;Geom;geo_point_2d
 *
 * Only "Issued" / "Pending" / "Gone Out of Business" + the latest
 * revision per LicenceNumber are kept. Each row contributes ONE
 * professional, slugified to citySlug=vancouver. Category mapping is
 * BusinessType-driven; only categories that exist in prolio
 * CategoryKey are exported (see CATEGORY_MAP below).
 *
 * Env:
 *   PROLIO_RUN_VANCOUVER_BUSINESS_LICENSES=true   enable
 *   PROLIO_VANCOUVER_BUSINESS_LICENSES_LIMIT=80000 cap (default)
 *
 * Universe estimate: ~60k issued licences / year; after category
 * filter expect ~8k-15k mapped rows.
 */

const DATA_URL =
  "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/" +
  "business-licences/exports/csv?lang=en&timezone=UTC&use_labels=true";
const DEFAULT_LIMIT = 80_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const CATEGORY_MAP: Record<string, CategoryKey> = {
  // Trade contractors — broken down further by sub-type below; this
  // is the catch-all when sub-type is empty/unknown.
  "trade contractor": "electricidad",
  electrical: "electricidad",
  electrician: "electricidad",
  "electrical contractor": "electricidad",
  plumber: "fontaneria",
  plumbing: "fontaneria",
  "plumbing contractor": "fontaneria",
  "gas contractor": "fontaneria",
  "gas fitter": "fontaneria",
  "heating contractor": "hvac",
  hvac: "hvac",
  "refrigeration contractor": "hvac",
  carpenter: "carpinteria",
  carpentry: "carpinteria",
  "auto repairs": "mecanica",
  "auto repair": "mecanica",
  "motor vehicle dealer": "mecanica",
  "vehicle dealer": "mecanica",
  pharmacy: "farmacia",
  drugstore: "farmacia",
  // White-collar
  "law firm": "abogado",
  lawyer: "abogado",
  "office - lawyer": "abogado",
  "accounting services": "fiscal",
  accountant: "fiscal",
  "architectural services": "arquitecto",
  architect: "arquitecto",
  "engineering services": "ingenieria",
  engineer: "ingenieria",
  "medical office": "medicina",
  "medical clinic": "medicina",
  physician: "medicina",
  "dental office": "dentista",
  dentist: "dentista",
  physiotherapist: "fisioterapia",
  "physiotherapy office": "fisioterapia",
  psychologist: "psicologia",
  "psychologist office": "psicologia",
  "registered nurse": "enfermeria",
  "nursing office": "enfermeria",
  veterinarian: "veterinario",
  "veterinary clinic": "veterinario",
  locksmith: "cerrajero",
  notary: "notario",
  "notary public": "notario",
};

function mapCategory(
  businessType: string,
  businessSubType: string,
): CategoryKey | undefined {
  const sub = businessSubType.trim().toLowerCase();
  if (sub && CATEGORY_MAP[sub]) return CATEGORY_MAP[sub];
  const t = businessType.trim().toLowerCase();
  if (t && CATEGORY_MAP[t]) return CATEGORY_MAP[t];
  // Substring sweep for compound types (e.g. "Boot & Shoe Repair").
  const hay = `${t} ${sub}`;
  for (const key of Object.keys(CATEGORY_MAP)) {
    if (hay.includes(key)) return CATEGORY_MAP[key];
  }
  return undefined;
}

function statusOk(s: string): boolean {
  const v = s.toLowerCase().trim();
  return v === "issued" || v === "pending";
}

export const vancouverBusinessLicensesSource: ScraperSource = {
  name: "vancouver-business-licenses" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_VANCOUVER_BUSINESS_LICENSES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runVancouverBusinessLicenses(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!vancouverBusinessLicensesSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_VANCOUVER_BUSINESS_LICENSES_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  let response: Response;
  try {
    response = await fetch(DATA_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/csv" },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    console.error(
      `[vancouver-business-licenses] network: ${(e as Error).message}`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  if (!response.ok) {
    console.error(
      `[vancouver-business-licenses] ${response.status} on ${DATA_URL}`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const text = await response.text();
  const rows = parseCsv(text);
  console.log(
    `[vancouver-business-licenses] parsed raw=${rows.length} from CSV`,
  );

  // De-dupe by LicenceNumber, keep highest revision.
  const latest = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const lic = pick(row, ["licencenumber", "licence_number"]);
    if (!lic) continue;
    const rev = Number(pick(row, ["licencerevisionnumber"]) || "0");
    const cur = latest.get(lic);
    if (!cur || rev > Number(pick(cur, ["licencerevisionnumber"]) || "0")) {
      latest.set(lic, row);
    }
  }

  const out: ScrapedProfessional[] = [];
  for (const row of latest.values()) {
    if (out.length >= limit) break;
    const status = pick(row, ["status"]);
    if (status && !statusOk(status)) continue;
    const businessType = pick(row, ["businesstype"]);
    const businessSubType = pick(row, ["businesssubtype"]);
    const cat = mapCategory(businessType, businessSubType);
    if (!cat) continue;
    const name =
      pick(row, ["businesstradename"]) || pick(row, ["businessname"]);
    if (!name) continue;
    const licence = pick(row, ["licencenumber"]);
    const house = pick(row, ["house"]);
    const street = pick(row, ["street"]);
    const city = pick(row, ["city"]) || "Vancouver";
    const province = pick(row, ["province"]) || "BC";
    const postal = pick(row, ["postalcode"]);
    const address = [
      [house, street].filter(Boolean).join(" "),
      city,
      province,
      postal,
    ]
      .filter(Boolean)
      .join(", ");
    const citySlug = slugify(city);
    if (!citySlug) continue;

    out.push(
      normalise({
        source: "vancouver-business-licenses",
        country: "CA",
        sourceId: `vancouver-business-licenses:${licence}`,
        name,
        categoryKey: cat,
        citySlug,
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "CA",
          province: "BC",
          authority: "City of Vancouver — Business Licences",
          verified_by_authority: true,
          business_type: businessType,
          business_sub_type: businessSubType,
          status,
          folder_year: pick(row, ["folderyear"]),
          local_area: pick(row, ["localarea"]),
        },
      }),
    );
  }

  const sink = getSink();
  const res = await sink.upsert(out);
  console.log(
    `[vancouver-business-licenses] done — fetched=${out.length} ` +
      `inserted=${res.inserted} updated=${res.updated} skipped=${res.skipped}`,
  );
  return {
    fetched: out.length,
    inserted: res.inserted,
    updated: res.updated,
    skipped: res.skipped,
  };
}
