import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * MAA — Manitoba Association of Architects.
 *
 * Pre-flight (2026-05-17):
 *   • https://www.mbarchitects.org/find-a-member?last_name={letter}
 *   • robots.txt: User-agent: * / Allow: / — fully open, no Disallow rules.
 *   • Static server-rendered HTML; all member data embedded inline.
 *     No JavaScript rendering, no login, no captcha.
 *   • ~700–800 members across all membership classes
 *     (Registered, Intern, Student, Associate, Honorary, Life, etc.).
 *     We iterate A–Z to cover the full roster; the MAA website returns
 *     all matching members for a given last-name initial in one response.
 *   • Members may be in any Canadian province — not MB only. A full
 *     CA city index is used for slug mapping.
 *   • Each record carries: name, membership class, firm, address, city,
 *     province, postal code, phone, and e-mail.
 *
 * Category: arquitecto. Off by default; PROLIO_RUN_MAA_ARCHITECTS=true.
 */

const BASE_URL = "https://www.mbarchitects.org";
const SEARCH_PATH = "/find-a-member";
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_DELAY_MS = 1_200;
const DEFAULT_LIMIT = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

// --- City index (CA-wide — MAA members can be in any province) --------

let cityIndexCache: Map<string, string> | null = null;

async function loadCityIndex(): Promise<Map<string, string>> {
  if (cityIndexCache) return cityIndexCache;
  const cities = await getCities({ country: "CA" });
  const idx = new Map<string, string>();
  for (const city of cities) {
    idx.set(city.name.toLowerCase(), city.slug);
    idx.set(city.slug.toLowerCase(), city.slug);
  }
  cityIndexCache = idx;
  return idx;
}

function resolveCity(
  idx: Map<string, string>,
  rawCity: string | undefined,
): string | undefined {
  if (!rawCity) return undefined;
  const key = rawCity.trim().toLowerCase();
  return idx.get(key);
}

// --- HTTP helpers -------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(letter: string): Promise<string | null> {
  const url = `${BASE_URL}${SEARCH_PATH}?last_name=${encodeURIComponent(letter)}`;
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-CA,en;q=0.9",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[maa-architects] letter=${letter} blocked polite UA (${res.status}), retrying`,
          );
          continue;
        }
        console.warn(
          `[maa-architects] letter=${letter} blocked (${res.status}) — skipping`,
        );
        return null;
      }
      if (!res.ok) {
        console.warn(
          `[maa-architects] letter=${letter} HTTP ${res.status} — skipping`,
        );
        return null;
      }
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      console.warn(
        `[maa-architects] letter=${letter} fetch error: ${(err as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

// --- HTML parser --------------------------------------------------------

interface MaaMember {
  memberId: string;
  name: string;
  membershipClass: string;
  firm?: string;
  address?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
}

/**
 * Extract label→value pairs from a member block. Labels end with ":"
 * and may contain letters, spaces and hyphens (e.g. "E-Mail:").
 */
function extractFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re =
    /<td[^>]*>([A-Za-z][A-Za-z\s\-]*?):<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const label = m[1]
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/-/g, "_");
    const rawVal = (m[2] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/g, " ")
      .replace(/&#\d+;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (label && rawVal) fields[label] = rawVal;
  }
  return fields;
}

/**
 * Parse all member detail blocks embedded in the page HTML.
 *
 * Each member is represented by a `<div id="member_id_NNNN" class="content">`
 * element whose content is a label-value table (hidden by CSS but present
 * in the source). We split the HTML on the `id="member_id_` sentinel and
 * parse each chunk independently.
 */
function parseMembersFromHtml(html: string): MaaMember[] {
  const out: MaaMember[] = [];
  // Split on the opening of each member detail div. The split sentinel
  // is `id="member_id_` which appears only on the <div> elements, not
  // on the <a href="#member_id_..."> links (those use href=, not id=).
  const chunks = html.split(/(?=id="member_id_\d+")/);
  for (const chunk of chunks) {
    const idMatch = /^id="member_id_(\d+)"/.exec(chunk);
    if (!idMatch) continue;
    const memberId = idMatch[1];
    if (!memberId) continue;
    const fields = extractFields(chunk);
    const name = (fields["member_name"] ?? "").trim();
    if (!name) continue;
    out.push({
      memberId,
      name,
      membershipClass: fields["membership_class"] ?? "",
      firm: fields["firm"] ?? undefined,
      address: fields["address"] ?? undefined,
      city: fields["city"] ?? undefined,
      province: fields["province"] ?? undefined,
      postalCode: fields["postal_code"] ?? undefined,
      phone: fields["phone"] ?? undefined,
      email: fields["e_mail"] ?? undefined,
    });
  }
  return out;
}

// --- Name + phone normalisation ----------------------------------------

/** Flip "LastName [Initial.], FirstName" → "FirstName LastName [Initial.]". */
function reorderName(raw: string): string {
  const commaIdx = raw.indexOf(",");
  if (commaIdx < 0) return raw.trim();
  const lastPart = raw.slice(0, commaIdx).trim();
  const firstPart = raw.slice(commaIdx + 1).trim();
  if (!firstPart) return lastPart;
  return `${firstPart} ${lastPart}`;
}

function normalisePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Take the first phone number when multiple are listed (separated by ";").
  const first = raw.split(/[;,]/)[0]?.trim() ?? "";
  if (!first) return undefined;
  const digits = first.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return first || undefined;
}

// --- Core fetch + normalise loop ---------------------------------------

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const cityIndex = await loadCityIndex();
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCity = 0;

  for (const letter of LETTERS) {
    if (out.length >= limit) break;
    const html = await fetchPage(letter);
    if (!html) {
      await delay(REQUEST_DELAY_MS);
      continue;
    }
    const members = parseMembersFromHtml(html);
    let added = 0;
    for (const m of members) {
      if (out.length >= limit) break;
      const sourceId = `maa:${m.memberId}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const citySlug = resolveCity(cityIndex, m.city);
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      out.push(
        normalise({
          source: "maa-architects",
          country: "CA",
          sourceId,
          name: reorderName(m.name),
          categoryKey: "arquitecto",
          citySlug,
          address: m.address,
          phone: normalisePhone(m.phone),
          email: m.email,
          licenseNumber: m.memberId,
          metadata: {
            country: "CA",
            province: m.province,
            postal_code: m.postalCode,
            firm: m.firm,
            membership_class: m.membershipClass,
            authority: "MAA",
            verified_by_authority: true,
          },
        }),
      );
      added += 1;
    }
    console.log(
      `[maa-architects] letter=${letter} found=${members.length} added=${added} total=${out.length} droppedNoCity=${droppedNoCity}`,
    );
    await delay(REQUEST_DELAY_MS);
  }

  console.log(
    `[maa-architects] complete total=${out.length} droppedNoCity=${droppedNoCity}`,
  );
  return out;
}

// --- Public exports -----------------------------------------------------

export const maaArchitectsSource: ScraperSource = {
  name: "maa-architects",
  enabled() {
    return process.env.PROLIO_RUN_MAA_ARCHITECTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runMaaArchitects(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!maaArchitectsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_MAA_ARCHITECTS_LIMIT ?? DEFAULT_LIMIT,
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
    `[maa-architects] upserted inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
