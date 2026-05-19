import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { normaliseNorthAmericanPhone } from "./_bulk-utils.js";

/**
 * Pennsylvania PALS — Professional Licensing System (Tyler Versa Cloud).
 *
 * pals.pa.gov is the unified portal covering ~1.5M active licensees
 * across all 29 PA professional boards (State Board of Medicine,
 * Dentistry, Physical Therapy, Psychology, Veterinary Medicine,
 * Architects, Engineers, Accountancy, Real Estate, Cosmetology, plus
 * the 11 occupational boards regulated by BPOA).
 *
 * Tyler Technologies' Versa Cloud exposes a REST search endpoint at
 * `/SearchLicensingResults` that accepts a `LicenseProfessionTypeId`
 * and `LastName` (or `LicenseTypeId`) and returns JSON paged via
 * `PageIndex`/`PageSize`. The endpoint does require an antiforgery
 * token and ASP.NET session cookie obtained from the GET landing page.
 *
 * Note: this complements the existing `pennsylvania-bpoa` source which
 * targets the daily BPOA bulk CSV (only the occupational subset). PALS
 * here iterates the full SPA-backed lookup. When Versa returns its bot
 * interstitial we return zero rows.
 *
 * `PROLIO_RUN_PA_PALS=true` to enable.
 */

const BASE_URL = "https://www.pals.pa.gov/#/page/search";
const LANDING_URL = "https://www.pals.pa.gov/";
const SEARCH_URL = "https://www.pals.pa.gov/api/Search/SearchLicensingResults";
const DEFAULT_LIMIT = 1500;
const DEFAULT_LETTERS = "abcdefghijklmnopqrstuvwxyz".toUpperCase().split("");
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// Versa Cloud's profession ID map for the categories we care about.
// These are the public IDs used by the search dropdown on pals.pa.gov.
const BOARD_IDS: Array<{ id: number; category: CategoryKey; label: string }> = [
  { id: 23, category: "medicina", label: "State Board of Medicine" },
  { id: 9, category: "dentista", label: "State Board of Dentistry" },
  { id: 28, category: "fisioterapia", label: "State Board of Physical Therapy" },
  { id: 30, category: "psicologia", label: "State Board of Psychology" },
  { id: 38, category: "veterinario", label: "State Board of Veterinary Medicine" },
  { id: 4, category: "arquitecto", label: "Architects Licensure Board" },
];

interface PalsRow {
  FullName?: string;
  LicenseNumber?: string;
  LicenseStatus?: string;
  ProfessionName?: string;
  City?: string;
  StateCode?: string;
  ZipCode?: string;
  AddressLine1?: string;
  PhoneNumber?: string;
}

async function harvestSession(): Promise<{ cookie: string; token: string } | null> {
  try {
    const res = await fetch(LANDING_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const cookie = res.headers.get("set-cookie") || "";
    const tokenMatch = html.match(
      /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i,
    );
    if (!tokenMatch) return null;
    return { cookie, token: tokenMatch[1] };
  } catch (error) {
    console.error(
      `[pa-pals] session harvest error: ${(error as Error).message}`,
    );
    return null;
  }
}

async function fetchBoardLetter(
  board: (typeof BOARD_IDS)[number],
  letter: string,
  session: { cookie: string; token: string },
): Promise<PalsRow[]> {
  let res: Response;
  try {
    res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: session.cookie,
        Referer: BASE_URL,
        RequestVerificationToken: session.token,
      },
      body: JSON.stringify({
        LicenseProfessionTypeId: board.id,
        LastName: letter,
        PageIndex: 0,
        PageSize: 500,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    console.error(
      `[pa-pals] network error board=${board.id} letter=${letter}: ${(error as Error).message}`,
    );
    return [];
  }
  if (!res.ok) {
    console.error(
      `[pa-pals] status=${res.status} board=${board.id} letter=${letter}`,
    );
    return [];
  }
  try {
    const json = (await res.json()) as {
      Results?: PalsRow[];
      results?: PalsRow[];
    };
    return json.Results || json.results || [];
  } catch {
    return [];
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const session = await harvestSession();
  if (!session) {
    console.error(`[pa-pals] could not obtain session token (Versa bot mgmt)`);
    return [];
  }
  const lettersEnv = process.env.PROLIO_PA_PALS_LETTERS;
  const letters = lettersEnv
    ? lettersEnv.split("").map((c) => c.toUpperCase())
    : DEFAULT_LETTERS;
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (const board of BOARD_IDS) {
    if (out.length >= limit) break;
    for (const letter of letters) {
      if (out.length >= limit) break;
      const rows = await fetchBoardLetter(board, letter, session);
      for (const row of rows) {
        if (out.length >= limit) break;
        const licence = (row.LicenseNumber || "").trim();
        if (!licence) continue;
        const status = (row.LicenseStatus || "").toLowerCase();
        if (status && !status.includes("active")) continue;
        const city = (row.City || "").trim();
        const citySlug = slugify(city);
        if (!citySlug) continue;
        const key = `${licence}:${board.category}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const name = (row.FullName || "").trim();
        if (!name) continue;
        const address = [
          row.AddressLine1,
          city,
          row.StateCode || "PA",
          row.ZipCode,
        ]
          .filter(Boolean)
          .join(", ");
        out.push(
          normalise({
            source: "pa-pals",
            country: "US",
            sourceId: `pa-pals:${licence}:${board.category}`,
            name,
            categoryKey: board.category,
            citySlug,
            phone: normaliseNorthAmericanPhone(row.PhoneNumber),
            address: address || undefined,
            licenseNumber: licence,
            metadata: {
              country: "US",
              state: "PA",
              authority: `Pennsylvania PALS · ${board.label}`,
              verified_by_authority: true,
              pa_pals_board_id: board.id,
              pa_pals_profession: row.ProfessionName,
            },
          }),
        );
      }
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  console.log(`[pa-pals] parsed=${out.length}`);
  return out;
}

export const paPalsSource: ScraperSource = {
  name: "pa-pals",
  enabled() {
    return process.env.PROLIO_RUN_PA_PALS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runPaPals(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!paPalsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_PA_PALS_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[pa-pals] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
