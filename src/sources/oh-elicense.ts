import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { normaliseNorthAmericanPhone } from "./_bulk-utils.js";

/**
 * Ohio eLicense — public verification lookup.
 *
 * elicense.ohio.gov hosts a unified license verification UI for all
 * Ohio professional boards (~1M active licensees across medicine,
 * dentistry, physical therapy, psychology, veterinary medicine,
 * architecture, engineering, accountancy, real estate, oficios, etc.).
 *
 * The UI is a Salesforce Experience Cloud (Aura) SPA — the underlying
 * search is exposed as a POST `/oh_verifylicense/services/apexrest/...`
 * Apex REST handler that returns JSON for a given last-name letter and
 * board. This source iterates A..Z per board and pages results, with a
 * conservative rate-limit. Salesforce occasionally interleaves
 * Imperva/Akamai bot challenges; when blocked we surface zero rows
 * rather than synthesise data.
 *
 * Note: complements the existing `ohio-elicense` source which targets
 * the bulk daily CSV (`/data/active_licensees.csv`). This source uses
 * the verifylicense HTML form when the bulk CSV path is offline.
 *
 * `PROLIO_RUN_OH_ELICENSE=true` to enable.
 */

const BASE_URL = "https://elicense.ohio.gov/oh_verifylicense";
const SEARCH_URL =
  "https://elicense.ohio.gov/oh_verifylicense/services/apexrest/LicenseVerification/Search";
const DEFAULT_LIMIT = 1500;
const DEFAULT_LETTERS = "abcdefghijklmnopqrstuvwxyz".toUpperCase().split("");
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const BOARDS: Array<{ key: string; label: string; category: CategoryKey }> = [
  { key: "STATE_MEDICAL_BOARD", label: "State Medical Board of Ohio", category: "medicina" },
  { key: "DENTAL_BOARD", label: "Ohio State Dental Board", category: "dentista" },
  {
    key: "PT_BOARD",
    label: "Ohio Occupational Therapy, Physical Therapy & Athletic Trainers Board",
    category: "fisioterapia",
  },
  { key: "PSYCHOLOGY_BOARD", label: "Ohio Board of Psychology", category: "psicologia" },
  { key: "VET_BOARD", label: "Ohio Veterinary Medical Licensing Board", category: "veterinario" },
  { key: "ARCH_BOARD", label: "Ohio Architects Board", category: "arquitecto" },
];

interface OhRow {
  fullName?: string;
  licenseNumber?: string;
  licenseStatus?: string;
  licenseType?: string;
  city?: string;
  state?: string;
  zip?: string;
  address?: string;
  phone?: string;
}

async function harvestSession(): Promise<string | null> {
  try {
    const res = await fetch(BASE_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return res.headers.get("set-cookie") || "";
  } catch (error) {
    console.error(`[oh-elicense] session harvest error: ${(error as Error).message}`);
    return null;
  }
}

async function fetchBoardLetter(
  board: (typeof BOARDS)[number],
  letter: string,
  cookie: string,
): Promise<OhRow[]> {
  let res: Response;
  try {
    res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: cookie,
        Referer: BASE_URL,
      },
      body: JSON.stringify({
        boardKey: board.key,
        lastName: letter,
        pageIndex: 0,
        pageSize: 500,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    console.error(
      `[oh-elicense] network error board=${board.key} letter=${letter}: ${(error as Error).message}`,
    );
    return [];
  }
  if (!res.ok) {
    console.error(
      `[oh-elicense] status=${res.status} board=${board.key} letter=${letter}`,
    );
    return [];
  }
  try {
    const json = (await res.json()) as { results?: OhRow[]; rows?: OhRow[] };
    return json.results || json.rows || [];
  } catch {
    return [];
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const cookie = await harvestSession();
  if (cookie === null) {
    console.error(`[oh-elicense] session unavailable`);
    return [];
  }
  const lettersEnv = process.env.PROLIO_OH_ELICENSE_LETTERS;
  const letters = lettersEnv
    ? lettersEnv.split("").map((c) => c.toUpperCase())
    : DEFAULT_LETTERS;
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (const board of BOARDS) {
    if (out.length >= limit) break;
    for (const letter of letters) {
      if (out.length >= limit) break;
      const rows = await fetchBoardLetter(board, letter, cookie);
      for (const row of rows) {
        if (out.length >= limit) break;
        const licence = (row.licenseNumber || "").trim();
        if (!licence) continue;
        const status = (row.licenseStatus || "").toLowerCase();
        if (status && !status.includes("active")) continue;
        const city = (row.city || "").trim();
        const citySlug = slugify(city);
        if (!citySlug) continue;
        const key = `${licence}:${board.category}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const name = (row.fullName || "").trim();
        if (!name) continue;
        const address = [row.address, city, row.state || "OH", row.zip]
          .filter(Boolean)
          .join(", ");
        out.push(
          normalise({
            source: "oh-elicense",
            country: "US",
            sourceId: `oh-elicense:${licence}:${board.category}`,
            name,
            categoryKey: board.category,
            citySlug,
            phone: normaliseNorthAmericanPhone(row.phone),
            address: address || undefined,
            licenseNumber: licence,
            metadata: {
              country: "US",
              state: "OH",
              authority: `Ohio eLicense · ${board.label}`,
              verified_by_authority: true,
              oh_elicense_board: board.key,
              oh_elicense_license_type: row.licenseType,
            },
          }),
        );
      }
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  console.log(`[oh-elicense] parsed=${out.length}`);
  return out;
}

export const ohElicenseSource: ScraperSource = {
  name: "oh-elicense",
  enabled() {
    return process.env.PROLIO_RUN_OH_ELICENSE === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOhElicense(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!ohElicenseSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_OH_ELICENSE_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[oh-elicense] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
