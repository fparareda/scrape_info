/**
 * Streaming bulk CSV loader for multi-GB regulator data files.
 *
 * Pattern: HTTP fetch as a ReadableStream → optional gunzip → line split
 * → CSV parse (RFC4180-ish: quoted fields, escaped quotes, CRLF) → caller
 * transform → batched Supabase upsert. Memory-bounded at `batchSize` rows
 * in flight at any time, so a 5GB NPI file fits in <100 MB heap.
 *
 * Used by re-ingest scrapers (NPI bulk, SIRENE INSEE, DENUE INEGI) — see
 * `apps/scraper/src/sources/nppes-bulk.ts` and friends. The HTML-per-page
 * scrapers under `sources/*` are NOT supposed to use this; they have
 * different rate-limit semantics.
 *
 * No new deps — uses node:fetch / node:zlib / node:stream. Hand-rolled
 * CSV parser (RFC4180 minimal). All three target sources publish CSV
 * with the same dialect (comma, double-quote, LF or CRLF). If a future
 * source uses TSV/semicolons swap the `delimiter` option.
 */

import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface BulkCsvLoaderOptions<TDbRow> {
  /** Public URL of the source CSV file (may be `.gz`). */
  url: string;
  /** Override the auto-detection of gzip. Auto = filename ends in `.gz`. */
  gzip?: boolean;
  /** RFC4180-ish delimiter. Default `,`. NPI/SIRENE/DENUE all use comma. */
  delimiter?: string;
  /**
   * Transform a parsed CSV row (header→value map) into a Supabase upsert
   * row. Return `null` to drop the row (the right place for taxonomy
   * filtering on NPI, NAF code filtering on SIRENE, etc.).
   */
  mapRow: (row: Record<string, string>) => TDbRow | null;
  /** Target Supabase table. */
  table: string;
  /** Composite columns for the upsert ON CONFLICT clause. */
  onConflict: string;
  /** Upsert batch size. Default 500. */
  batchSize?: number;
  /** Hard row cap (for dry runs / debugging). */
  maxRows?: number;
  /**
   * Logger called every `progressEvery` rows scanned. Default 50k. We use
   * stderr so the progress doesn't get tangled with row data on stdout.
   */
  progressEvery?: number;
  onProgress?: (scanned: number, accepted: number) => void;
}

export interface BulkCsvLoaderResult {
  /** Rows pulled from the CSV (post-decode, pre-filter). */
  scanned: number;
  /** Rows that survived `mapRow` (non-null returns). */
  accepted: number;
  /** Rows actually written to Supabase (= accepted, less any DB errors). */
  written: number;
  durationMs: number;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_PROGRESS_EVERY = 50_000;

/**
 * Stream-load a remote CSV into a Supabase table.
 *
 * Throws only on network failure or malformed header row. Per-row DB
 * errors are logged and counted in `scanned - written`; the loader does
 * NOT abort mid-file because public regulators sometimes ship an
 * occasional bad row (NPI ships ~10 of these per million on average).
 */
export async function bulkCsvLoad<TDbRow extends Record<string, unknown>>(
  client: SupabaseClient,
  options: BulkCsvLoaderOptions<TDbRow>,
): Promise<BulkCsvLoaderResult> {
  const started = Date.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const progressEvery = options.progressEvery ?? DEFAULT_PROGRESS_EVERY;
  const isGzip = options.gzip ?? options.url.toLowerCase().endsWith(".gz");
  const delimiter = options.delimiter ?? ",";

  // Support both remote URLs and local files. Workflows that need to
  // pre-process a ZIP archive (NPI bulk ships .zip not .csv.gz) can
  // unzip to /tmp and pass `file:///tmp/foo.csv` or a bare absolute
  // path. fetch() doesn't speak file:// in Node, so we branch.
  let nodeStream: NodeJS.ReadableStream;
  if (options.url.startsWith("file://") || options.url.startsWith("/")) {
    const path = options.url.replace(/^file:\/\//, "");
    nodeStream = createReadStream(path);
  } else {
    const response = await fetch(options.url);
    if (!response.ok || !response.body) {
      throw new Error(
        `bulkCsvLoad: HTTP ${response.status} fetching ${options.url}`,
      );
    }
    nodeStream = Readable.fromWeb(
      response.body as Parameters<typeof Readable.fromWeb>[0],
    );
  }
  if (isGzip) {
    const gunzip = createGunzip();
    nodeStream.pipe(gunzip);
    nodeStream = gunzip;
  }

  let scanned = 0;
  let accepted = 0;
  let written = 0;
  let header: string[] | null = null;
  let buf = "";
  // Strip a UTF-8 BOM (EF BB BF → ﻿) from the very first chunk if
  // present. NPPES ships its monthly CSV with a BOM; without this strip,
  // the first header cell parses as `﻿"NPI"` and every `row["NPI"]`
  // lookup downstream returns undefined — which is what produced the
  // `scanned=500001 accepted=0` zero-row run on 2026-05-18.
  let bomStripped = false;
  const batch: TDbRow[] = [];

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    const slice = batch.splice(0, batch.length);
    const { error } = await client
      .from(options.table)
      .upsert(slice as never[], { onConflict: options.onConflict });
    if (error) {
      console.error(
        `[bulkCsvLoad] upsert error after ${scanned} rows: ${error.message}`,
      );
    } else {
      written += slice.length;
    }
  }

  function consumeLine(line: string): void {
    if (line.length === 0) return;
    if (header === null) {
      header = parseCsvRow(line, delimiter);
      // Echo the first 3 header cells so a column-name regression in a
      // refreshed monthly file is visible without re-running with a
      // local debugger. Cheap; logged once.
      console.log(
        `[bulkCsvLoad] header parsed: ${header.length} cols; first 3 = ${JSON.stringify(header.slice(0, 3))}`,
      );
      return;
    }
    const cells = parseCsvRow(line, delimiter);
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i] ?? `col${i}`] = cells[i] ?? "";
    }
    scanned += 1;
    if (options.maxRows && scanned > options.maxRows) {
      // Allow caller to cap; processed via early return below.
      return;
    }
    const mapped = options.mapRow(row);
    if (mapped !== null) {
      batch.push(mapped);
      accepted += 1;
    }
    if (scanned % progressEvery === 0) {
      options.onProgress?.(scanned, accepted);
    }
  }

  for await (const chunk of nodeStream) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (!bomStripped) {
      if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
      bomStripped = true;
    }
    // Split on LF; preserve CRLF stripping below. Process all but the
    // final fragment (likely incomplete line at chunk boundary).
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      consumeLine(line);
      if (batch.length >= batchSize) await flush();
      if (options.maxRows && scanned >= options.maxRows) break;
    }
    if (options.maxRows && scanned >= options.maxRows) break;
  }

  // Tail: consume any trailing line without a terminator.
  if (buf.length > 0) {
    consumeLine(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
  }
  await flush();

  return {
    scanned,
    accepted,
    written,
    durationMs: Date.now() - started,
  };
}

/**
 * Parse a single CSV row into cells. Handles quoted fields with embedded
 * commas and doubled-quote escapes (`""`). Not a full RFC4180 parser —
 * notably it doesn't support multi-line quoted fields. NPI/SIRENE/DENUE
 * all avoid those in their bulk exports, verified 2026-05-16.
 */
export function parseCsvRow(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
