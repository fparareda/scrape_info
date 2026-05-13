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
  | "hcra"
  | "florida-dbpr"
  | "texas-tdlr"
  | "arizona-roc"
  | "washington-li"
  | "oregon-ccb"
  | "nevada-nscb"
  | "cmq"
  | "barreau-qc"
  | "odq"
  | "oaq"
  | "cpsbc"
  | "law-society-bc"
  | "illinois-idfpr"
  | "new-york-dos"
  | "north-carolina-lbc"
  | "virginia-dpor"
  | "massachusetts-dpl"
  | "colorado-dora"
  | "georgia-plb"
  | "pennsylvania-bpoa"
  | "wisconsin-dsps"
  | "minnesota-dli"
  | "missouri-dpr"
  | "ohio-elicense"
  | "michigan-lara"
  | "maryland-dllr"
  | "new-jersey-dca"
  | "tennessee-tdci"
  | "cnb-avocats"
  | "architectes-fr"
  | "oec-fr"
  | "ordre-vet-fr"
  | "doctoralia-mx"
  | "senasica-mx-vet"
  | "denue-mx"
  | "oaa"
  | "louisiana-lslbc"
  | "nyc-dob"
  | "cgn-notariado"
  // 2026-05 wave: CA Alinity-hosted + Thentia + provincial regulators
  | "tsask"
  | "tsbc"
  | "cpsa"
  | "cpsm"
  | "cpsnl"
  | "cpspei"
  | "cap-psychologists"
  | "cpm-physio"
  | "lss-saskatchewan"
  | "amvic-dealers"
  | "apega"
  // 2026-05 wave: FR consolidation + data.gouv bulk sources
  | "annuaire-sante-ans"
  | "sirene-insee"
  | "ademe-rge"
  | "finess"
  | "prix-controle-technique"
  | "auto-ecoles-fr"
  | "geometres-fr"
  | "cnop-pharmaciens"
  // 2026-05 wave: MX federal + state directories
  | "notariado-mx"
  | "sat-cpr"
  | "sedema-verificentros-cdmx"
  | "verificacion-edomex"
  | "verificacion-jalisco"
  | "cnsf-agentes"
  | "colegio-notarios-cdmx"
  | "fcarm-arquitectos"
  | "fedmvz-colegios-vet"
  | "conahcyt-snii";

/**
 * Normalised record emitted by every source. Sources convert their raw
 * response into this shape; the sink upserts into Supabase. Deliberately
 * similar to @prolio/types `Professional` but with source provenance and
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
  /** ISO country code — ES, CA, US, FR, MX today. Sources can choose
   *  to skip (e.g. CCAA Spain-only registries) or adapt queries
   *  (e.g. EN/FR synonyms per locale). */
  country: "ES" | "CA" | "US" | "FR" | "MX";
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
