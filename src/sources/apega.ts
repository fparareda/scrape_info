import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * APEGA — Association of Professional Engineers and Geoscientists of
 * Alberta. The public member directory at
 *   https://www.apega.ca/members/member-directory
 * is backed by an OData v1 feed at
 *   https://ods.apega.ca/odata/v1/Register/members
 *
 * Pre-flight 2026-05-13: confirmed total `@odata.count` = 71,477.
 * Max page size accepted is 500 ($top=1000 returns empty). We
 * paginate `$skip=N&$top=500` ordered by MemberId for stable cursor.
 *
 * Output: one row per member with PreferredAddressCity → city slug
 * (calgary / edmonton; everything else clamps to calgary as the
 * default AB metro until cities.ts grows). Designation + Member Type
 * preserved in metadata so downstream can filter Professional
 * Members (P.Eng.) vs Members-In-Training (E.I.T.) etc.
 *
 * Off by default; `PROLIO_RUN_APEGA=true`. Cap with
 * `PROLIO_APEGA_LIMIT` (default 5000; full sweep needs ~72000).
 */

const ODATA_BASE = "https://ods.apega.ca/odata/v1/Register/members";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
// 2026-05-13: bumped 5000→80000 after live probe verified ~71,477
// total members. Full sweep ≈ 142 pages × 400 ms = ~1 min fetch +
// upsert. APEGA is the highest-leverage CA source.
const DEFAULT_LIMIT = 80000;
const PAGE_SIZE = 500;
const REQUEST_DELAY_MS = 400;
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

interface ApegaMember {
  MemberId: string;
  Title?: string;
  PreferredFirstName?: string;
  LegalFirstName?: string;
  LegalMiddleName?: string;
  LegalLastName?: string;
  PreferredLastName?: string;
  Designation?: string;
  PracticingStatus?: string;
  MemberType?: string;
  ScopeOfPractice?: string;
  RegistrationDate?: string;
  EnrollmentDate?: string;
  PreferredAddressCity?: string;
  LastPublicDisciplineDecisionYears?: string;
  MemberStampNames?: unknown[];
}

interface ApegaPage {
  "@odata.count"?: number;
  value?: ApegaMember[];
}

function buildName(m: ApegaMember): string | undefined {
  const first = (m.PreferredFirstName || m.LegalFirstName || "").trim();
  const last = (m.PreferredLastName || m.LegalLastName || "").trim();
  if (first && last) return `${first} ${last}`;
  if (last) return last;
  if (first) return first;
  // Title is duplicated in the source ("Name Name"); fall back to half.
  if (m.Title) return m.Title.split(/\s+/).slice(0, 2).join(" ");
  return undefined;
}

async function fetchPage(skip: number): Promise<ApegaPage | null> {
  const url =
    `${ODATA_BASE}?$count=true&$top=${PAGE_SIZE}&$skip=${skip}` +
    `&$orderby=MemberId&$expand=MemberStampNames`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Origin: "https://www.apega.ca",
        Referer: "https://www.apega.ca/",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[apega] ${response.status} on skip=${skip}`);
      return null;
    }
    return (await response.json()) as ApegaPage;
  } catch (err) {
    console.warn(`[apega] network error on skip=${skip}: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let skip = 0;
  let total: number | undefined;
  while (out.length < limit) {
    const page = await fetchPage(skip);
    if (!page || !page.value || page.value.length === 0) break;
    if (total === undefined && typeof page["@odata.count"] === "number") {
      total = page["@odata.count"];
      console.log(`[apega] total members reported: ${total}`);
    }
    for (const m of page.value) {
      const name = buildName(m)?.trim();
      const memberId = (m.MemberId ?? "").toString().trim();
      if (!name || !memberId) continue;
      const key = `apega:${memberId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        normalise({
          source: "apega" as ScrapeSource,
          sourceId: key,
          name: toTitleCase(name),
          categoryKey: CATEGORY,
          citySlug: mapCity(m.PreferredAddressCity),
          licenseNumber: memberId,
          metadata: {
            country: "CA",
            province: "AB",
            authority: "APEGA",
            verified_by_authority: true,
            designation: m.Designation || undefined,
            member_type: m.MemberType || undefined,
            practicing_status: m.PracticingStatus || undefined,
            scope_of_practice: m.ScopeOfPractice || undefined,
            registration_date: m.RegistrationDate || undefined,
            enrollment_date: m.EnrollmentDate || undefined,
            raw_city: m.PreferredAddressCity || undefined,
            discipline_decisions:
              m.LastPublicDisciplineDecisionYears || undefined,
          },
        }),
      );
      if (out.length >= limit) return out;
    }
    skip += page.value.length;
    if (total !== undefined && skip >= total) break;
    if (page.value.length < PAGE_SIZE) break;
    await delay(REQUEST_DELAY_MS);
  }
  return out;
}

export const apegaSource: ScraperSource = {
  name: "apega" as ScrapeSource,
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
  if (!apegaSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_APEGA_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const records = await fetchAll(cap);
  if (records.length === 0) {
    console.warn("[apega] no rows fetched — OData endpoint may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[apega] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
