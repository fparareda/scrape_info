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
  | "fl-doh-mqa"
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
  | "scpp-sk-pharmacists"
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
  | "ny-sed-professions"
  | "pa-pals"
  | "oh-elicense"
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
  | "sedema-verificentros-cdmx"
  | "verificacion-edomex"
  | "verificacion-jalisco"
  | "cnsf-agentes"
  | "colegio-notarios-cdmx"
  | "fcarm-arquitectos"
  | "fedmvz-colegios-vet"
  | "conahcyt-snii"
  // 2026-05-13 wave: MX fraud/risk + regulatory permits
  | "sat-efos-edos"
  | "sat-cpr-mx"
  | "profeco-sancionados"
  | "profeco-rpca-talleres"
  | "cre-permisionarios"
  // 2026-05-13 wave 2: MX business directories
  | "siem"
  | "cofepris-farmacias"
  | "cnbv-entidades"
  | "padron-ganadero-nacional"
  // 2026-05-13 wave 3: MX construction + autos + real estate
  | "amda-distribuidores"
  | "cmic-constructoras"
  | "re-franchises-mx"
  // 2026-05-14: MX médicos certificados (CONACEM) — stub honesto, bloqueado por proxy SSR
  | "conacem-mx"
  // 2026-05-14 wave: generic ES open-data catalog
  | "datos-gob-es"
  // 2026-05-14 wave: ES quick wins + federation fan-outs
  | "guiadentistas-es"
  | "dgt-itv-es"
  | "rasic-talleres-cat"
  | "cgpe-procuradores"
  | "colegios-notarios-mx"
  // 2026-05-14 wave: MX small clean directories
  | "dro-cdmx"
  | "profepa-verificentros-edomex"
  // 2026-05-14: US federal healthcare complement to NPI
  | "cms-pecos"
  | "oig-leie"
  // 2026-05-14: California DCA — 35 boards bulk licensee dumps (~3M)
  | "ca-dca-open-data"
  // 2026-05-14: HIFLD US — DHS open-data hospitals + UC + nursing homes + EMS
  | "hifld-us"
  // 2026-05-15: CA iMIS-hosted public registers (NS engineers, NSBS lawyers, NL engineers)
  | "engineers-ns"
  | "nsbs-ns"
  | "pegnl-nl"
  // 2026-05-15: MX IMCP — federación de colegios de contadores públicos
  | "imcp-colegios-mx"
  // 2026-05-15 wave: CA quick wins (SVMA SK vets + CPSNS NS physicians + LSNB Alinity)
  | "svma-sk-vets"
  | "cpsns-ns-physicians"
  | "lsnb-bar"
  // 2026-05-15 MX quick wins: ANTAD retail seeds + EMA/IMSS stubs
  | "antad-asociados"
  | "ema-acreditados"
  | "imss-directorio"
  // 2026-05-15: IFT RPC — concesiones telecom + radio + TV (MX)
  | "ift-rpc-mx"
  // 2026-05-15 wave: ES quick wins (habitissimo SSR + Open Data BCN locales
  // + farmacéuticos guardia federation stub + COMB Barcelona stub)
  | "habitissimo-es"
  | "open-data-bcn-locales"
  | "farmaceuticos-es-guardia"
  | "comb-barcelona"
  // 2026-05-15: MX CLUES — national health establishment master registry
  | "clues-sinais-mx"
  // 2026-05-15: ES Ventanilla Única — vets (OCV) + ópticos (CGCOO)
  | "vucolvet"
  | "cgcoo-opticos"
  // 2026-05-18: CA CPO — Ontario physiotherapists (College of Physiotherapists of Ontario)
  | "cpo-physio";

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
