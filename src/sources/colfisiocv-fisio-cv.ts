import type { ScraperSource, ScrapeSource } from "../types.js";
import { getSink } from "../sink.js";
import { fetchColfisiocvFisio } from "./colegios/colfisiocv-fisio.js";

/**
 * COLFISIOCV — Col·legi de Fisioterapeutes de la Comunitat Valenciana.
 * ~3,960 fisioterapeutas across Valencia, Alicante, Castellón.
 *
 * Off by default — PROLIO_RUN_COLFISIOCV_FISIO=true to enable.
 * Cap: PROLIO_COLFISIOCV_FISIO_LIMIT (default 5000).
 */

const DEFAULT_LIMIT = 5000;

export const colfisiocvFisioSource: ScraperSource = {
  name: "colegio" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_COLFISIOCV_FISIO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runColfisiocvFisio(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!colfisiocvFisioSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_COLFISIOCV_FISIO_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchColfisiocvFisio(limit);
  if (records.length === 0) {
    console.warn("[colfisiocv-fisio] no records fetched");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[colfisiocv-fisio] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
