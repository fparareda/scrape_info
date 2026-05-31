import type { ScraperSource, ScrapeSource } from "../types.js";
import { getSink } from "../sink.js";
import { fetchCofextFisio } from "./colegios/cofext-fisio.js";

/**
 * COFEXT — Colegio Oficial de Fisioterapeutas de Extremadura.
 * Wrapper source that drives cofext-fisio.ts and upserts to the sink.
 *
 * Off by default — PROLIO_RUN_COFEXT_FISIO=true to enable.
 */

export const cofextFisioSource: ScraperSource = {
  name: "colegio" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_COFEXT_FISIO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCofextFisio(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cofextFisioSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const records = await fetchCofextFisio();
  if (records.length === 0) {
    console.warn("[cofext-fisio] no records — table may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cofext-fisio] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
