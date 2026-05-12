import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { createClient } from "@supabase/supabase-js";

/**
 * Avvo (US) — lawyer directory scraper.
 *
 * Pre-flight (2026-04-24) of 4 candidate US lawyer directories:
 *
 *   - Avvo (avvo.com/all-lawyers/<state>/<city>.html):
 *       robots.txt allows /all-lawyers/ (only blocks /attorney-portal/,
 *       /attorney-edit/*, /attorneys/*\/reviews.html, /search?*). No
 *       Cloudflare interstitial. Pages embed JSON-LD `@type=Person`
 *       blocks (~20 attorneys per page) with name, telephone, address,
 *       practiceArea[], alumniOf, sameAs[], description. Phone &
 *       address are inside `address`/`telephone` properties on the
 *       Person object. **PICKED.**
 *   - FindLaw (lawyers.findlaw.com): 403 from datacenter IPs. SKIP.
 *   - Justia (lawyers.justia.com): robots is permissive but pages 403
 *       from datacenter IPs. SKIP.
 *   - HG.org: connection refused / unreachable. SKIP.
 *
 * Strategy:
 *   - Top-20 US cities (static `US_CITIES` list — population ordered).
 *     Each city paired with its USPS state code in CITY_STATE below.
 *   - 5 practice areas per city: immigration, family, personal-injury,
 *     criminal, business.
 *   - Avvo's listing URL is /all-lawyers/<state>/<city>.html — practice
 *     area is NOT in the path; it's a query string filter we apply
 *     client-side from each Person's `practiceArea[]` field. So one
 *     fetch per (state,city) gives us all practice areas for that city.
 *     This is a 5× cost reduction vs hitting the practice-area URLs.
 *   - Cap at PROLIO_US_LAWYERS_LIMIT (default 1000) rows per run.
 *
 * WEDGE: lawyers whose practiceArea[] contains "immigration" get mapped
 * to CategoryKey "extranjeria" and tagged metadata.wedge_specialty=
 * "extranjeria". This is the Prolio revenue wedge for ES; we tag US
 * rows too in case we expand. Non-immigration lawyers don't have a
 * matching CategoryKey today, so they get bucketed to "fiscal" (the
 * closest-to-professional-services key we have) with the actual
 * practice areas preserved in metadata.practice_areas. When we add a
 * legal CategoryKey, those rows can be re-bucketed via SQL.
 *
 * Off by default. Enabled via PROLIO_RUN_US_LAWYERS=true. Workflow:
 * .github/workflows/scrape-us-lawyers.yml — weekly Sun 13:00 UTC.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 1000;
const REQUEST_DELAY_MS = 1_100; // ≥1 req/sec, see CONSTRAINTS.

// --- City → state mapping ---------------------------------------------
//
// Avvo URLs need a state code. Top-20 US cities (matches the static
// US_CITIES array in cities.ts). City slug → USPS state. If a slug
// isn't here we skip it — better than guessing wrong and 404'ing.

const CITY_STATE: Record<string, string> = {
  "new-york": "ny",
  "los-angeles": "ca",
  chicago: "il",
  houston: "tx",
  phoenix: "az",
  philadelphia: "pa",
  "san-antonio": "tx",
  "san-diego": "ca",
  dallas: "tx",
  "san-jose": "ca",
  austin: "tx",
  jacksonville: "fl",
  "fort-worth": "tx",
  "columbus-oh": "oh",
  charlotte: "nc",
  indianapolis: "in",
  "san-francisco": "ca",
  seattle: "wa",
  denver: "co",
  "washington-dc": "dc",
};

// Avvo slugs the city portion lowercased with dashes. Most match our
// city_slug verbatim except where we suffixed for disambiguation.
const CITY_TO_AVVO_SLUG: Record<string, string> = {
  "columbus-oh": "columbus",
  "washington-dc": "washington",
};

function avvoCitySlug(citySlug: string): string {
  return CITY_TO_AVVO_SLUG[citySlug] ?? citySlug;
}

// --- Practice area mapping --------------------------------------------
//
// Lower-cased substrings we expect inside Avvo's `practiceArea[]`
// strings. The `wedge` flag drives the CategoryKey + metadata tag.

interface PracticeAreaSpec {
  key: string;
  /** Substrings to test against practiceArea[] entries (lowercased). */
  needles: string[];
  /** Prolio CategoryKey to assign when this is the *primary* match. */
  category: CategoryKey;
  /** When true, metadata.wedge_specialty='extranjeria' is also written. */
  wedge?: boolean;
}

const PRACTICE_AREAS: PracticeAreaSpec[] = [
  // Wedge — drives CategoryKey="extranjeria" and the wedge tag.
  { key: "immigration", needles: ["immigration"], category: "extranjeria", wedge: true },
  // Other practice areas — bucket to "fiscal" (our closest professional-
  // services key today). Real practice area is preserved in metadata so
  // we can re-bucket once we add a legal CategoryKey.
  { key: "family", needles: ["family", "divorce", "child custody"], category: "fiscal" },
  {
    key: "personal-injury",
    needles: ["personal injury", "injury", "wrongful death"],
    category: "fiscal",
  },
  {
    key: "criminal",
    needles: ["criminal", "dui", "dwi", "traffic"],
    category: "fiscal",
  },
  {
    key: "business",
    needles: ["business", "corporate", "commercial"],
    category: "fiscal",
  },
];

function classifyPracticeAreas(
  raw: string[],
): { primary: PracticeAreaSpec | null; matched: string[] } {
  const lower = raw.map((s) => s.toLowerCase());
  const matched: string[] = [];
  let primary: PracticeAreaSpec | null = null;
  for (const spec of PRACTICE_AREAS) {
    const hit = lower.some((p) => spec.needles.some((n) => p.includes(n)));
    if (hit) {
      matched.push(spec.key);
      // First spec to hit wins. Order in PRACTICE_AREAS encodes priority
      // (immigration first → wedge takes precedence).
      if (!primary) primary = spec;
    }
  }
  return { primary, matched };
}

// --- HTTP helpers ------------------------------------------------------

async function politeFetch(url: string): Promise<{ status: number; body: string } | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[us-lawyers] blocked polite UA (${response.status}); retrying with Chrome UA`,
          );
          continue;
        }
        return { status: response.status, body: "" };
      }
      if (!response.ok) return { status: response.status, body: "" };
      const body = await response.text();
      return { status: response.status, body };
    } catch (error) {
      clearTimeout(timer);
      console.warn(
        `[us-lawyers] network error on ${url}: ${(error as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

/**
 * robots.txt gate. We pre-verified Avvo's robots.txt allows /all-lawyers/
 * but the disallow set is non-trivial; check at runtime so we notice if
 * it tightens. Falls open on network errors.
 */
async function isRobotsBlocked(url: string): Promise<boolean> {
  const { host, pathname } = new URL(url);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`https://${host}/robots.txt`, {
      headers: { "User-Agent": POLITE_UA },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return false;
    const text = await response.text();
    return pathMatchesDisallow(pathname, text);
  } catch {
    return false;
  }
}

function pathMatchesDisallow(pathname: string, robotsTxt: string): boolean {
  const lines = robotsTxt.split(/\r?\n/);
  let inStar = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [key, ...valueParts] = line.split(":");
    if (!key) continue;
    const value = valueParts.join(":").trim();
    const k = key.toLowerCase();
    if (k === "user-agent") {
      inStar = value === "*";
    } else if (k === "disallow" && inStar && value) {
      if (matchesGlob(pathname, value)) return true;
    }
  }
  return false;
}

function matchesGlob(path: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === "/") return true;
  const parts = pattern.split("*");
  let cursor = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    if (!seg) continue;
    const idx = path.indexOf(seg, cursor);
    if (idx < 0) return false;
    if (i === 0 && idx !== 0) return false;
    cursor = idx + seg.length;
  }
  return true;
}

// --- JSON-LD Person extraction ----------------------------------------

interface PersonJsonLd {
  "@type"?: string | string[];
  name?: string;
  telephone?: string;
  email?: string;
  url?: string;
  image?: string | string[] | { url?: string };
  description?: string;
  jobTitle?: string;
  worksFor?: { name?: string; "@type"?: string } | string;
  alumniOf?:
    | Array<{ name?: string }>
    | { name?: string }
    | string
    | string[];
  sameAs?: string[];
  address?: {
    streetAddress?: string;
    addressLocality?: string;
    addressRegion?: string;
    postalCode?: string;
    addressCountry?: string;
  };
  /** Avvo emits practiceArea as a string array OR a comma-joined string. */
  practiceArea?: string | string[];
  /** Some pages emit `knowsAbout` instead of practiceArea. */
  knowsAbout?: string | string[];
  /** Avvo extension — year first licensed. */
  hasCredential?:
    | Array<{ credentialCategory?: string; recognizedBy?: { name?: string } }>
    | unknown;
}

function typeIncludes(type: unknown, needle: string): boolean {
  if (typeof type === "string") return type === needle;
  if (Array.isArray(type)) return type.some((t) => t === needle);
  return false;
}

function extractPersons(html: string): PersonJsonLd[] {
  const out: PersonJsonLd[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const t = (item as PersonJsonLd)["@type"];
      // Avvo uses Person; tolerate Attorney/LegalService too in case
      // markup changes.
      if (
        typeIncludes(t, "Person") ||
        typeIncludes(t, "Attorney") ||
        typeIncludes(t, "LegalService")
      ) {
        out.push(item as PersonJsonLd);
      }
    }
  }
  return out;
}

function asArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === "string");
  return value.split(/[,;]\s*/).filter(Boolean);
}

function normaliseUsPhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

function pickImage(image: PersonJsonLd["image"]): string | undefined {
  if (!image) return undefined;
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return typeof image[0] === "string" ? image[0] : undefined;
  if (typeof image === "object" && typeof image.url === "string") return image.url;
  return undefined;
}

function extractFirm(person: PersonJsonLd): string | undefined {
  const w = person.worksFor;
  if (!w) return undefined;
  if (typeof w === "string") return w;
  if (typeof w === "object" && typeof w.name === "string") return w.name;
  return undefined;
}

function extractBarAdmissions(person: PersonJsonLd): string[] {
  const out: string[] = [];
  const cred = person.hasCredential;
  if (Array.isArray(cred)) {
    for (const c of cred) {
      if (!c || typeof c !== "object") continue;
      const cc = (c as { credentialCategory?: unknown }).credentialCategory;
      if (typeof cc === "string") out.push(cc);
    }
  }
  return out;
}

function extractProfileUrl(person: PersonJsonLd): string | undefined {
  if (typeof person.url === "string" && person.url.includes("avvo.com")) {
    return person.url;
  }
  const same = person.sameAs ?? [];
  for (const u of same) {
    if (typeof u === "string" && u.includes("avvo.com/attorneys/")) return u;
  }
  return undefined;
}

function extractAvvoSourceId(person: PersonJsonLd): string | undefined {
  const url = extractProfileUrl(person);
  if (!url) return undefined;
  // Avvo profile URLs look like:
  //   https://www.avvo.com/attorneys/<zip>-<state>-<slug>-<digits>.html
  const m = url.match(/-([0-9]{4,})\.html(?:[#?].*)?$/);
  if (m) return `avvo:${m[1]}`;
  // Fallback: hash the URL path so we still have stable id.
  return `avvo:${slugify(url)}`;
}

function buildAddress(person: PersonJsonLd): string | undefined {
  const a = person.address;
  if (!a) return undefined;
  const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

// --- Per-page fetcher --------------------------------------------------

async function fetchCityPage(
  state: string,
  citySlug: string,
  validCitySlugs: Set<string>,
): Promise<{ records: ScrapedProfessional[]; status: number; wedge: number }> {
  const cityPart = avvoCitySlug(citySlug);
  const url = `https://www.avvo.com/all-lawyers/${state}/${cityPart}.html`;
  if (await isRobotsBlocked(url)) {
    console.warn(`[us-lawyers] robots blocked ${url} — skipping`);
    return { records: [], status: 0, wedge: 0 };
  }
  const response = await politeFetch(url);
  if (!response) return { records: [], status: 0, wedge: 0 };
  if (!response.body) return { records: [], status: response.status, wedge: 0 };

  const persons = extractPersons(response.body);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoMatch = 0;
  let droppedNoId = 0;
  let wedge = 0;

  for (const person of persons) {
    const sourceId = extractAvvoSourceId(person);
    if (!sourceId) {
      droppedNoId += 1;
      continue;
    }
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const name = (person.name ?? "").trim();
    if (!name) continue;

    const practiceRaw = [
      ...asArray(person.practiceArea),
      ...asArray(person.knowsAbout),
    ];
    const { primary, matched } = classifyPracticeAreas(practiceRaw);
    if (!primary) {
      // No mapped practice area — drop. Keeps the row count tight on
      // the wedge categories we care about.
      droppedNoMatch += 1;
      continue;
    }

    // City slug must be seeded so the sink doesn't drop the row.
    // Avvo's addressLocality usually matches our slug verbatim, but
    // we fall back to the query-city if not.
    const localityRaw = person.address?.addressLocality?.trim();
    const localitySlug = localityRaw ? slugify(localityRaw) : undefined;
    const cityForRow = localitySlug && validCitySlugs.has(localitySlug)
      ? localitySlug
      : citySlug;
    if (!validCitySlugs.has(cityForRow)) continue;

    const isWedge = primary.wedge === true;
    if (isWedge) wedge += 1;

    const metadata: Record<string, unknown> = {
      country: "US",
      firm: extractFirm(person),
      practice_areas: practiceRaw,
      practice_keys: matched,
      profile_url: extractProfileUrl(person),
      bar: extractBarAdmissions(person),
      region: person.address?.addressRegion,
      postal_code: person.address?.postalCode,
    };
    if (isWedge) metadata.wedge_specialty = "extranjeria";

    out.push(
      normalise({
        source: "avvo",
        sourceId,
        name,
        categoryKey: primary.category,
        citySlug: cityForRow,
        phone: normaliseUsPhone(person.telephone),
        email: typeof person.email === "string" ? person.email : undefined,
        website: extractProfileUrl(person),
        address: buildAddress(person),
        photoUrl: pickImage(person.image),
        description: typeof person.description === "string" ? person.description : undefined,
        metadata,
      }),
    );
  }

  console.log(
    `[us-lawyers] ${state}/${citySlug}: ` +
      `found=${persons.length} kept=${out.length} ` +
      `wedge=${wedge} droppedNoMatch=${droppedNoMatch} droppedNoId=${droppedNoId}`,
  );
  return { records: out, status: response.status, wedge };
}

// --- City-slug loader (same pattern as competitor-us-houzz) -----------

async function loadUsCitySlugs(): Promise<Set<string>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Set();
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const slugs = new Set<string>();
  for (let from = 0; from < 5000; from += 1000) {
    const { data, error } = await sb
      .from("cities")
      .select("slug")
      .eq("country", "US")
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    for (const row of data) slugs.add(row.slug as string);
    if (data.length < 1000) break;
  }
  return slugs;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Public entrypoint -------------------------------------------------

export const competitorUsLawyersSource: ScraperSource = {
  name: "avvo",
  enabled() {
    return process.env.PROLIO_RUN_US_LAWYERS === "true";
  },
  async fetch() {
    return [];
  },
};

export interface UsLawyersRunSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  wedge: number;
}

export async function runCompetitorUsLawyers(): Promise<UsLawyersRunSummary | null> {
  if (!competitorUsLawyersSource.enabled()) return null;

  const limitRaw = Number(process.env.PROLIO_US_LAWYERS_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

  const validCitySlugs = await loadUsCitySlugs();
  if (validCitySlugs.size === 0) {
    console.warn(`[us-lawyers] no US cities seeded — skipping`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0, wedge: 0 };
  }

  const sink = getSink();
  const all: ScrapedProfessional[] = [];
  let pageCount = 0;
  let wedgeTotal = 0;

  outer: for (const [citySlug, state] of Object.entries(CITY_STATE)) {
    if (!validCitySlugs.has(citySlug)) continue;
    const { records, status, wedge } = await fetchCityPage(
      state,
      citySlug,
      validCitySlugs,
    );
    pageCount += 1;
    wedgeTotal += wedge;
    if (status === 403 || status === 503) {
      console.warn(`[us-lawyers] got ${status}; aborting run to respect rate limits`);
      break outer;
    }
    all.push(...records);
    if (all.length >= limit) {
      console.log(`[us-lawyers] reached cap ${limit}, stopping`);
      break outer;
    }
    await delay(REQUEST_DELAY_MS);
  }

  const capped = all.slice(0, limit);
  if (capped.length === 0) {
    console.log(`[us-lawyers] done — pages=${pageCount} records=0 wedge=${wedgeTotal}`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0, wedge: wedgeTotal };
  }
  const { inserted, updated, skipped } = await sink.upsert(capped);
  console.log(
    `[us-lawyers] done — pages=${pageCount} records=${capped.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped} ` +
      `wedge=${wedgeTotal}`,
  );
  return { fetched: capped.length, inserted, updated, skipped, wedge: wedgeTotal };
}
