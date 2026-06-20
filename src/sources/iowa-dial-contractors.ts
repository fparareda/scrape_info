/**
 * Iowa DIAL — Active Construction Contractor Registrations.
 *
 * Dataset: https://data.iowa.gov/Workforce/Active-Iowa-Construction-Contractor-Registrations/dpf3-iz94
 * Socrata host: data.iowa.gov / view dpf3-iz94
 * Refresh cadence: daily (per Socrata metadata).
 *
 * Iowa's Department of Inspections, Appeals & Licensing (DIAL) requires
 * registration for any person or business earning $2k+/year from
 * construction work in the state. ~60k active registrations spanning all
 * residential and commercial construction trades.
 *
 * Pre-flight (2026-06-07):
 *   - robots.txt: no Disallow rules — fully permissive.
 *   - Endpoint: Socrata JSON API — no authentication, no Cloudflare, no
 *     captcha. Public open-data dataset updated 2026-06-02.
 *   - Fields: registration_number, primary_activity, business_name,
 *     first_name, last_name, email_address, address, city, state,
 *     zip_code, county, phone, issue_date, expire_date.
 *   - Category mapping via `primary_activity`:
 *       Electrical*         → electricidad
 *       Plumb*              → fontaneria
 *       Heat/Cool/HVAC      → hvac
 *       Carpentry/Wood*     → carpinteria
 *       General/Contractor  → carpinteria (closest fit)
 *       Masonry/Concrete    → carpinteria
 *       Roofing/Siding      → carpinteria
 *       Paint*              → carpinteria
 *       Other construction  → carpinteria (default)
 *   - Iowa is a new US state not yet covered in this repo.
 *
 * Off by default. Enable via PROLIO_RUN_IOWA_DIAL_CONTRACTORS=true.
 * Monthly cron — registrations renew annually.
 *
 * ⚠️ NON-RECOVERABLE as of 2026-06-19 — re-verified: dataset id
 * `dpf3-iz94` returns HTTP 404 on the Socrata REST surface of
 * data.iowa.gov for BOTH the row endpoint
 * (`/resource/dpf3-iz94.json` → 404) and the view-metadata endpoint
 * (`/api/views/dpf3-iz94.json` → 404). The host now serves a Next.js
 * "Iowa Data Hub" SPA (the row URL returns the app's HTML error shell,
 * not JSON), i.e. the classic Socrata `/resource/<id>` API for this
 * dataset is gone. The Socrata discovery API (api.us.socrata.com) no
 * longer federates the Iowa domain and catalog.data.gov's CKAN API is
 * retired, so no replacement 4x4 Socrata id can be resolved
 * programmatically — the new portal exposes no equivalent free bulk
 * JSON/CSV API (the dataset is now only browsable interactively in the
 * SPA at data.iowa.gov, plus a non-machine-readable "story" view
 * i9vv-c85r). The VIEW_ID below is left as-is (NOT replaced with a
 * guessed id). To restore once Iowa republishes a machine-readable bulk
 * export: update VIEW_ID + HOST (and the fetch path if it is no longer
 * Socrata-shaped) accordingly.
 *   Landing (was): data.iowa.gov/Workforce/Active-Iowa-Construction-Contractor-Registrations/dpf3-iz94
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

const HOST = "data.iowa.gov";
const VIEW_ID = "dpf3-iz94";
const SOURCE_NAME = "iowa-dial-contractors" as const;
const DEFAULT_LIMIT = 80_000;

interface ActivityRule {
  matches: (activity: string) => boolean;
  category: CategoryKey;
}

const ACTIVITY_RULES: ActivityRule[] = [
  { matches: (a) => /electrical?/i.test(a), category: "electricidad" },
  { matches: (a) => /plumb/i.test(a), category: "fontaneria" },
  {
    matches: (a) =>
      /heat(ing)?|cool(ing)?|hvac|air.?condition|refrigerat/i.test(a),
    category: "hvac",
  },
  { matches: (a) => /carp(entr)?|wood(work)?/i.test(a), category: "carpinteria" },
  { matches: (a) => /mason(ry)?|concret|stone|tile|brick/i.test(a), category: "carpinteria" },
  { matches: (a) => /roof|siding|window|insul|weather/i.test(a), category: "carpinteria" },
  { matches: (a) => /paint/i.test(a), category: "carpinteria" },
  { matches: (a) => /general|construct|build|contractor|remodel|renovat/i.test(a), category: "carpinteria" },
  { matches: (a) => /landscap|excavat|demoli|drywall|floor/i.test(a), category: "carpinteria" },
];

function mapActivity(activity: string | undefined): CategoryKey {
  if (!activity) return "carpinteria";
  for (const rule of ACTIVITY_RULES) {
    if (rule.matches(activity)) return rule.category;
  }
  return "carpinteria";
}

function buildName(row: SocrataRow): string | undefined {
  const biz = socrataPick(row, ["business_name"]);
  if (biz) return titleCase(biz);
  const first = socrataPick(row, ["first_name"]);
  const last = socrataPick(row, ["last_name"]);
  if (first || last) return titleCase([first, last].filter(Boolean).join(" "));
  return undefined;
}

function buildAddress(row: SocrataRow): string | undefined {
  const parts: string[] = [];
  const addr = socrataPick(row, ["address"]);
  const city = socrataPick(row, ["city"]);
  const state = socrataPick(row, ["state"]);
  const zip = socrataPick(row, ["zip_code", "zipcode", "zip"]);
  if (addr) parts.push(addr);
  if (city) parts.push(city);
  if (state) parts.push(state);
  if (zip) parts.push(zip);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalisePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
}

export async function runIowaDialContractors(
  client: SupabaseClient,
  opts: RunOptions = {},
): Promise<{ scanned: number; accepted: number; written: number }> {
  const batchSize = opts.batchSize ?? 500;
  const sink = getSink({ trustCitySlugs: true });
  let scanned = 0;
  let accepted = 0;
  let written = 0;
  let buffer: ScrapedProfessional[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const res = await sink.upsert(buffer);
    written += res.inserted + res.updated;
    buffer = [];
  };

  const PROGRESS_EVERY = 500;
  let lastProgressTs = Date.now();

  for await (const page of fetchSocrataJson({
    host: HOST,
    viewId: VIEW_ID,
    pageSize: 1000,
    maxRows: opts.maxRows,
  })) {
    for (const row of page) {
      if (scanned > 0 && scanned % PROGRESS_EVERY === 0) {
        const cs = getCityUpsertStats();
        const elapsed = ((Date.now() - lastProgressTs) / 1000).toFixed(1);
        console.log(
          `[iowa-dial] progress scanned=${scanned} accepted=${accepted} written=${written} ` +
            `cities_created=${cs.inserted} +${elapsed}s`,
        );
        lastProgressTs = Date.now();
      }
      scanned += 1;

      const regNo = socrataPick(row, ["registration_number"]);
      const name = buildName(row);
      const cityRaw = socrataPick(row, ["city"]);
      const stateRaw = socrataPick(row, ["state"]);

      if (!regNo || !name || !cityRaw) continue;

      const cityResult = await ensureCity(client, {
        name: cityRaw,
        state: stateRaw,
        country: "US",
      });
      if (!cityResult) continue;

      const activity = socrataPick(row, ["primary_activity"]);
      const category = mapActivity(activity);

      const phone = normalisePhone(socrataPick(row, ["phone"]));
      const email = socrataPick(row, ["email_address"]);

      buffer.push({
        source: SOURCE_NAME,
        sourceId: `iowa-dial:${regNo}`,
        name,
        categoryKey: category,
        country: "US",
        citySlug: cityResult.slug,
        headline: activity ? `${titleCase(activity)} en ${titleCase(cityRaw)}` : undefined,
        description: `Registro ${regNo} emitido por Iowa DIAL (Dept. of Inspections, Appeals & Licensing).`,
        address: buildAddress(row),
        phone,
        email,
        licenseNumber: regNo,
        metadata: {
          primary_activity: activity,
          county: socrataPick(row, ["county"]),
          issue_date: socrataPick(row, ["issue_date"]),
          expire_date: socrataPick(row, ["expire_date"]),
          state: stateRaw,
          verified_by_authority: true,
          authority: "Iowa DIAL",
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();

  const cs = getCityUpsertStats();
  console.log(
    `[iowa-dial] scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded_inline=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ────────────────────────────────────────────────────

export const iowaDialContractorsSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_IOWA_DIAL_CONTRACTORS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runIowaDialContractorsSource(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!iowaDialContractorsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_IOWA_DIAL_LIMIT ?? DEFAULT_LIMIT);
  const maxRows = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runIowaDialContractors(client, { maxRows });
  console.log(
    `[iowa-dial] done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return { fetched: accepted, inserted: written, updated: 0, skipped: scanned - accepted };
}
