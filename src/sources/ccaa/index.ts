import type { ScrapedProfessional } from "../../types.js";
import type { CcaaSource } from "./types.js";
import { riiNational } from "./rii-national.js";
import { catalunyaInstaladores } from "./catalunya-instaladores.js";
import { catalunyaTalleres } from "./catalunya-talleres.js";
import { aragonInstaladores } from "./aragon-instaladores.js";
import { aecaItv } from "./aeca-itv.js";

/**
 * CCAA-backed sources. Two layers:
 *
 *  1. rii-national: Ministerio de Industria's Registro Integrado
 *     Industrial. Single CSV covering all 17 CCAAs + Ceuta/Melilla.
 *     Sparse data (name + nº registro + municipio + CNAE) but
 *     authoritative and nationwide.
 *  2. Per-CCAA sources when that CCAA publishes richer data (phone,
 *     email, specialty breakdown): Cataluña today; Aragón, Castilla y
 *     León, Galicia, País Vasco have known open-data CSVs that we'll
 *     wire the same way as Cataluña.
 *
 * When the two layers overlap (a Catalan installer shows up in both
 * RII and the gencat CSV), the richer row wins at sink time because
 * `(source, source_id)` keys are distinct and the gencat phone/email
 * values overwrite null-ish ones from RII on subsequent runs.
 */
const SOURCES: CcaaSource[] = [
  riiNational,
  catalunyaInstaladores,
  catalunyaTalleres,
  aragonInstaladores,
  aecaItv,
];

export async function runAllCcaaSources(): Promise<ScrapedProfessional[]> {
  const enabled = SOURCES.filter((s) => s.enabled());
  if (enabled.length === 0) return [];
  const out: ScrapedProfessional[] = [];
  for (const source of enabled) {
    try {
      const rows = await source.fetch();
      console.log(
        `[ccaa:${source.name}] fetched ${rows.length} rows (ccaa=${source.ccaaCode})`,
      );
      out.push(...rows);
    } catch (error) {
      console.error(
        `[ccaa:${source.name}] failed:`,
        (error as Error).message,
      );
    }
  }
  return out;
}

export function ccaaSourcesEnabled(): boolean {
  return SOURCES.some((s) => s.enabled());
}
