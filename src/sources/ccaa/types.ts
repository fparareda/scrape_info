import type { CategoryKey } from "../../prolio-types.js";
import type { ScrapedProfessional } from "../../types.js";

/**
 * Each CCAA (comunidad autónoma) source reads one or more public
 * registers and returns normalised pros. Unlike `ScraperSource` which
 * iterates (category, city) targets, these fetch their whole dataset in
 * one shot (e.g. a full CSV of instaladores eléctricos) and return every
 * row. The outer runner gates by env and batches into the sink.
 *
 * Data we aim to cover per CCAA:
 *  - Registros de Empresas Instaladoras (fontanería, electricidad,
 *    gas, refrigeración) — industria
 *  - Registros de Talleres de Reparación de Vehículos — industria
 *  - Concesionarias ITV — industria
 *
 * Every row carries a `licenseNumber` (matrícula/nº registro) when the
 * registry provides one — that's the trust signal that distinguishes
 * these from Google Places entries.
 */
export interface CcaaSource {
  name: string;
  /** ISO-ish CCAA code (MD, CT, AN, …). Stored in metadata for audit. */
  ccaaCode: string;
  /** Which categories this registry feeds. */
  categories: CategoryKey[];
  enabled(): boolean;
  fetch(): Promise<ScrapedProfessional[]>;
}
