import type { CategoryKey } from "./prolio-types.js";

export type ScrapeSource =
  | "google_places"
  | "colegio"
  | "borme"
  | "osm"
  | "paginas_amarillas"
  | "ccaa_registry"
  | "wikidata"
  | "tumejorelectricista"
  | "electricistaya"
  | "habitissimo"
  | "cronoshare"
  | "paginasamarillas"
  | "homeadvisor"
  | "thumbtack"
  | "homestars"
  | "trustedpros"
  | "com_zaragoza"
  | "com_madrid"
  | "com_gipuzkoa"
  | "ecra"
  | "cslb"
  | "houzz"
  | "avvo"
  | "bar-ca"
  | "bar-ny"
  | "bar-tx"
  | "aila"
  | "cpso"
  | "lso"
  | "rcdso"
  | "doctoralia"
  | "npi"
  | "gleif"
  | "industry-ca"
  | "tssa"
  | "hcra";

/**
 * Normalised record emitted by every source. Sources convert their raw
 * response into this shape; the sink upserts into Supabase. Deliberately
 * similar to ./prolio-types `Professional` but with source provenance and
 * without DB-only fields (id, timestamps).
 */
export interface ScrapedProfessional {
  source: ScrapeSource;
  /** Stable identifier within the source (place_id, licenciaID, …). */
  sourceId: string;
  name: string;
  categoryKey: CategoryKey;
  citySlug: string;
  headline?: string;
  description?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  lat?: number;
  lng?: number;
  licenseNumber?: string;
  cif?: string;
  legalForm?: string;
  foundedAt?: string;
  rating?: number;
  reviewCount?: number;
  photoUrl?: string;
  openingHours?: string[];
  metadata?: Record<string, unknown>;
}

export interface ScrapeTarget {
  categoryKey: CategoryKey;
  citySlug: string;
  /** Human-readable city name; sources use it to build localised queries. */
  cityName: string;
  /** ISO country code — ES, CA, US today. Sources can choose to skip
   *  (e.g. CCAA Spain-only registries) or adapt queries (e.g. EN/FR
   *  synonyms per locale). */
  country: "ES" | "CA" | "US";
  /** Language to form the textQuery in for this city. */
  queryLocale: "es" | "en" | "fr";
}

export interface ScraperSource {
  name: ScrapeSource;
  /** Called once per target. Must not throw on a single-target failure — log
   *  and return an empty array so other targets can still proceed. */
  fetch(target: ScrapeTarget): Promise<ScrapedProfessional[]>;
  /** Returns true if the env is wired for this source. */
  enabled(): boolean;
}
