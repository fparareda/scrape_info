#!/usr/bin/env node
/**
 * download-sirene.mjs
 *
 * Pre-filter the INSEE SIRENE bulk extracts into per-category CSVs
 * that the sirene-insee scraper can consume from a smaller artifact.
 *
 * Why offline: the StockEtablissement_utf8.zip is ~600 MB compressed
 * (~2 GB unpacked, ~30M rows). Streaming-decompressing it inside a
 * GH Actions free runner alongside the scraper itself is fragile —
 * preferable to do it on a workstation or beefier runner once a month
 * and upload the per-category CSV slices as cheaper artifacts.
 *
 * URLs (verified 2026-05-12 from data.gouv.fr/datasets/base-sirene):
 *   https://files.data.gouv.fr/insee-sirene/StockEtablissement_utf8.zip
 *   https://files.data.gouv.fr/insee-sirene/StockUniteLegale_utf8.zip
 *
 * Usage:
 *   node scripts/download-sirene.mjs --naf 4322A --out sirene-fontaneria.csv
 *   node scripts/download-sirene.mjs --naf 4322B,4321A --out sirene-elec-hvac.csv
 *
 * Dependencies (run `npm install yauzl` if unmet):
 *   yauzl (streaming ZIP)
 *
 * TODO: actual implementation. This file documents the intended
 * pipeline so the scraper-side code is unblocked.
 */

console.error(
  "[download-sirene] stub — implement streaming ZIP + per-NAF filter\n" +
    "  Source: https://files.data.gouv.fr/insee-sirene/StockEtablissement_utf8.zip\n" +
    "  Strategy: yauzl.fromBuffer → readStream → readline → splitCsv on `activitePrincipaleEtablissement`\n" +
    "  Output: per-category CSV slices uploadable as GH artifacts",
);
process.exit(1);
