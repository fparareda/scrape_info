/**
 * Loader for the gosom/google-maps-scraper output CSV.
 *
 * Reads the scraper's CSV row-by-row, attributes each place to a
 * (country, city_slug, category_key) from the `input_id` tag we
 * embed via `#!#{country}|{slug}|{cat}` in the queries.txt the
 * generator writes (see `run-gmaps-gaps-queries.ts`).
 *
 * Upserts via the shared `getSink()` so we inherit slug collision
 * handling and SEO copy generation. Dedup happens on
 * (source='google_places', source_id=place_id) — places that the
 * paid Places API already seeded are updated in place, not
 * duplicated.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { getSink } from "./sink.js";
import type { ScrapedProfessional } from "./types.js";
import type { CategoryKey } from "./prolio-types.js";

interface CliArgs {
  input: string;
  batch: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const arg = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    return argv[i + 1];
  };
  return {
    input: arg("input", "results.csv") ?? "results.csv",
    batch: Number(arg("batch", "200")),
    dryRun: argv.includes("--dry-run"),
  };
}

function parseCsvLine(line: string): string[] {
  // RFC4180-lite: handle quoted fields with embedded commas + escaped
  // double-quotes (""). The gosom scraper double-quotes any field that
  // contains a comma, newline, or quote.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseEmails(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === "string") {
      return arr[0];
    }
  } catch {
    // Sometimes emails ship as a bare comma-separated string.
    const first = raw.split(",")[0]?.trim();
    if (first && first.includes("@")) return first;
  }
  return undefined;
}

function num(s: string | undefined): number | undefined {
  if (!s || s === "0" || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sink = args.dryRun ? null : getSink();

  const stream = createReadStream(args.input, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let header: string[] | null = null;
  let colIdx: Record<string, number> = {};
  const buffer: ScrapedProfessional[] = [];
  const stats = { read: 0, kept: 0, skippedNoTag: 0, skippedNoPlace: 0, upserted: 0 };

  async function flush() {
    if (buffer.length === 0) return;
    if (args.dryRun) {
      stats.upserted += buffer.length;
    } else {
      const res = await sink!.upsert(buffer);
      stats.upserted += res.inserted + res.updated;
    }
    buffer.length = 0;
  }

  for await (const raw of rl) {
    if (!raw) continue;
    const cols = parseCsvLine(raw);
    if (!header) {
      header = cols;
      header.forEach((h, i) => {
        colIdx[h] = i;
      });
      continue;
    }
    stats.read++;
    const inputId = cols[colIdx.input_id];
    const placeId = cols[colIdx.place_id] || cols[colIdx.data_id];
    const title = cols[colIdx.title];
    if (!placeId || !title) {
      stats.skippedNoPlace++;
      continue;
    }
    // input_id format: {country}|{slug}|{cat}; legacy format (no
    // country) still survives as {slug}|{cat}. Anything else (e.g. the
    // gosom-generated UUID on child rows that escape attribution) is
    // skipped.
    const parts = inputId?.split("|") ?? [];
    let country: "ES" | "CA" | "US" | "FR" | "MX" | undefined;
    let citySlug: string | undefined;
    let categoryKey: string | undefined;
    const VALID_COUNTRIES = new Set(["ES", "CA", "US", "FR", "MX"]);
    if (parts.length === 3 && VALID_COUNTRIES.has(parts[0])) {
      country = parts[0] as "ES" | "CA" | "US" | "FR" | "MX";
      citySlug = parts[1];
      categoryKey = parts[2];
    }
    // Legacy 2-part tags ({slug}|{cat}) and any malformed line are
    // dropped — without a country we can't disambiguate cross-country
    // slug collisions like guadalajara (ES vs MX).
    if (!country || !citySlug || !categoryKey) {
      stats.skippedNoTag++;
      continue;
    }

    const record: ScrapedProfessional = {
      source: "google_places",
      sourceId: placeId,
      name: title,
      categoryKey: categoryKey as CategoryKey,
      country,
      citySlug,
      phone: cols[colIdx.phone] || undefined,
      website: cols[colIdx.website] || undefined,
      address: cols[colIdx.address] || undefined,
      email: parseEmails(cols[colIdx.emails]),
      lat: num(cols[colIdx.latitude]),
      lng: num(cols[colIdx.longitude]),
      rating: num(cols[colIdx.review_rating]),
      reviewCount: num(cols[colIdx.review_count]) ?? undefined,
      photoUrl: cols[colIdx.thumbnail] || undefined,
      metadata: {
        gmaps_category: cols[colIdx.category] || undefined,
        gmaps_link: cols[colIdx.link] || undefined,
        gmaps_plus_code: cols[colIdx.plus_code] || undefined,
        gmaps_cid: cols[colIdx.cid] || undefined,
      },
    };
    stats.kept++;
    buffer.push(record);
    if (buffer.length >= args.batch) await flush();
  }
  await flush();

  console.error(`\nLoader summary:`);
  console.error(`  CSV rows read:       ${stats.read}`);
  console.error(`  Skipped (no place):  ${stats.skippedNoPlace}`);
  console.error(`  Skipped (no tag):    ${stats.skippedNoTag}`);
  console.error(`  Kept (sent to sink): ${stats.kept}`);
  console.error(`  Upserted:            ${stats.upserted}${args.dryRun ? " [dry-run]" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
