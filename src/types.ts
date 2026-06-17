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
  | "annuaire-sante-ameli"
  | "rhode-island-crb"
  | "rpps-fr"
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
  // 2026-05-18 wave: FR → 500k (Ordres + Chambres)
  | "ordre-infirmiers-fr"
  | "ordre-pharmaciens-fr"
  | "chambre-metiers-fr"
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
  // 2026-05-18 wave US → 500k: NPI taxonomy slices + bulk variant + new cats
  // (enfermeria, farmacia, abogado) + Foursquare trades. Stubs documented
  // in each source file (ADA + APHIS + state-bars-bulk blocked by WAF).
  | "npi-bulk-stream"
  | "npi-nurses"
  | "npi-pharmacists"
  | "ada-find-a-dentist"
  | "usda-aphis-vets"
  | "state-bars-bulk"
  | "foursquare-trades"
  // 2026-05-18: ES wave → 500k — enfermería, farmacia, ingeniería caminos
  // + ingeniería industrial superior (4 federaciones Ventanilla Única).
  | "cge-enfermeria"
  | "cgcof-farmacia"
  | "ciccp-ingenieros"
  | "coiim-ingenieros"
  // 2026-05-18 wave CA → 500k: 8 new CA sources (mostly nursing — the
  // big lever). All ship as honest stubs today because the public
  // registers are gated by Cloudflare / Akamai BMP / stateful JSF
  // tokens; wiring complete so a residential-IP/Playwright drop-in can
  // land 500k+ rows.
  | "cno-ontario"
  | "oiiq-quebec"
  | "bccnm-bc"
  | "alberta-crna"
  | "ocp-pharmacy"
  | "lso-bar-ontario"
  | "oppq-quebec-physio"
  | "cvo-vets-ontario"
  // 2026-05-18 wave MX → 500k: 8 new sources targeting the largest MX gap.
  | "sic-ss-medicina"
  | "cecm-dentistas"
  | "cenadi-enfermeria"
  | "cofepris-farmaceuticos"
  | "padron-abogados-mx"
  | "fed-arquitectos-mx"
  | "fed-psicologos-mx"
  | "denue-mx-trades"
  // 2026-05-18: DENUE BULK — per-state ZIPs, ~5M MX businesses; ~400-700k after SCIAN filter
  | "denue-mx-bulk"
  // 2026-05-18: Yelp Fusion API (per-target search, daily cadence)
  | "yelp_fusion"
  // 2026-05-18 wave CA bulk open-data → 500k:
  //   - statcan-cbr: StatCan Canadian Business Counts (aggregate, stub).
  //   - toronto-business-licenses: City of Toronto MLS CKAN CSV.
  //   - vancouver-business-licenses: City of Vancouver Opendatasoft CSV.
  | "statcan-cbr"
  | "toronto-business-licenses"
  | "vancouver-business-licenses"
  // 2026-05-18: Calgary Open Data Socrata licences (~22k AB businesses)
  | "calgary-business-licences"
  // 2026-05-20: international company registries (hybrid enrichment + selective ingest)
  | "uk-companies-house"
  | "sec-edgar"
  | "uspto-patentsview"
  // 2026-05-21: CA vet expansion — Alberta Veterinary Medical Association
  // (in1touch-hosted public roster, ~2k Registered Veterinarians).
  | "abvma-ab-vets"
  // 2026-05-21: CA vet expansion — Manitoba Veterinary Medical Association
  // (Alinity tenant `mvma`, ~1k vets + ~600 techs; we keep vets only).
  | "mvma-mb-vets"
  | "peivma-pei-vets"
  // 2026-06-12: CA — CPTBC BC physiotherapists (Alinity tenant cptbc)
  | "cptbc-physio"
  // 2026-06-13: CPhM — College of Pharmacists of Manitoba (~3.1k pharmacists + techs)
  | "cphm-mb-pharmacists"
  // 2026-06-15: Nova Scotia College of Physiotherapists (NSCP) — fisioterapia (~780 NS PTs).
  // Joomla static HTML table, no auth, robots.txt allows member-directory path.
  | "nscp-ns-physio"
  // 2026-05-26: 411.ca — CA generalist business directory (~3M businesses,
  // Angular SSR, schema.org markup, free pagination ?p=N).
  | "411-ca"
  // 2026-05-26: MerchantCircle US — generalist directory via gzipped sitemap
  // shards (897 sub-sitemaps, ~44.9M URLs). Sharded fetch with state filter
  // and category keyword-matching on slug.
  | "merchantcircle-us"
  // 2026-05-31: GPhC UK — General Pharmaceutical Council register of
  // pharmacy professionals (~86k). Enumerated by sequential registration
  // number (2,040,000–2,250,000 range, ~60-70% density).
  | "gphc-uk-pharmacists"
  // 2026-05-31: SEP Cédulas Profesionales MX — national registry of all
  // professional titles issued in Mexico (~8-10M active credentials across
  // all professions). API: cedulaprofesional.sep.gob.mx/api with public
  // Bearer token + optional X-Recaptcha-Token. Sequential cédula enumeration
  // range 1,000,000–15,000,000.
  | "sep-cedulas-mx"
  // 2026-05-31: US data.gov / Socrata open-data catalog (pilot sources)
  | "data-gov-chicago-bacp"
  | "data-gov-montgomery-md-electrician"
  // 2026-06-15: Delaware DPR — Socrata multi-category (arquitecto/veterinario/
  // fontaneria/hvac/electricidad). ~23k records across 8 license types.
  | "delaware-dpr"
  // 2026-06-13: CA DIR ECU — certified + trainee electricians (~55k rows)
  | "ca-dir-ecu-electricians"
  // 2026-06-14: ES Castilla y León — talleres reparación vehículos (mecanica)
  // Open-data CSV from Junta de Castilla y León, ~1 000+ rows, CC BY 4.0.
  | "jcyl-talleres-es"
  // 2026-05-31: local-pa yellow-pages scrapers (residential-IP, humanlike pacing)
  | "seccion_amarilla"   // seccionamarilla.com.mx (MX)
  | "yellowpages_us"    // yellowpages.com (US)
  | "yellowpages_ca"    // yellowpages.ca (CA)
  | "pagesjaunes"       // pagesjaunes.fr (FR)
  // 2026-06-05: new per-country sources
  | "texas-bhec-psy"   // Texas BHEC psychologist CSV (~10k active licensees)
  | "bcpharmacists-bc" // College of Pharmacists of BC HTML roster (~7.4k)
  | "instaladoresoficiales-es" // instaladoresoficiales.com FENIE electricians (~12k ES)
  // 2026-06-06 scout wave: CA
  | "cdsa-ab-dentists" // CA: College of Dental Surgeons of Alberta (dentista)
  // 2026-06-07: Iowa DIAL — Active Construction Contractor Registrations
  // (~60k active Iowa contractors, all trades, Socrata open-data)
  | "iowa-dial-contractors"
  // 2026-06-07: AEDAF — Asociación Española de Asesores Fiscales (~664 members)
  // 2026-06-07: AEDAF — Asociación Española de Asesores Fiscales (~664 members, fiscal)
  | "aedaf-asesores-fiscales-es"
  // 2026-06-08: CT DCP State Licenses and Credentials (electricidad/fontaneria/hvac/carpinteria/ingenieria/arquitecto)
  | "connecticut-dcp"
  // 2026-06-09: WA Board of Accountancy CPAs — first US `fiscal` source
  | "wa-cpa-board" // data.wa.gov / WA State Certified Public Accountants
  // 2026-06-12: US — Florida DBPR Board of Veterinary Medicine (~14k VM licences, bulk CSV)
  | "florida-dbpr-vets"
  // 2026-06-13: ES — Colegio Oficial de Economistas de Valencia (fiscal, ~4120 rows)
  | "coev-economistas" // coev.com/colegiados
  // 2026-06-14: CA Quebec immigration consultants (MIFI open data)
  // 2026-06-15 wave: ES fontanería — RII Instaladores Gas (Ministerio Industria)
  // ~8.6k unique certified gas/fluid installer companies nationally; open CSV
  // from datos.gob.es. Mapped to fontaneria (gas+fluidos = water+gas in Spain).
  | "rii-instaladores-gas-es"
  // 2026-06-16: WA DOH psychologist credentials — first US psicologia source
  | "wa-doh-psychologists"
  // 2026-06-16: CA Manitoba lawyers
  | "lsm-lawyers-mb"
  // 2026-06-14: IRS FOIA — active Enrolled Agents (US fiscal / tax pros).
  // Public FOIA CSV, bi-annual refresh, ~87k rows worldwide, ~70k US-based.
  | "irs-ea-foia"
  // 2026-06-14: CA Quebec immigration consultants (MIFI open data, CC-BY 4.0)
  | "rqci-qc-ca" // Registre québécois des consultants en immigration
  // 2026-06-11: scout wave — SK dentists
  | "cdss-sk-dentists" // College of Dental Surgeons of Saskatchewan (dentista)
  // 2026-05-31: RII División B ES — Spain MINCOTUR open data CSV (~50k+ installers).
  | "rii-div-b-electricidad-es"
  // 2026-05-31: Nebraska DOL contractor registration (~20k US contractors).
  | "nebraska-dol-conreg"
  // 2026-05-31: College of Physiotherapists of Ontario — public register (~19k CA physiotherapists).
  | "cpo-on-physio"
  // 2026-06-01: US psicologia — Oklahoma State Board of Examiners of Psychologists (~1,200 records)
  | "ok-osbep-psychologists"
  // 2026-06-01: CA notario — BC Notaries Association public member directory (~458 records)
  | "bcna-bc-notaries"
  // 2026-05-15: ES psicología — COPM Madrid colegiados listing
  | "copm-psicologos"
  | "cgcod-es"
  // 2026-05-16: ES Ministerio de Industria — RII gas installers (fontaneria)
  | "rii-instaladores-es"
  // 2026-05-17: CA Manitoba Association of Architects
  | "maa-architects"
  // 2026-05-20: NPI Physical Therapists — fisioterapia US (NPPES V2 API)
  | "npi-physical-therapists"
  // 2026-05-21 wave: ES electricidad + hvac — RII División B national installer registry
  | "rii-div-b-es"
  // 2026-05-21: US Kentucky DHBC — electricians, HVAC, plumbers (KY)
  | "kentucky-dhbc"
  // 2026-05-22: ICAC ROAC — ES fiscal (Registro Oficial de Auditores de Cuentas)
  | "icac-roac-es"
  // 2026-05-22: NSRDDA — Nova Scotia Regulator of Dentistry and Dental Assisting
  | "nsrdda-ns-dentists"
  // 2026-05-22: Nebraska Board of Engineers and Architects — US ingenieria + arquitecto
  | "nebraska-ea"
  // 2026-05-24: BC College of Oral Health Professionals — BC dentists (~4.3k)
  | "bccohp-bc-dentists"
  // 2026-05-25: ES RII División A — national auto-repair workshop registry
  // (~19k talleres mecánicos), fills the `mecanica` gap for Spain.
  | "rii-div-a-talleres-es"
  // 2026-05-25: US NY DMV repair shops — Socrata open data, ~18k mecanica.
  | "ny-dmv-repair-shops"
  // 2026-05-25: CA CVBC — BC veterinary facility/practice registry (~670 active).
  | "cvbc-bc-vets"
  // 2026-05-26: US architects — NCARB certified architect directory
  | "ncarb-architects"
  // 2026-05-26: ES fiscal — Colegio de Mediadores de Seguros de Madrid
  | "mediadores-seguros-madrid"
  // 2026-05-26: CA lawyers — Law Society of Manitoba public Lawyer Lookup
  | "lsm-mb-lawyers"
  // 2026-05-27: RII Gas ES — Spain's national registry of gas installer
  // companies (Registro Integrado Industrial, Ministerio de Industria).
  // XLSX bulk download, ~26k records, category: fontaneria.
  | "rii-gas-es"
  // 2026-05-27: CONO — College of Naturopaths of Ontario (Alinity tenant
  // `cono`, ~1,500 registered NDs; public directory, no auth required).
  | "cono-naturopaths"
  // 2026-05-28: US Alabama General Contractors (LBGC)
  | "alabama-lbgc"
  // 2026-05-29 ES: Empresas Instaladoras y Mantenedoras de Castilla y León
  // (Junta de Castilla y León open-data XML, CC-BY 4.0; ~3,188 electricistas)
  | "jcyl-instaladoras-es"
  // 2026-05-29 CA: HCRA Ontario Builder Directory — licensed home builders
  // and sellers in Ontario (~7,063 active records, open JSON API).
  | "hcra-on-builders";

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
  /** ISO country code of the row. Required so a slug like `guadalajara`
   *  (which exists as a real city in both ES and MX) is unambiguous.
   *  Multi-country sources (google_places, osm, overture, wikidata,
   *  paginas-amarillas, gleif…) must set this per-row from the data
   *  they are emitting. */
  country: "ES" | "CA" | "US" | "FR" | "MX" | "GB";
  /** Slug within `country`. Pass empty string when the source only
   *  resolves to province granularity — the sink writes `city_slug = NULL`
   *  and you should populate `metadata.province_slug`. */
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
  country: "ES" | "CA" | "US" | "FR" | "MX" | "GB";
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
