import type { ScraperSource, ScrapeSource } from "../types.js";
import { getSink } from "../sink.js";
import { fetchCoptocylTo } from "./colegios/coptocyl-to.js";

/**
 * COPTOCYL — Colegio de Terapeutas Ocupacionales de Castilla y León.
 * Single-page static HTML roster: ~840 terapeutas ocupacionales.
 *
 * Off by default — PROLIO_RUN_COPTOCYL_TO=true to enable.
 */

export const coptocylToSource: ScraperSource = {
  name: "colegio" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_COPTOCYL_TO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCoptocylTo(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!coptocylToSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const records = await fetchCoptocylTo();
  if (records.length === 0) {
    console.warn("[coptocyl-to] no records — page may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[coptocyl-to] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
