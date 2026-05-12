import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Canadian professional college / regulator scraper.
 *
 * These are statutory regulators of regulated professions in Ontario —
 * the highest-trust data source available to us in Canada. Like the
 * sibling `competitor-ca-licensing.ts` (ECRA electricians), every
 * record carries a real regulator-issued registration number.
 *
 * Pre-flight (2026-04-24) of three Ontario regulators:
 *
 *   CPSO (cpso.on.ca / register.cpso.on.ca) — SKIPPED.
 *     The "Public Register" lives on register.cpso.on.ca behind a
 *     Cloudflare "Just a moment..." interstitial. GETs return 403
 *     even with a Chrome UA; the challenge requires JS execution.
 *     Defeating it would force a Playwright dependency for a single
 *     adapter — not justified. Source kind reserved (`cpso`) so we
 *     can ship the day Cloudflare drops or we get a feed.
 *
 *   LSO (lso.ca) — SKIPPED.
 *     Two independent blockers: (1) robots.txt User-agent:* explicitly
 *     Disallows /public-resources/finding-a-lawyer-or-paralegal/
 *     directory-search/{members,member,results}. We never scrape past
 *     robots. (2) The directory returns Cloudflare 403
 *     (cf-mitigated: challenge) on every datacenter IP. Source kind
 *     reserved (`lso`).
 *
 *   RCDSO (rcdso.org) — BUILT.
 *     Public dentist directory at /find-a-dentist/search-results
 *     renders all matches as static HTML (no AJAX, no challenge). One
 *     empty-filter request returns ~20.5k Ontario dentists in a single
 *     ~67 MB response. robots.txt only disallows /scripts and /styles.
 *     City is encoded in the per-record Google-Maps "View on Map" URL
 *     (`?query=<address>%2C%20<CITY>%2C%20<POSTAL>`); we extract it
 *     from there and map to seeded `city_slug` via getCities({country:
 *     'CA'}). Rows whose city doesn't map are dropped.
 *
 * Off by default. Enable via PROLIO_RUN_CA_PROFESSIONAL=true. Workflow:
 * .github/workflows/scrape-ca-professional.yml — monthly day 1 13:00
 * UTC. Each college gets its own scrape_runs row (cpso/lso/rcdso) so
 * /admin can see per-regulator yield even when only one is built.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// RCDSO returns ~67 MB on the empty-filter call; allow generous timeout.
const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_LIMIT = 1000;

// --- Category mapping --------------------------------------------------

const CATEGORY_MEDICO: CategoryKey = "medicina";
const CATEGORY_DENTISTA: CategoryKey = "medicina"; // closest CategoryKey today; specialty preserved in metadata
const CATEGORY_ABOGADO: CategoryKey = "fiscal"; // closest professional-services key; see us-lawyers comment
// Hold imports stable in case future refactors split categories — these
// names document intent even though dentista/abogado don't yet have
// dedicated CategoryKeys in the taxonomy.
void CATEGORY_MEDICO;
void CATEGORY_ABOGADO;

// --- HTTP helpers ------------------------------------------------------

async function politeFetch(
  url: string,
): Promise<{ status: number; body: string } | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-CA,en;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[ca_professional] ${new URL(url).host} blocked polite UA (${response.status}); retrying with Chrome UA`,
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
      const message = (error as Error).message ?? String(error);
      console.warn(`[ca_professional] network error on ${url}: ${message}`);
      return null;
    }
  }
  return null;
}

/**
 * Minimal robots.txt gate. Pre-verified RCDSO only disallows /scripts +
 * /styles; checking at runtime catches any future tightening.
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
      if (value === "/") return true;
      if (pathname.startsWith(value)) return true;
    }
  }
  return false;
}

function normaliseCaPhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

// --- City mapping ------------------------------------------------------

/**
 * Build a city alias table from the seeded CA cities. Slugs map to
 * themselves; lower-cased city *names* map to slugs. Common Toronto
 * boroughs collapse to `toronto` (mirrors competitor-ca-licensing's
 * approach for ECRA addresses).
 */
async function buildCaCityIndex(): Promise<Map<string, string>> {
  const cities = await getCities({ country: "CA" });
  const idx = new Map<string, string>();
  for (const c of cities) {
    idx.set(c.slug, c.slug);
    idx.set(c.name.toLowerCase(), c.slug);
  }
  // Toronto amalgamated boroughs (1998).
  for (const borough of ["scarborough", "etobicoke", "north york", "east york", "york"]) {
    idx.set(borough, "toronto");
  }
  // Hamilton amalgamated communities (2001).
  if (idx.has("hamilton-ca")) {
    for (const community of ["stoney creek", "ancaster", "dundas", "flamborough"]) {
      idx.set(community, "hamilton-ca");
    }
  }
  // Ottawa-Carleton amalgamation (2001) — Nepean / Kanata / Gloucester.
  if (idx.has("ottawa")) {
    for (const community of ["nepean", "kanata", "gloucester", "orleans"]) {
      idx.set(community, "ottawa");
    }
  }
  return idx;
}

function lookupCity(idx: Map<string, string>, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  return idx.get(key);
}

// --- RCDSO adapter -----------------------------------------------------

/**
 * Single record extracted from the search-results HTML. RCDSO renders
 * every match server-side; we parse the raw HTML rather than hit any
 * API. The ID in the per-result link (`?id=NNNNNN`) is the RCDSO
 * registration number — stable, unique, and printed on the dental
 * certificate of authorisation.
 */
interface RcdsoRecord {
  id: string;
  name: string;
  practiceName?: string;
  street?: string;
  city?: string;
  postal?: string;
  phone?: string;
}

const RCDSO_BASE_URL = "https://www.rcdso.org/find-a-dentist/search-results";

/**
 * Parse the RCDSO search-results HTML into structured records.
 *
 * Why regex and not a real DOM parser? The page is ~67 MB on the empty
 * filter and lighting up jsdom on that input takes ~20 seconds + ~1 GB
 * RAM. The structure is regular and we control the matcher tightly:
 *
 *   <section class="row hide">  ← one per dentist
 *     <h2><a href="...?id=N"> - Name</a></h2>
 *     <dt>Registration Number:</dt><dd>N</dd>
 *     <span>Practice Name</span>
 *     <span>Street</span>
 *     <a href="https://www.google.com/maps/search/?...query=ADDR%2C%20CITY%2C%20POSTAL">
 *     <a href="tel:NNNNNNNNNN">…</a>
 *
 * Constraints that justify the regex approach: (a) the slow path
 * (jsdom on 67 MB) blows past CI timeouts; (b) the structure is
 * server-rendered Razor and stable across the year of pages we
 * inspected.
 */
function parseRcdsoHtml(html: string): RcdsoRecord[] {
  const out: RcdsoRecord[] = [];
  const sectionRe = /<section class="row hide">([\s\S]*?)<\/section>/g;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = sectionRe.exec(html)) !== null) {
    const block = match[1];
    if (!block) continue;
    const idMatch = block.match(/dentist\?id=(\d+)/);
    if (!idMatch || !idMatch[1]) continue;
    const id = idMatch[1];

    // The visible name lives inside <h2>...<a>...> - Name</a></h2>. The
    // hyphen-space prefix is part of RCDSO's title prefix slot (which
    // is empty for almost every dentist — we strip it).
    const nameMatch = block.match(/<h2[^>]*><a[^>]*>([^<]+)<\/a><\/h2>/);
    if (!nameMatch || !nameMatch[1]) continue;
    const name = nameMatch[1].replace(/^\s*-\s*/, "").trim();
    if (!name) continue;

    // Google Maps URL — this is the only place city + postal are
    // emitted in the result block. Format:
    //   query=<addr>%2C%20<CITY>%2C%20<POSTAL>
    const mapsMatch = block.match(/maps\/search\/\?api=1&amp;query=([^"]+)/);
    let street: string | undefined;
    let city: string | undefined;
    let postal: string | undefined;
    if (mapsMatch && mapsMatch[1]) {
      const decoded = decodeURIComponent(mapsMatch[1]).trim();
      // "279 Wharncliffe Rd N #120, London, N6H 2C2"
      const parts = decoded.split(/\s*,\s*/);
      if (parts.length >= 3) {
        street = parts.slice(0, parts.length - 2).join(", ");
        city = parts[parts.length - 2];
        postal = parts[parts.length - 1];
      } else if (parts.length === 2) {
        city = parts[0];
        postal = parts[1];
      }
    }

    const phoneMatch = block.match(/tel:(\d+)/);
    const phone = phoneMatch ? phoneMatch[1] : undefined;

    // Practice name is the first <span> inside the <address> block.
    const practiceMatch = block.match(/<address[^>]*>\s*<span>([^<]+)<\/span>/);
    const practiceName = practiceMatch ? practiceMatch[1].trim() : undefined;

    out.push({ id, name, practiceName, street, city, postal, phone });
  }
  return out;
}

async function fetchRcdsoDentists(
  cityIdx: Map<string, string>,
  cap: number,
): Promise<{ records: ScrapedProfessional[]; raw: number }> {
  const url = RCDSO_BASE_URL;
  if (await isRobotsBlocked(url)) {
    console.warn(`[ca_professional] rcdso blocked by robots.txt — skipping`);
    return { records: [], raw: 0 };
  }
  const response = await politeFetch(url);
  if (!response || !response.body) {
    console.warn(
      `[ca_professional] rcdso fetch failed (status=${response?.status ?? "network"})`,
    );
    return { records: [], raw: 0 };
  }
  const parsed = parseRcdsoHtml(response.body);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCity = 0;
  let droppedNoName = 0;

  for (const r of parsed) {
    if (out.length >= cap) break;
    if (!r.name) {
      droppedNoName += 1;
      continue;
    }
    const citySlug = lookupCity(cityIdx, r.city);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }
    const sourceId = `rcdso:${r.id}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const addressParts = [r.street, r.city, r.postal].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    const record = normalise({
      source: "rcdso",
      sourceId,
      name: r.name,
      categoryKey: CATEGORY_DENTISTA,
      citySlug,
      phone: normaliseCaPhone(r.phone),
      address: addressParts.length > 0 ? addressParts.join(", ") : undefined,
      licenseNumber: r.id,
      metadata: {
        province: "ON",
        country: "CA",
        verified_by_authority: true,
        authority: "RCDSO",
        specialty: "dentista",
        practice_name: r.practiceName,
        registration_number: r.id,
      },
    });
    out.push(record);
  }
  console.log(
    `[ca_professional] rcdso parsed=${parsed.length} kept=${out.length} ` +
      `droppedNoCity=${droppedNoCity} droppedNoName=${droppedNoName}`,
  );
  return { records: out, raw: parsed.length };
}

// --- CPSO / LSO doc-only adapters --------------------------------------
//
// Both regulators are blocked as documented at the top of the file.
// We still wire env-flag-aware "stubs" that log a one-line skip note
// and emit an empty scrape_runs row (status=ok, rows_fetched=0,
// metadata.reason='blocked'). That way the panel surfaces them on
// every run and we'll notice the day they unblock.

async function runCpsoDocOnly(): Promise<void> {
  console.warn(
    "[ca_professional] cpso: SKIPPED — Cloudflare interstitial on " +
      "register.cpso.on.ca blocks GETs. See module docstring.",
  );
}

async function runLsoDocOnly(): Promise<void> {
  console.warn(
    "[ca_professional] lso: SKIPPED — robots.txt disallows the " +
      "directory-search paths AND Cloudflare returns 403 from datacenter " +
      "IPs. See module docstring.",
  );
}

// --- Public entrypoints ------------------------------------------------

export const competitorCaProfessionalSource: ScraperSource = {
  // Logging name; emitted rows carry the per-college ScrapeSource value.
  // We pick `rcdso` here because that's the only adapter actually
  // emitting rows today.
  name: "rcdso" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CA_PROFESSIONAL === "true";
  },
  async fetch() {
    return [];
  },
};

export function competitorCaProfessionalEnabled(): boolean {
  return competitorCaProfessionalSource.enabled();
}

/**
 * Bulk runner. Dispatches by the `college_only` env (set by the GH
 * workflow input) — empty / unset means "all colleges". Each college
 * gets its OWN `scrape_runs` row via withScrapeRun so /admin shows
 * per-regulator yield. RCDSO is the only one that actually emits rows
 * as of 2026-04-24; CPSO and LSO are doc-only.
 */
export async function runCompetitorCaProfessional(): Promise<void> {
  if (!competitorCaProfessionalEnabled()) return;
  const collegeOnly = (process.env.PROLIO_CA_PROFESSIONAL_COLLEGE ?? "").toLowerCase().trim();
  const limit = Number(process.env.PROLIO_CA_PROFESSIONAL_LIMIT ?? DEFAULT_LIMIT);
  const effectiveLimit =
    Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  if (effectiveLimit !== limit) {
    console.warn(
      `[ca_professional] invalid PROLIO_CA_PROFESSIONAL_LIMIT, using ${DEFAULT_LIMIT}`,
    );
  }

  const cityIdx = await buildCaCityIndex();
  const sink = getSink();

  const wantCpso = !collegeOnly || collegeOnly === "cpso";
  const wantLso = !collegeOnly || collegeOnly === "lso";
  const wantRcdso = !collegeOnly || collegeOnly === "rcdso";

  if (wantCpso) {
    await withScrapeRun("cpso", async () => {
      await runCpsoDocOnly();
      return {
        rowsFetched: 0,
        rowsUpserted: 0,
        rowsSkipped: 0,
        metadata: { reason: "cloudflare_challenge", status: "blocked" },
      };
    }).catch((e) =>
      console.error(`[ca_professional] cpso telemetry crashed:`, (e as Error).message),
    );
  }

  if (wantLso) {
    await withScrapeRun("lso", async () => {
      await runLsoDocOnly();
      return {
        rowsFetched: 0,
        rowsUpserted: 0,
        rowsSkipped: 0,
        metadata: { reason: "robots_disallow_and_cloudflare", status: "blocked" },
      };
    }).catch((e) =>
      console.error(`[ca_professional] lso telemetry crashed:`, (e as Error).message),
    );
  }

  if (wantRcdso) {
    await withScrapeRun("rcdso", async () => {
      const { records, raw } = await fetchRcdsoDentists(cityIdx, effectiveLimit);
      if (records.length === 0) {
        return {
          rowsFetched: raw,
          rowsUpserted: 0,
          rowsSkipped: 0,
          metadata: { reason: raw === 0 ? "fetch_failed" : "no_city_match" },
        };
      }
      const { inserted, updated, skipped } = await sink.upsert(records);
      console.log(
        `[ca_professional] rcdso upsert: inserted=${inserted} updated=${updated} skipped=${skipped}`,
      );
      return {
        rowsFetched: raw,
        rowsUpserted: inserted + updated,
        rowsSkipped: skipped,
      };
    }).catch((e) =>
      console.error(`[ca_professional] rcdso crashed:`, (e as Error).message),
    );
  }
}
