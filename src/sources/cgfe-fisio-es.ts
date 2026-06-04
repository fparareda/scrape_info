import type { ScraperSource, ScrapeSource } from "../types.js";
import { getSink } from "../sink.js";
import { fetchCgfeFisio } from "./colegios/cgfe-fisio.js";

/**
 * CGFE — Consejo General de Fisioterapeutas de España.
 * National census: ~69k fisioterapeutas across all colegios autonómicos.
 * Wrapper source that drives colegios/cgfe-fisio.ts and upserts to the sink.
 *
 * Off by default — PROLIO_RUN_CGFE_FISIO=true to enable.
 * Cap: PROLIO_CGFE_FISIO_LIMIT (default 5000 per run).
 */

const DEFAULT_LIMIT = 5000;

export const cgfeFisioSource: ScraperSource = {
  name: "colegio" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CGFE_FISIO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCgfeFisio(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cgfeFisioSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_CGFE_FISIO_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchCgfeFisio(limit);
  if (records.length === 0) {
    console.warn("[cgfe-fisio] no records fetched");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cgfe-fisio] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
