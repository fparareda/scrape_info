/**
 * Sprint C codemod: add top-level `country: "XX"` to every ScrapedProfessional
 * literal in src/sources/. Driven by SOURCE_COUNTRY (single-country sources
 * only). Multi-country sources (google_places, osm, overture, wikidata,
 * gleif, paginas_amarillas, habitissimo, manual, cronoshare, competitor-*)
 * MUST set country per-row and are left untouched.
 *
 * Strategy:
 *   For each occurrence of `source: "<known-source>"` in any source file,
 *   inject `country: "<COUNTRY>",` on the line immediately after.
 *   Idempotent: skips lines whose next line already declares country.
 *
 * Run with --dry to preview.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Parse SOURCE_COUNTRY from src/source-country.ts at runtime so this codemod
// stays in sync without a build step.
const sourceCountryTs = readFileSync(
  new URL("../src/source-country.ts", import.meta.url).pathname,
  "utf8",
);
const SOURCE_COUNTRY = Object.fromEntries(
  [...sourceCountryTs.matchAll(/["']?([a-z0-9_-]+)["']?:\s*["']([A-Z]{2})["']/g)]
    .map((m) => [m[1], m[2]]),
);

const DRY = process.argv.includes("--dry");
const ROOT = new URL("../src/sources/", import.meta.url).pathname;
const files = execSync(`find ${ROOT} -name '*.ts' -type f`, { encoding: "utf8" })
  .trim().split("\n");

let totalEdits = 0, totalFiles = 0;

for (const file of files) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { continue; }
  if (!/source:\s*["']/.test(src)) continue;

  const lines = src.split("\n");
  const out = [];
  let edits = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);

    // Match `source: "name",` or `source: "name" as ScrapeSource,`
    const m = line.match(/^(\s+)source:\s*["']([a-z0-9_-]+)["'](?:\s+as\s+\w+)?,?\s*$/);
    if (!m) continue;
    const indent = m[1];
    const sourceName = m[2];
    const country = SOURCE_COUNTRY[sourceName];
    if (!country) continue; // multi-country or unknown — skip

    // Idempotency: if any of the next 3 lines already has a sibling `country:`
    // at the same indent, skip.
    const sameLevelCountry = new RegExp(`^${indent}country:\\s*["'][A-Z]{2}["']`);
    let already = false;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      if (sameLevelCountry.test(lines[j])) { already = true; break; }
    }
    if (already) continue;

    out.push(`${indent}country: "${country}",`);
    edits++;
  }

  if (edits > 0) {
    totalEdits += edits;
    totalFiles++;
    const result = out.join("\n");
    if (DRY) {
      console.log(`[dry] ${file}: ${edits} edits`);
    } else {
      writeFileSync(file, result);
      console.log(`${file}: ${edits} edits`);
    }
  }
}

console.log(`\n${DRY ? "DRY" : "WROTE"}: ${totalEdits} edits in ${totalFiles} files`);
