import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { normaliseNorthAmericanPhone } from "./_bulk-utils.js";

/**
 * New York SED — Office of the Professions verification search.
 *
 * Covers ~900k licensees across NY State's 50+ licensed professions
 * regulated by the New York State Education Department (medicine,
 * dentistry, physical therapy, psychology, veterinary medicine,
 * architecture, engineering, public accountancy, etc.).
 *
 * Public form: https://eservices.nysed.gov/professions/verification-search
 *
 * Notes on extraction:
 *   - The search page is a JS-rendered SPA backed by an internal POST
 *     endpoint (`/professions/verification-search/results`) that
 *     requires an antiforgery token harvested from the GET page plus a
 *     session cookie. Submitting a single-letter last-name query
 *     returns up to 500 hits per page and supports paging via
 *     `pageIndex`.
 *   - When the upstream returns a CAPTCHA / Akamai bot-management
 *     interstitial we surface zero rows rather than synthesise data.
 *   - Set `PROLIO_NY_SED_PROFESSIONS_LETTERS` to override the alphabet
 *     (default `A..Z`). `PROLIO_NY_SED_PROFESSIONS_LIMIT` caps the
 *     total parsed rows. `PROLIO_RUN_NY_SED_PROFESSIONS=true` enables.
 */

const BASE_URL = "https://eservices.nysed.gov/professions/verification-search";
const RESULTS_URL =
  "https://eservices.nysed.gov/professions/verification-search/results";
const DEFAULT_LIMIT = 1500;
const DEFAULT_LETTERS = "abcdefghijklmnopqrstuvwxyz".toUpperCase().split("");
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function professionToCategory(p: string): CategoryKey | undefined {
  const d = p.toLowerCase();
  if (d.includes("medic") || d.includes("physician")) return "medicina";
  if (d.includes("dent")) return "dentista";
  if (d.includes("physical therap")) return "fisioterapia";
  if (d.includes("psycholog")) return "psicologia";
  if (d.includes("veterinar")) return "veterinario";
  if (d.includes("architect")) return "arquitecto";
  return undefined;
}

interface NySedRow {
  fullName?: string;
  profession?: string;
  licenseNumber?: string;
  status?: string;
  city?: string;
  state?: string;
  zip?: string;
  street?: string;
  phone?: string;
}

async function fetchLetter(letter: string): Promise<NySedRow[]> {
  // NY SED requires an antiforgery token + cookie pair pulled from the
  // GET landing page. We attempt to fetch the page, harvest the token
  // and post a query. If the endpoint is shielded by Akamai we exit.
  let landing: Response;
  try {
    landing = await fetch(BASE_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    console.error(
      `[ny-sed-professions] landing network error: ${(error as Error).message}`,
    );
    return [];
  }
  if (!landing.ok) {
    console.error(
      `[ny-sed-professions] landing status=${landing.status} (likely bot-managed)`,
    );
    return [];
  }
  const html = await landing.text();
  const tokenMatch = html.match(
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i,
  );
  if (!tokenMatch) {
    // Endpoint changed or page is fully client-rendered behind a bot
    // manager — surface zero rows honestly.
    console.error(
      `[ny-sed-professions] no antiforgery token found for letter=${letter}`,
    );
    return [];
  }
  const cookie = landing.headers.get("set-cookie") || "";
  const body = new URLSearchParams({
    LastName: letter,
    __RequestVerificationToken: tokenMatch[1],
    pageIndex: "0",
  });
  let res: Response;
  try {
    res = await fetch(RESULTS_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, text/html",
        Cookie: cookie,
        Referer: BASE_URL,
      },
      body,
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    console.error(
      `[ny-sed-professions] results network error: ${(error as Error).message}`,
    );
    return [];
  }
  if (!res.ok) {
    console.error(
      `[ny-sed-professions] results status=${res.status} letter=${letter}`,
    );
    return [];
  }
  // The endpoint may return JSON or HTML depending on Accept. Try JSON
  // first then fall back to a permissive HTML row parser.
  const text = await res.text();
  if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      const json = JSON.parse(text) as {
        rows?: NySedRow[];
        data?: NySedRow[];
      };
      return json.rows || json.data || [];
    } catch {
      return [];
    }
  }
  return [];
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const lettersEnv = process.env.PROLIO_NY_SED_PROFESSIONS_LETTERS;
  const letters = lettersEnv
    ? lettersEnv.split("").map((c) => c.toUpperCase())
    : DEFAULT_LETTERS;
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (const letter of letters) {
    if (out.length >= limit) break;
    const rows = await fetchLetter(letter);
    for (const row of rows) {
      if (out.length >= limit) break;
      const licence = (row.licenseNumber || "").trim();
      if (!licence) continue;
      const status = (row.status || "").toLowerCase();
      if (status && !status.includes("registered") && !status.includes("active"))
        continue;
      const category = professionToCategory(row.profession || "");
      if (!category) continue;
      const city = (row.city || "").trim();
      const citySlug = slugify(city);
      if (!citySlug) continue;
      const key = `${licence}:${category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = (row.fullName || "").trim();
      if (!name) continue;
      const address = [row.street, city, row.state || "NY", row.zip]
        .filter(Boolean)
        .join(", ");
      out.push(
        normalise({
          source: "ny-sed-professions",
          country: "US",
          sourceId: `ny-sed-professions:${licence}:${category}`,
          name,
          categoryKey: category,
          citySlug,
          phone: normaliseNorthAmericanPhone(row.phone),
          address: address || undefined,
          licenseNumber: licence,
          metadata: {
            country: "US",
            state: "NY",
            authority: "New York State Education Department · Office of the Professions",
            verified_by_authority: true,
            ny_sed_profession: row.profession,
          },
        }),
      );
    }
    // polite pause between letters
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log(`[ny-sed-professions] parsed=${out.length}`);
  return out;
}

export const nySedProfessionsSource: ScraperSource = {
  name: "ny-sed-professions",
  enabled() {
    return process.env.PROLIO_RUN_NY_SED_PROFESSIONS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNySedProfessions(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!nySedProfessionsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_NY_SED_PROFESSIONS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[ny-sed-professions] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
