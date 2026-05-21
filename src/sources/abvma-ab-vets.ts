import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";

/**
 * ABVMA — Alberta Veterinary Medical Association.
 *
 * Public roster at
 *   https://www.abvma.ca/site/rosterdirectory
 * powered by in1touch. The shell page links to one roster per
 * registration class via `clientRosterId`:
 *   168 = Registered Veterinarians  (~2,068 as of 2026-05)
 *   201 = Registered Veterinary Technologists
 *   300 = Specialist Veterinarians
 *   207 = Limited Practice / Temporary / Final-year students
 *   209 = Non-Practising Veterinarians
 *
 * For the veterinario category we ingest roster 168 only (the active
 * Registered Veterinarians register). The other rosters can be added
 * later by extending ROSTER_IDS.
 *
 * Pre-flight 2026-05-21 (datacenter IP):
 *   GET https://www.abvma.ca/client/roster/clientRosterView.html?clientRosterId=168
 *     → 200 in ~1s, 94 KB HTML; `<span class="pagebanner">2,068 Profiles
 *       found, displaying 1 to 50.</span>` confirms 50/page pagination via
 *       `&page=N`. No auth, no CSRF, no Cloudflare challenge.
 *
 * Unlike the generic in1touch helper (SCPP pharmacists), ABVMA renders
 * each registrant as a single `<div class="col-md-4 roster_tbl">` block
 * containing the name, clinic, registration type and reg #, instead of
 * the 5-column `registryBlock` layout. Parser is inline below.
 *
 * Category: `veterinario`. Province AB. Authority ABVMA.
 * Off by default — `PROLIO_RUN_ABVMA_AB_VETS=true` to enable.
 * Cap via `PROLIO_ABVMA_AB_VETS_LIMIT` (default 5_000).
 */

const BASE_URL = "https://www.abvma.ca/client/roster/clientRosterView.html";
// Rosters ingested as "veterinario":
//   168 = Registered Veterinarians (active, ~2,068)
//   300 = Specialist Veterinarians (~50)
//   207 = Limited Practice / Temporary Licensee / Final-year Vet Students
// Technologists rosters (201, 208) are skipped — different category.
const ROSTER_IDS = ["168", "300", "207"];
const AUTHORITY = "ABVMA";
const PROVINCE = "AB";
const CATEGORY: CategoryKey = "veterinario";
const DEFAULT_CITY = "calgary"; // largest AB city; ABVMA roster is province-wide
const DEFAULT_LIMIT = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 1500;
const PAGE_SIZE = 50;
const MAX_PAGES = 200;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

export const abvmaAbVetsSource: ScraperSource = {
  name: "abvma-ab-vets" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_ABVMA_AB_VETS === "true";
  },
  async fetch() {
    return [];
  },
};

interface AbvmaRow {
  rosterId: string;
  clientId?: string;
  name: string;
  clinic?: string;
  registerKind?: string; // "Veterinarian" | "Veterinary Technologist"
  registrationClass?: string; // "General Practice Registered Veterinarian" etc.
  registrationNumber?: string; // "Reg. # : 2313"
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clean(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parsePageBanner(html: string): number | null {
  const m = html.match(/([\d,]+)\s+Profiles?\s+found/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseRosterBlocks(html: string, rosterId: string): AbvmaRow[] {
  const out: AbvmaRow[] = [];
  // Each registrant: <div class="col-md-4 roster_tbl">…</div>
  const blockRe =
    /<div\s+class="col-md-4\s+roster_tbl"[^>]*>([\s\S]*?)<\/div>/gi;
  for (const m of html.matchAll(blockRe)) {
    const inner = m[1];

    // First <strong> = "Last, First". Anchor's inner <strong> = clinic.
    const firstStrong = inner.match(/<strong>\s*([^<]+?)\s*<\/strong>/i);
    if (!firstStrong) continue;
    const name = clean(firstStrong[1]);
    if (!name) continue;

    const anchor = inner.match(
      /<a\s+href="[^"]*clientId=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const clientId = anchor?.[1];
    const clinicRaw = anchor
      ? anchor[2].match(/<strong>([\s\S]*?)<\/strong>/i)?.[1]
      : undefined;
    const clinic = clinicRaw ? clean(clinicRaw) : undefined;

    const kindMatch = inner.match(
      /<font\s+color="green"[^>]*>([^<]+)<\/font>/i,
    );
    const registerKind = kindMatch ? clean(kindMatch[1]) : undefined;

    // Registration class sits between </font><br /> and <br />Reg.
    const classMatch = inner.match(/<\/font>\s*<br\s*\/?>\s*([^<]+?)\s*<br/i);
    const registrationClass = classMatch ? clean(classMatch[1]) : undefined;

    const regNumMatch = inner.match(/Reg\.\s*#\s*:\s*([A-Za-z0-9-]+)/i);
    const registrationNumber = regNumMatch ? regNumMatch[1].trim() : undefined;

    out.push({
      rosterId,
      clientId,
      name,
      clinic: clinic || undefined,
      registerKind,
      registrationClass,
      registrationNumber,
    });
  }
  return out;
}

function normaliseDisplayName(lastFirst: string): string {
  // Source format: "Last, First Middle" → "First Middle Last".
  const parts = lastFirst.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 2) {
    return toTitleCase(`${parts[1]} ${parts[0]}`);
  }
  return toTitleCase(lastFirst);
}

async function fetchPage(
  rosterId: string,
  page: number,
): Promise<string | null> {
  const url = `${BASE_URL}?clientRosterId=${encodeURIComponent(rosterId)}&page=${page}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[abvma-ab-vets] roster=${rosterId} page=${page} HTTP ${res.status}`,
      );
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(
      `[abvma-ab-vets] roster=${rosterId} page=${page} fetch error: ${(e as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRoster(
  rosterId: string,
  cap: number,
): Promise<AbvmaRow[]> {
  const out: AbvmaRow[] = [];
  let total: number | null = null;
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (out.length >= cap) break;
    const html = await fetchPage(rosterId, page);
    if (!html) break;
    if (page === 1) {
      total = parsePageBanner(html);
      if (total !== null) {
        console.log(
          `[abvma-ab-vets] roster=${rosterId} total=${total} (~${Math.ceil(total / PAGE_SIZE)} pages)`,
        );
      }
    }
    const rows = parseRosterBlocks(html, rosterId);
    if (rows.length === 0) {
      if (page === 1) {
        console.warn(
          `[abvma-ab-vets] roster=${rosterId} returned 0 rows on page 1 — schema may have changed`,
        );
      }
      break;
    }
    for (const r of rows) {
      const key = r.clientId ?? `${r.name}|${r.registrationNumber ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= cap) break;
    }
    if (total !== null && out.length >= total) break;
    await delay(PAGE_DELAY_MS);
  }
  return out;
}

function toRecord(row: AbvmaRow): ScrapedProfessional | null {
  if (!row.name) return null;
  const displayName = normaliseDisplayName(row.name);
  const sourceId = row.clientId
    ? `abvma:${row.clientId}`
    : `abvma:name:${displayName.toLowerCase()}|${row.registrationNumber ?? ""}`;
  return normalise({
    source: "abvma-ab-vets" as ScrapeSource,
    country: "CA",
    sourceId,
    name: displayName,
    categoryKey: CATEGORY,
    citySlug: DEFAULT_CITY,
    licenseNumber: row.registrationNumber,
    metadata: {
      country: "CA",
      province: PROVINCE,
      authority: AUTHORITY,
      verified_by_authority: true,
      roster_id: row.rosterId,
      register_kind: row.registerKind ?? null,
      registration_class: row.registrationClass ?? null,
      registration_number: row.registrationNumber ?? null,
      clinic: row.clinic ?? null,
    },
  });
}

export async function runAbvmaAbVets(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!abvmaAbVetsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_ABVMA_AB_VETS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const allRows: AbvmaRow[] = [];
  for (const rosterId of ROSTER_IDS) {
    if (allRows.length >= cap) break;
    const rows = await fetchRoster(rosterId, cap - allRows.length);
    allRows.push(...rows);
  }

  // Filter: only the Veterinarian register kind goes under "veterinario".
  // Vet Technologists from rosters 201/208 would be a separate category
  // (paraveterinario / técnico) if/when we add them.
  const filtered = allRows.filter(
    (r) => !r.registerKind || /veterinarian/i.test(r.registerKind),
  );

  const records: ScrapedProfessional[] = [];
  const seenSourceIds = new Set<string>();
  for (const row of filtered) {
    const rec = toRecord(row);
    if (!rec) continue;
    if (seenSourceIds.has(rec.sourceId)) continue;
    seenSourceIds.add(rec.sourceId);
    records.push(rec);
  }

  if (records.length === 0) {
    console.warn(`[abvma-ab-vets] fetched 0 records — endpoint may be down`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[abvma-ab-vets] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
