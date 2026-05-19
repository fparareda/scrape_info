import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";

/**
 * OPPQ — Ordre professionnel de la physiothérapie du Québec · "Trouver
 * un physio" public register.
 *
 *   https://oppq.qc.ca/grand-public/trouver-un-physio
 *
 * Universe: ~12,000 physiothérapeutes + thérapeutes en réadaptation
 * physique registered in Québec.
 *
 * Status at 2026-05-18: the canonical URL returns Cloudflare 404 to
 * datacenter IPs (`server: Cloudflare`, `<title>Page non trouvée</title>`).
 * The site is a WordPress install with a custom search plugin that
 * POSTs to `/wp-admin/admin-ajax.php?action=oppq_physio_search` with a
 * nonce token harvested from the page bootstrap. CF anti-bot blocks
 * direct curl with non-browser fingerprint.
 *
 * Per repo policy (CF → stub) this ships as an honest STUB. Wiring
 * complete. A real adapter is straightforward (admin-ajax + nonce) once
 * CF clearance is acquired.
 *
 * Category: fisioterapia. Province: QC. Authority: OPPQ.
 * Off by default — `PROLIO_RUN_OPPQ_QUEBEC_PHYSIO=true`.
 * Limit env: `PROLIO_OPPQ_QUEBEC_PHYSIO_LIMIT` (default 20_000).
 */

const SOURCE_NAME = "oppq-quebec-physio" as ScrapeSource;

export const oppqQuebecPhysioSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_OPPQ_QUEBEC_PHYSIO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOppqQuebecPhysio(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!oppqQuebecPhysioSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  console.log(
    "[oppq-quebec-physio] STUB — oppq.qc.ca is CF-protected. " +
      "Wiring complete. ~12k physios pending.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
