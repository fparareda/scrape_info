/**
 * Prolio scraper — orchestrator.
 *
 * Weekly cron: iterates every (category, city) target, runs each enabled
 * source, normalises results, and upserts into Supabase via the service
 * role. Unclaimed pre-loaded rows get refreshed; claimed/verified rows are
 * skipped so the owner stays in control.
 *
 * Run manually:
 *   pnpm --filter @prolio/scraper scrape
 *
 * Run in CI (weekly): see .github/workflows/scrape.yml
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getSink } from "./sink.js";
import { listTargets } from "./targets.js";
import {
  googlePlacesSource,
  getGooglePlacesRequestsUsed,
} from "./sources/google-places.js";
import { COLEGIO_SOURCES } from "./sources/colegios/index.js";
import { bormeSource } from "./sources/borme/source.js";
import { osmSource } from "./sources/osm.js";
import { paginasAmarillasSource } from "./sources/paginas-amarillas.js";
import {
  runAllCcaaSources,
  ccaaSourcesEnabled,
} from "./sources/ccaa/index.js";
import {
  runWikidataEnrichment,
  wikidataEnabled,
} from "./sources/wikidata.js";
import {
  runCrossMatch,
  crossMatchEnabled,
} from "./sources/cross-match.js";
import { emailExtractorEnabled } from "./sources/email-extractor.js";
import { main as runEmailExtractorMain } from "./run-email-extractor.js";
import { emailCrawlerEnabled } from "./sources/email-crawler.js";
import { main as runEmailCrawlerMain } from "./run-email-crawler.js";
import {
  competitorEsColegiosMedicosEnabled,
  runCompetitorEsColegiosMedicos,
} from "./sources/competitor-es-colegios-medicos.js";
import {
  competitorCaLicensingSource,
  runCompetitorCaLicensing,
} from "./sources/competitor-ca-licensing.js";
import {
  competitorCaTradesEnabled,
  runCompetitorCaTrades,
} from "./sources/competitor-ca-trades.js";
import {
  competitorHouzzSource,
  runCompetitorHouzz,
} from "./sources/competitor-us-houzz.js";
import { cslbSource, runCslb } from "./sources/competitor-us-cslb.js";
import {
  competitorUsLawyersSource,
  runCompetitorUsLawyers,
} from "./sources/competitor-us-lawyers.js";
import {
  competitorUsBarsSource,
  runCompetitorUsBars,
} from "./sources/competitor-us-bar-associations.js";
import {
  competitorCaProfessionalEnabled,
  runCompetitorCaProfessional,
} from "./sources/competitor-ca-professional.js";
import {
  competitorDoctoraliaSource,
  runCompetitorDoctoralia,
} from "./sources/competitor-es-doctoralia.js";
import {
  patternMxEnabled,
  runPatternMx,
} from "./sources/pattern-mx-email.js";
import { gleifEnabled, runGleifEnrichment } from "./sources/gleif.js";
import { npiSource, runNpi } from "./sources/npi.js";
import { floridaDbprSource, runFloridaDbpr } from "./sources/florida-dbpr.js";
import { texasTdlrSource, runTexasTdlr } from "./sources/texas-tdlr.js";
import { arizonaRocSource, runArizonaRoc } from "./sources/arizona-roc.js";
import { washingtonLiSource, runWashingtonLi } from "./sources/washington-li.js";
import { oregonCcbSource, runOregonCcb } from "./sources/oregon-ccb.js";
import { nevadaNscbSource, runNevadaNscb } from "./sources/nevada-nscb.js";
import { cmqSource, runCmq } from "./sources/cmq.js";
import { barreauQcSource, runBarreauQc } from "./sources/barreau-qc.js";
import { odqSource, runOdq } from "./sources/odq.js";
import { oaqSource, runOaq } from "./sources/oaq.js";
import { cpsbcSource, runCpsbc } from "./sources/cpsbc.js";
import { cgaeSource, runCgae } from "./sources/cgae.js";
import { cscaeSource, runCscae } from "./sources/cscae.js";
import { illinoisIdfprSource, runIllinoisIdfpr } from "./sources/illinois-idfpr.js";
import { newYorkDosSource, runNewYorkDos } from "./sources/new-york-dos.js";
import { northCarolinaLbcSource, runNorthCarolinaLbc } from "./sources/north-carolina-lbc.js";
import { virginiaDporSource, runVirginiaDpor } from "./sources/virginia-dpor.js";
import { massachusettsDplSource, runMassachusettsDpl } from "./sources/massachusetts-dpl.js";
import { coloradoDoraSource, runColoradoDora } from "./sources/colorado-dora.js";
import { georgiaPlbSource, runGeorgiaPlb } from "./sources/georgia-plb.js";
import { pennsylvaniaBpoaSource, runPennsylvaniaBpoa } from "./sources/pennsylvania-bpoa.js";
import { wisconsinDspsSource, runWisconsinDsps } from "./sources/wisconsin-dsps.js";
import { minnesotaDliSource, runMinnesotaDli } from "./sources/minnesota-dli.js";
import { missouriDprSource, runMissouriDpr } from "./sources/missouri-dpr.js";
import { ohioElicenseSource, runOhioElicense } from "./sources/ohio-elicense.js";
import { michiganLaraSource, runMichiganLara } from "./sources/michigan-lara.js";
import { marylandDllrSource, runMarylandDllr } from "./sources/maryland-dllr.js";
import { newJerseyDcaSource, runNewJerseyDca } from "./sources/new-jersey-dca.js";
import { tennesseeTdciSource, runTennesseeTdci } from "./sources/tennessee-tdci.js";
import { cnbAvocatsSource, runCnbAvocats } from "./sources/cnb-avocats.js";
import { architectesFrSource, runArchitectesFr } from "./sources/architectes-fr.js";
import { oecFrSource, runOecFr } from "./sources/oec-fr.js";
import { ordreVetFrSource, runOrdreVetFr } from "./sources/ordre-vet-fr.js";
// FR consolidation 2026-05: rpps-fr + annuaire-sante-ameli → annuaire-sante-ans.
// CA wave 2026-05: 11 new provincial regulators + Alinity/Thentia infra.
// FR wave 2026-05: 8 new data.gouv bulk sources.
// MX wave 2026-05: 10 new federal + state directories.
import { annuaireSanteAnsSource, runAnnuaireSanteAns } from "./sources/annuaire-sante-ans.js";
import { sireneInseeSource, runSireneInsee } from "./sources/sirene-insee.js";
import { ademeRgeSource, runAdemeRge } from "./sources/ademe-rge.js";
import { finessSource, runFiness } from "./sources/finess.js";
import { prixControleTechniqueSource, runPrixControleTechnique } from "./sources/prix-controle-technique.js";
import { autoEcolesFrSource, runAutoEcolesFr } from "./sources/auto-ecoles-fr.js";
import { geometresFrSource, runGeometresFr } from "./sources/geometres-fr.js";
import { cnopPharmaciensSource, runCnopPharmaciens } from "./sources/cnop-pharmaciens.js";
import { tsaskSource, runTsask } from "./sources/tsask.js";
import { tsbcSource, runTsbc } from "./sources/tsbc.js";
import { cpsaSource, runCpsa } from "./sources/cpsa.js";
import { cpsmSource, runCpsm } from "./sources/cpsm.js";
import { cpsnlSource, runCpsnl } from "./sources/cpsnl.js";
import { cpspeiSource, runCpspei } from "./sources/cpspei.js";
import { capPsychologistsSource, runCapPsychologists } from "./sources/cap-psychologists.js";
import { cpmPhysioSource, runCpmPhysio } from "./sources/cpm-physio.js";
import { lssSaskatchewanSource, runLssSaskatchewan } from "./sources/lss-saskatchewan.js";
import { amvicDealersSource, runAmvicDealers } from "./sources/amvic-dealers.js";
import { apegaSource, runApega } from "./sources/apega.js";
import { notariadoMxSource, runNotariadoMx } from "./sources/notariado-mx.js";
import { sedemaVerificentrosCdmxSource, runSedemaVerificentrosCdmx } from "./sources/sedema-verificentros-cdmx.js";
import { verificacionEdomexSource, runVerificacionEdomex } from "./sources/verificacion-edomex.js";
import { verificacionJaliscoSource, runVerificacionJalisco } from "./sources/verificacion-jalisco.js";
import { cnsfAgentesSource, runCnsfAgentes } from "./sources/cnsf-agentes.js";
import { colegioNotariosCdmxSource, runColegioNotariosCdmx } from "./sources/colegio-notarios-cdmx.js";
import { fcarmArquitectosSource, runFcarmArquitectos } from "./sources/fcarm-arquitectos.js";
import { fedmvzColegiosVetSource, runFedmvzColegiosVet } from "./sources/fedmvz-colegios-vet.js";
import { conahcytSniiSource, runConahcytSnii } from "./sources/conahcyt-snii.js";
import { satEfosEdosSource, runSatEfosEdos } from "./sources/sat-efos-edos.js";
import { profecoSancionadosSource, runProfecoSancionados } from "./sources/profeco-sancionados.js";
import { crePermisionariosSource, runCrePermisionarios } from "./sources/cre-permisionarios.js";
import { siemSource, runSiem } from "./sources/siem.js";
import { cofeprisFarmaciasSource, runCofeprisFarmacias } from "./sources/cofepris-farmacias.js";
import { cnbvEntidadesSource, runCnbvEntidades } from "./sources/cnbv-entidades.js";
import { padronGanaderoNacionalSource, runPadronGanaderoNacional } from "./sources/padron-ganadero-nacional.js";
import { amdaDistribuidoresSource, runAmdaDistribuidores } from "./sources/amda-distribuidores.js";
import { cmicConstructorasSource, runCmicConstructoras } from "./sources/cmic-constructoras.js";
import { reFranchisesMxSource, runReFranchisesMx } from "./sources/re-franchises-mx.js";
import { irsPtinSource, runIrsPtin } from "./sources/irs-ptin.js";
import { cgcfeFisioterapeutasSource, runCgcfeFisioterapeutas } from "./sources/cgcfe-fisioterapeutas.js";
import { competitorDoctoraliaMxSource, runCompetitorDoctoraliaMx } from "./sources/competitor-mx-doctoralia.js";
import { senasicaMxVetSource, runSenasicaMxVet } from "./sources/senasica-mx-vet.js";
import { denueMxSource, runDenueMx } from "./sources/denue-mx.js";
import { oaaSource, runOaa } from "./sources/oaa.js";
import { louisianaLslbcSource, runLouisianaLslbc } from "./sources/louisiana-lslbc.js";
import { nycDobSource, runNycDob } from "./sources/nyc-dob.js";
import {
  cgnNotariadoEnabled,
  runCgnNotariado,
} from "./sources/cgn-notariado.js";
import {
  overtureEnabled,
  runOvertureEnrichment,
} from "./sources/overture.js";
import { competitorNaSource, runCompetitorNa } from "./sources/competitor-na.js";
import {
  competitorEsMegaEnabled,
  runCompetitorEsMega,
} from "./sources/competitor-es-mega.js";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { beginScrapeRun, withScrapeRun } from "./telemetry.js";
import type { ScrapedProfessional, ScraperSource } from "./types.js";

function loadLocalEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", ".env.local");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

async function main(): Promise<void> {
  loadLocalEnv();

  const sources: ScraperSource[] = [
    googlePlacesSource,
    osmSource,
    paginasAmarillasSource,
    ...COLEGIO_SOURCES,
    bormeSource,
  ].filter((s) => s.enabled());

  const ccaaEnabled = ccaaSourcesEnabled();
  const wdEnabled = wikidataEnabled();
  const xmEnabled = crossMatchEnabled();
  const emailEnabled = emailExtractorEnabled();
  const crawlerEnabled = emailCrawlerEnabled();
  const comMedicosEnabled = competitorEsColegiosMedicosEnabled();
  const caLicensingEnabled = competitorCaLicensingSource.enabled();
  const caTradesOn = competitorCaTradesEnabled();
  const houzzEnabled = competitorHouzzSource.enabled();
  const cslbEnabled = cslbSource.enabled();
  const usLawyersEnabled = competitorUsLawyersSource.enabled();
  const usBarsEnabled = competitorUsBarsSource.enabled();
  const caProfessionalOn = competitorCaProfessionalEnabled();
  const doctoraliaEnabled = competitorDoctoraliaSource.enabled();
  const patternMxOn = patternMxEnabled();
  const gleifOn = gleifEnabled();
  const npiOn = npiSource.enabled();
  const floridaDbprOn = floridaDbprSource.enabled();
  const texasTdlrOn = texasTdlrSource.enabled();
  const arizonaRocOn = arizonaRocSource.enabled();
  const washingtonLiOn = washingtonLiSource.enabled();
  const oregonCcbOn = oregonCcbSource.enabled();
  const nevadaNscbOn = nevadaNscbSource.enabled();
  const cmqOn = cmqSource.enabled();
  const barreauQcOn = barreauQcSource.enabled();
  const odqOn = odqSource.enabled();
  const oaqOn = oaqSource.enabled();
  const cpsbcOn = cpsbcSource.enabled();
  const cgaeOn = cgaeSource.enabled();
  const cscaeOn = cscaeSource.enabled();
  const illinoisIdfprOn = illinoisIdfprSource.enabled();
  const newYorkDosOn = newYorkDosSource.enabled();
  const northCarolinaLbcOn = northCarolinaLbcSource.enabled();
  const virginiaDporOn = virginiaDporSource.enabled();
  const massachusettsDplOn = massachusettsDplSource.enabled();
  const coloradoDoraOn = coloradoDoraSource.enabled();
  const georgiaPlbOn = georgiaPlbSource.enabled();
  const pennsylvaniaBpoaOn = pennsylvaniaBpoaSource.enabled();
  const wisconsinDspsOn = wisconsinDspsSource.enabled();
  const minnesotaDliOn = minnesotaDliSource.enabled();
  const missouriDprOn = missouriDprSource.enabled();
  const ohioElicenseOn = ohioElicenseSource.enabled();
  const michiganLaraOn = michiganLaraSource.enabled();
  const marylandDllrOn = marylandDllrSource.enabled();
  const newJerseyDcaOn = newJerseyDcaSource.enabled();
  const tennesseeTdciOn = tennesseeTdciSource.enabled();
  const cnbAvocatsOn = cnbAvocatsSource.enabled();
  const architectesFrOn = architectesFrSource.enabled();
  const oecFrOn = oecFrSource.enabled();
  const ordreVetFrOn = ordreVetFrSource.enabled();
  // 2026-05 wave: FR consolidation
  const annuaireSanteAnsOn = annuaireSanteAnsSource.enabled();
  const sireneInseeOn = sireneInseeSource.enabled();
  const ademeRgeOn = ademeRgeSource.enabled();
  const finessOn = finessSource.enabled();
  const prixControleTechniqueOn = prixControleTechniqueSource.enabled();
  const autoEcolesFrOn = autoEcolesFrSource.enabled();
  const geometresFrOn = geometresFrSource.enabled();
  const cnopPharmaciensOn = cnopPharmaciensSource.enabled();
  // 2026-05 wave: CA
  const tsaskOn = tsaskSource.enabled();
  const tsbcOn = tsbcSource.enabled();
  const cpsaOn = cpsaSource.enabled();
  const cpsmOn = cpsmSource.enabled();
  const cpsnlOn = cpsnlSource.enabled();
  const cpspeiOn = cpspeiSource.enabled();
  const capPsychologistsOn = capPsychologistsSource.enabled();
  const cpmPhysioOn = cpmPhysioSource.enabled();
  const lssSaskatchewanOn = lssSaskatchewanSource.enabled();
  const amvicDealersOn = amvicDealersSource.enabled();
  const apegaOn = apegaSource.enabled();
  // 2026-05 wave: MX
  const notariadoMxOn = notariadoMxSource.enabled();
  const sedemaVerificentrosCdmxOn = sedemaVerificentrosCdmxSource.enabled();
  const verificacionEdomexOn = verificacionEdomexSource.enabled();
  const verificacionJaliscoOn = verificacionJaliscoSource.enabled();
  const cnsfAgentesOn = cnsfAgentesSource.enabled();
  const colegioNotariosCdmxOn = colegioNotariosCdmxSource.enabled();
  const fcarmArquitectosOn = fcarmArquitectosSource.enabled();
  const fedmvzColegiosVetOn = fedmvzColegiosVetSource.enabled();
  const conahcytSniiOn = conahcytSniiSource.enabled();
  const satEfosEdosOn = satEfosEdosSource.enabled();
  const profecoSancionadosOn = profecoSancionadosSource.enabled();
  const crePermisionariosOn = crePermisionariosSource.enabled();
  const siemOn = siemSource.enabled();
  const cofeprisFarmaciasOn = cofeprisFarmaciasSource.enabled();
  const cnbvEntidadesOn = cnbvEntidadesSource.enabled();
  const padronGanaderoNacionalOn = padronGanaderoNacionalSource.enabled();
  const amdaDistribuidoresOn = amdaDistribuidoresSource.enabled();
  const cmicConstructorasOn = cmicConstructorasSource.enabled();
  const reFranchisesMxOn = reFranchisesMxSource.enabled();
  // 2026-05-14 wave: US
  const irsPtinOn = irsPtinSource.enabled();
  // 2026-05-14 wave: ES
  const cgcfeFisioterapeutasOn = cgcfeFisioterapeutasSource.enabled();
  const doctoraliaMxOn = competitorDoctoraliaMxSource.enabled();
  const senasicaMxVetOn = senasicaMxVetSource.enabled();
  const denueMxOn = denueMxSource.enabled();
  const oaaOn = oaaSource.enabled();
  const louisianaLslbcOn = louisianaLslbcSource.enabled();
  const nycDobOn = nycDobSource.enabled();
  const cgnNotariadoOn = cgnNotariadoEnabled();
  const overtureOn = overtureEnabled();
  const competitorNaOn = competitorNaSource.enabled();
  const competitorEsMegaOn = competitorEsMegaEnabled();

  if (
    sources.length === 0 &&
    !ccaaEnabled &&
    !wdEnabled &&
    !xmEnabled &&
    !emailEnabled &&
    !crawlerEnabled &&
    !comMedicosEnabled &&
    !caLicensingEnabled &&
    !caTradesOn &&
    !houzzEnabled &&
    !cslbEnabled &&
    !usLawyersEnabled &&
    !usBarsEnabled &&
    !caProfessionalOn &&
    !doctoraliaEnabled &&
    !patternMxOn &&
    !gleifOn &&
    !npiOn &&
    !floridaDbprOn &&
    !texasTdlrOn &&
    !arizonaRocOn &&
    !washingtonLiOn &&
    !oregonCcbOn &&
    !nevadaNscbOn &&
    !cmqOn &&
    !barreauQcOn &&
    !odqOn &&
    !oaqOn &&
    !cpsbcOn &&
    !cgaeOn &&
    !cscaeOn &&
    !illinoisIdfprOn &&
    !newYorkDosOn &&
    !northCarolinaLbcOn &&
    !virginiaDporOn &&
    !massachusettsDplOn &&
    !coloradoDoraOn &&
    !georgiaPlbOn &&
    !pennsylvaniaBpoaOn &&
    !wisconsinDspsOn &&
    !minnesotaDliOn &&
    !missouriDprOn &&
    !ohioElicenseOn &&
    !michiganLaraOn &&
    !marylandDllrOn &&
    !newJerseyDcaOn &&
    !tennesseeTdciOn &&
    !cnbAvocatsOn &&
    !architectesFrOn &&
    !oecFrOn &&
    !ordreVetFrOn &&
    !annuaireSanteAnsOn &&
    !sireneInseeOn &&
    !ademeRgeOn &&
    !finessOn &&
    !prixControleTechniqueOn &&
    !autoEcolesFrOn &&
    !geometresFrOn &&
    !cnopPharmaciensOn &&
    !tsaskOn &&
    !tsbcOn &&
    !cpsaOn &&
    !cpsmOn &&
    !cpsnlOn &&
    !cpspeiOn &&
    !capPsychologistsOn &&
    !cpmPhysioOn &&
    !lssSaskatchewanOn &&
    !amvicDealersOn &&
    !apegaOn &&
    !notariadoMxOn &&
    !sedemaVerificentrosCdmxOn &&
    !verificacionEdomexOn &&
    !verificacionJaliscoOn &&
    !cnsfAgentesOn &&
    !colegioNotariosCdmxOn &&
    !fcarmArquitectosOn &&
    !fedmvzColegiosVetOn &&
    !conahcytSniiOn &&
    !satEfosEdosOn &&
    !profecoSancionadosOn &&
    !crePermisionariosOn &&
    !siemOn &&
    !cofeprisFarmaciasOn &&
    !cnbvEntidadesOn &&
    !padronGanaderoNacionalOn &&
    !amdaDistribuidoresOn &&
    !cmicConstructorasOn &&
    !reFranchisesMxOn &&
    !doctoraliaMxOn &&
    !senasicaMxVetOn &&
    !denueMxOn &&
    !oaaOn &&
    !louisianaLslbcOn &&
    !nycDobOn &&
    !cgnNotariadoOn &&
    !overtureOn &&
    !competitorNaOn &&
    !competitorEsMegaOn &&
    !irsPtinOn &&
    !cgcfeFisioterapeutasOn
  ) {
    console.warn(
      "[scraper] no sources enabled — set one of: " +
        "GOOGLE_PLACES_API_KEY, PROLIO_SCRAPE_COLEGIOS=true, " +
        "PROLIO_SCRAPE_OSM=true, PROLIO_SCRAPE_CCAA=true, " +
        "PROLIO_SCRAPE_BORME=true, PROLIO_SCRAPE_WIKIDATA=true, " +
        "PROLIO_RUN_CROSSMATCH=true, " +
        "PROLIO_RUN_EMAIL_EXTRACTOR=true, PROLIO_RUN_EMAIL_CRAWLER=true, " +
        "PROLIO_RUN_COMPETITOR_ES_COLEGIOS_MEDICOS=true, " +
        "PROLIO_RUN_COMPETITOR_CA_LICENSING=true, " +
        "PROLIO_RUN_CA_TRADES=true, " +
        "PROLIO_RUN_COMPETITOR_HOUZZ=true, " +
        "PROLIO_RUN_CSLB=true, " +
        "PROLIO_RUN_US_LAWYERS=true, " +
        "PROLIO_RUN_US_BARS=true, " +
        "PROLIO_RUN_DOCTORALIA=true, " +
        "PROLIO_RUN_PATTERN_MX=true, " +
        "PROLIO_RUN_GLEIF=true, " +
        "PROLIO_RUN_NPI=true, " +
        "PROLIO_RUN_FLORIDA_DBPR=true, " +
        "PROLIO_RUN_TEXAS_TDLR=true, " +
        "PROLIO_RUN_ARIZONA_ROC=true, " +
        "PROLIO_RUN_WASHINGTON_LI=true, " +
        "PROLIO_RUN_OREGON_CCB=true, " +
        "PROLIO_RUN_NEVADA_NSCB=true, " +
        "PROLIO_RUN_CMQ=true, " +
        "PROLIO_RUN_BARREAU_QC=true, " +
        "PROLIO_RUN_ODQ=true, " +
        "PROLIO_RUN_CPSBC=true, " +
        "PROLIO_RUN_CGAE=true, " +
        "PROLIO_RUN_CSCAE=true, " +
        "PROLIO_RUN_ILLINOIS_IDFPR=true, " +
        "PROLIO_RUN_NEW_YORK_DOS=true, " +
        "PROLIO_RUN_NORTH_CAROLINA_LBC=true, " +
        "PROLIO_RUN_VIRGINIA_DPOR=true, " +
        "PROLIO_RUN_MASSACHUSETTS_DPL=true, " +
        "PROLIO_RUN_COLORADO_DORA=true, " +
        "PROLIO_RUN_GEORGIA_PLB=true, " +
        "PROLIO_RUN_PENNSYLVANIA_BPOA=true, " +
        "PROLIO_RUN_WISCONSIN_DSPS=true, " +
        "PROLIO_RUN_MINNESOTA_DLI=true, " +
        "PROLIO_RUN_MISSOURI_DPR=true, " +
        "PROLIO_RUN_OHIO_ELICENSE=true, " +
        "PROLIO_RUN_MICHIGAN_LARA=true, " +
        "PROLIO_RUN_MARYLAND_DLLR=true, " +
        "PROLIO_RUN_NEW_JERSEY_DCA=true, " +
        "PROLIO_RUN_TENNESSEE_TDCI=true, " +
        "PROLIO_RUN_CNB_AVOCATS=true, " +
        "PROLIO_RUN_ARCHITECTES_FR=true, " +
        "PROLIO_RUN_OEC_FR=true, " +
        "PROLIO_RUN_ANNUAIRE_SANTE_ANS=true, " +
        "PROLIO_RUN_DOCTORALIA_MX=true, " +
        "PROLIO_RUN_SENASICA_MX_VET=true, " +
        "PROLIO_RUN_DENUE_MX=true, " +
        "PROLIO_RUN_LOUISIANA_LSLBC=true, " +
        "PROLIO_RUN_CGN_NOTARIADO=true, " +
        "PROLIO_RUN_OAQ=true, " +
        "PROLIO_RUN_OAA=true, " +
        "PROLIO_RUN_NYC_DOB=true, " +
        "PROLIO_RUN_ORDRE_VET_FR=true, " +
        "PROLIO_RUN_SIRENE_INSEE=true, " +
        "PROLIO_RUN_ADEME_RGE=true, " +
        "PROLIO_RUN_FINESS=true, " +
        "PROLIO_RUN_PRIX_CONTROLE_TECHNIQUE=true, " +
        "PROLIO_RUN_AUTO_ECOLES_FR=true, " +
        "PROLIO_RUN_GEOMETRES_FR=true, " +
        "PROLIO_RUN_CNOP_PHARMACIENS=true, " +
        "PROLIO_RUN_TSASK=true, PROLIO_RUN_TSBC=true, " +
        "PROLIO_RUN_CPSA=true, PROLIO_RUN_CPSM=true, " +
        "PROLIO_RUN_CPSNL=true, PROLIO_RUN_CPSPEI=true, " +
        "PROLIO_RUN_CAP_PSYCHOLOGISTS=true, PROLIO_RUN_CPM_PHYSIO=true, " +
        "PROLIO_RUN_LSS_SASKATCHEWAN=true, PROLIO_RUN_AMVIC_DEALERS=true, " +
        "PROLIO_RUN_APEGA=true, " +
        "PROLIO_RUN_NOTARIADO_MX=true, " +
        "PROLIO_RUN_SEDEMA_VERIFICENTROS_CDMX=true, " +
        "PROLIO_RUN_VERIFICACION_EDOMEX=true, PROLIO_RUN_VERIFICACION_JALISCO=true, " +
        "PROLIO_RUN_CNSF_AGENTES=true, PROLIO_RUN_COLEGIO_NOTARIOS_CDMX=true, " +
        "PROLIO_RUN_FCARM_ARQUITECTOS=true, PROLIO_RUN_FEDMVZ_COLEGIOS_VET=true, " +
        "PROLIO_RUN_CONAHCYT_SNII=true, " +
        "PROLIO_RUN_COMPETITOR_NA=true, " +
        "PROLIO_RUN_COMPETITOR_ES_MEGA=true, " +
        "PROLIO_SCRAPE_OVERTURE=true, " +
        "PROLIO_RUN_IRS_PTIN=true, " +
        "PROLIO_RUN_CGCFE_FISIOTERAPEUTAS=true",
    );
    return;
  }

  console.log(
    `[scraper] sources: ${sources.map((s) => s.name).join(", ")} ` +
      `(${sources.length} enabled)`,
  );

  const targets = await listTargets();
  const sink = getSink();

  let total = 0;
  // Per-target sources share a single scrape_runs row per source across
  // all targets (avoids N×M rows per weekly run). Open one running row
  // per enabled source up front, aggregate counts, then finalise. If a
  // source throws, we mark ITS run as error but keep going.
  const perSourceAgg = new Map<
    string,
    {
      fetched: number;
      upserted: number;
      skipped: number;
      errored: boolean;
      handle: Awaited<ReturnType<typeof beginScrapeRun>>;
    }
  >();
  for (const s of sources) {
    perSourceAgg.set(s.name, {
      fetched: 0,
      upserted: 0,
      skipped: 0,
      errored: false,
      handle: await beginScrapeRun(s.name),
    });
  }
  for (const target of targets) {
    const combined: ScrapedProfessional[] = [];
    for (const source of sources) {
      const agg = perSourceAgg.get(source.name)!;
      try {
        const records = await source.fetch(target);
        agg.fetched += records.length;
        combined.push(...records);
      } catch (err) {
        agg.errored = true;
        console.error(
          `[scraper] ${source.name} crashed on ${target.categoryKey}/${target.citySlug}:`,
          (err as Error).message,
        );
      }
    }
    if (combined.length === 0) continue;

    const { inserted, updated, skipped } = await sink.upsert(combined);
    total += inserted + updated;
    // Per-source upsert tallies aren't directly available from sink
    // (which operates on the merged batch). We attribute upserts
    // proportionally to fetched-count share — good enough for panel
    // trending; exact accounting would require per-source sink calls.
    const totalFetched = combined.length || 1;
    for (const source of sources) {
      const agg = perSourceAgg.get(source.name)!;
      const fromThis = combined.filter((r) => r.source === source.name).length;
      if (fromThis === 0) continue;
      const share = fromThis / totalFetched;
      agg.upserted += Math.round((inserted + updated) * share);
      agg.skipped += Math.round(skipped * share);
    }
    console.log(
      `[scraper] ${target.categoryKey}/${target.citySlug}: ` +
        `found=${combined.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
  }
  // Flush per-target source telemetry. One row per source, status based
  // on whether any target threw.
  for (const source of sources) {
    const agg = perSourceAgg.get(source.name)!;
    if (agg.errored) {
      await agg.handle.error(new Error("one or more targets threw; see logs"));
    } else {
      await agg.handle.ok({
        rowsFetched: agg.fetched,
        rowsUpserted: agg.upserted,
        rowsSkipped: agg.skipped,
        metadata: { targets: targets.length },
      });
    }
  }
  // CCAA registries: one-shot bulk fetches (no per-target iteration).
  if (ccaaEnabled) {
    await withScrapeRun("ccaa_registry", async () => {
      const ccaaRows = await runAllCcaaSources();
      if (ccaaRows.length === 0) {
        return { rowsFetched: 0 };
      }
      const { inserted, updated, skipped } = await sink.upsert(ccaaRows);
      total += inserted + updated;
      console.log(
        `[scraper] ccaa: found=${ccaaRows.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
      );
      return {
        rowsFetched: ccaaRows.length,
        rowsUpserted: inserted + updated,
        rowsSkipped: skipped,
      };
    }).catch((e) => console.error(`[scraper] ccaa crashed:`, (e as Error).message));
  }

  // Wikidata authority entities (hospitals, universities, etc).
  if (wdEnabled) {
    await withScrapeRun("wikidata", async () => {
      const wdRows = await runWikidataEnrichment();
      if (wdRows.length === 0) return { rowsFetched: 0 };
      const { inserted, updated, skipped } = await sink.upsert(wdRows);
      total += inserted + updated;
      console.log(
        `[scraper] wikidata: found=${wdRows.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
      );
      return {
        rowsFetched: wdRows.length,
        rowsUpserted: inserted + updated,
        rowsSkipped: skipped,
      };
    }).catch((e) => console.error(`[scraper] wikidata crashed:`, (e as Error).message));
  }

  // Cross-match colegio ↔ google_places — fills phone/email/address
  // on sparse colegio rows using same-city Google entries.
  if (xmEnabled) {
    await withScrapeRun("cross_match", async () => {
      await runCrossMatch();
      return {};
    }).catch((e) => console.error(`[scraper] xm crashed:`, (e as Error).message));
  }

  // Free website → email extractor. Shallow: homepage + 6 known
  // contact paths. One-off force mode via PROLIO_EMAIL_EXTRACTOR_IDS.
  if (emailEnabled) {
    await withScrapeRun("email_extractor", async () => {
      await runEmailExtractorMain();
      return {};
    }).catch((e) => console.error(`[scraper] email-extractor crashed:`, (e as Error).message));
  }

  // Deep BFS crawler. Walks the full site tree up to depth 3 (bounded
  // at 25 pages per site, 2500 pages per run). Catches emails hidden
  // behind team/service/blog pages that the shallow extractor misses.
  // Coexists with the shallow extractor — only processes pros that
  // don't already have a website_scrape row unless force-mode
  // (PROLIO_EMAIL_CRAWLER_IDS) is set.
  if (crawlerEnabled) {
    await withScrapeRun("email_crawler", async () => {
      const result = await runEmailCrawlerMain();
      if (!result) return {};
      return {
        rowsFetched: result.pagesFetched,
        rowsUpserted: result.newEmails,
        metadata: {
          crawled: result.crawled,
          pros_with_emails: result.prosWithEmails,
          failures: result.failures,
          ig_handles_detected: result.igHandlesDetected,
        },
      };
    }).catch((e) => console.error(`[scraper] email-crawler crashed:`, (e as Error).message));
  }

  // Provincial Colegios Oficiales de Médicos (OMC) — per-colegio sweep.
  // 2026-04-24 pre-flight of all 52 provincial colegios landed 3
  // implementable adapters: COMZ (Zaragoza) + ICOMEM (Madrid) + COMGI
  // (Gipuzkoa). Full matrix in docs/COLEGIOS_MEDICOS_SPAIN.md.
  //
  // The module emits its own per-colegio scrape_runs rows (omc-<code>)
  // so per-province yield is visible in /admin — no outer wrapper here.
  // Rows carry metadata.verified_by_colegio=true so landings can badge
  // "Verificado por COM <Provincia>".
  if (comMedicosEnabled) {
    try {
      const res = await runCompetitorEsColegiosMedicos();
      total += res.inserted + res.updated;
      console.log(
        `[scraper] com-medicos: fetched=${res.fetched} parsed=${res.parsed} ` +
          `inserted=${res.inserted} updated=${res.updated} skipped=${res.skipped}`,
      );
    } catch (e) {
      console.error(`[scraper] com-medicos crashed:`, (e as Error).message);
    }
  }

  // Canadian provincial licensing bodies — ECRA (Ontario electricians)
  // is the only adapter surviving pre-flight as of 2026-04-24. BCSA
  // and CMMTQ are blocked (robots disallow + auth wall respectively).
  // workflow_dispatch only; see .github/workflows/scrape.yml.
  if (caLicensingEnabled) {
    await withScrapeRun("ecra", async () => {
      await runCompetitorCaLicensing();
      return {};
    }).catch((e) => console.error(`[scraper] ca-licensing crashed:`, (e as Error).message));
  }

  // Canadian regulated trades — TSSA Ontario fuels contractors + HCRA
  // Ontario builders. Source wraps each authority in its own
  // `withScrapeRun` (so `tssa` and `hcra` get separate /admin rows and
  // one failing won't mask the other). OPHA reserved as a kill (see
  // competitor-ca-trades.ts header). Weekly cron via
  // .github/workflows/scrape-ca-trades.yml.
  if (caTradesOn) {
    await runCompetitorCaTrades().catch((e) =>
      console.error(`[scraper] ca-trades crashed:`, (e as Error).message),
    );
  }

  // Pattern + MX email discovery — workflow_dispatch only. For pros
  // with website but no email, generates 8 candidate addresses
  // (info/contacto/hola/admin + name-based) and writes those whose
  // domain has at least one MX record. Confidence 0.5–0.7. Telemetry
  // wraps the whole run; counters are inside the source. Needs its own
  // service-role client so we can hit `professional_emails` directly
  // without going through the sink (which only handles full Pro rows).
  if (patternMxOn) {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) {
        console.warn("[scraper] pattern-mx: missing Supabase env, skipping");
      } else {
        const db = createSupabaseClient(url, key, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const res = await runPatternMx(db);
        console.log(
          `[scraper] pattern-mx: processed=${res.prosProcessed} skipped=${res.prosSkipped} written=${res.emailsWritten}`,
        );
      }
    } catch (e) {
      console.error(`[scraper] pattern-mx crashed:`, (e as Error).message);
    }
  }

  // GLEIF (Global LEI) — enrichment-only. Matches GLEIF
  // `entity.registeredAs` against existing professionals.cif and
  // writes LEI + parent LEI + jurisdiction into metadata. The sister
  // Industry Canada source was killed pre-flight (no public JSON API
  // exists); only GLEIF ships in this slot. Weekly cron via
  // .github/workflows/scrape-gleif.yml.
  if (gleifOn) {
    await withScrapeRun("gleif", async () => {
      const res = await runGleifEnrichment();
      total += res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.updated,
        rowsSkipped: Math.max(0, res.matched - res.updated),
        metadata: { matched: res.matched, countries: res.countries },
      };
    }).catch((e) => console.error(`[scraper] gleif crashed:`, (e as Error).message));
  }

  // CSLB California contractors — workflow_dispatch + weekly cron.
  // Cap 2000 rows/run across the four target classifications
  // (C-10/C-36/C-20/C-6). Bulk .xlsx export per classification.
  if (cslbEnabled) {
    await withScrapeRun("cslb", async () => {
      const res = await runCslb();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) => console.error(`[scraper] cslb crashed:`, (e as Error).message));
  }

  // NPI Registry US healthcare — minimal API path. Iterates 51 states ×
  // 5 taxonomies, capped per-state by PROLIO_NPI_LIMIT_PER_STATE
  // (default 200). Self-managed sink upserts; emits one telemetry row.
  if (npiOn) {
    await withScrapeRun("npi", async () => {
      await runNpi();
      return {};
    }).catch((e) => console.error(`[scraper] npi crashed:`, (e as Error).message));
  }

  // US contractor boards (state-level). Each is a bulk CSV pull capped
  // by its own LIMIT env. Endpoints documented in each source — must
  // be verified on first run; sink filters rows whose city slug isn't
  // seeded so unmapped cities are dropped silently.
  if (floridaDbprOn) {
    await withScrapeRun("florida-dbpr", async () => {
      const res = await runFloridaDbpr();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] florida-dbpr crashed:`, (e as Error).message),
    );
  }

  if (texasTdlrOn) {
    await withScrapeRun("texas-tdlr", async () => {
      const res = await runTexasTdlr();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] texas-tdlr crashed:`, (e as Error).message),
    );
  }

  if (arizonaRocOn) {
    await withScrapeRun("arizona-roc", async () => {
      const res = await runArizonaRoc();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] arizona-roc crashed:`, (e as Error).message),
    );
  }

  if (washingtonLiOn) {
    await withScrapeRun("washington-li", async () => {
      const res = await runWashingtonLi();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] washington-li crashed:`, (e as Error).message),
    );
  }

  if (oregonCcbOn) {
    await withScrapeRun("oregon-ccb", async () => {
      const res = await runOregonCcb();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] oregon-ccb crashed:`, (e as Error).message),
    );
  }

  if (nevadaNscbOn) {
    await withScrapeRun("nevada-nscb", async () => {
      const res = await runNevadaNscb();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] nevada-nscb crashed:`, (e as Error).message),
    );
  }

  // CA provincial regulators (Quebec + BC). Pre-flight robots.txt
  // verified per source — Law Society of BC was excluded because its
  // robots.txt explicitly Disallows the lawyer lookup paths.
  if (cmqOn) {
    await withScrapeRun("cmq", async () => {
      const res = await runCmq();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) => console.error(`[scraper] cmq crashed:`, (e as Error).message));
  }

  if (barreauQcOn) {
    await withScrapeRun("barreau-qc", async () => {
      const res = await runBarreauQc();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] barreau-qc crashed:`, (e as Error).message),
    );
  }

  if (odqOn) {
    await withScrapeRun("odq", async () => {
      const res = await runOdq();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) => console.error(`[scraper] odq crashed:`, (e as Error).message));
  }

  if (oaqOn) {
    await withScrapeRun("oaq", async () => {
      const res = await runOaq();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) => console.error(`[scraper] oaq crashed:`, (e as Error).message));
  }

  if (cpsbcOn) {
    await withScrapeRun("cpsbc", async () => {
      const res = await runCpsbc();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] cpsbc crashed:`, (e as Error).message),
    );
  }

  // ES national colegios. Single endpoint covers all autonomic
  // colegios for that profession.
  if (cgaeOn) {
    await withScrapeRun("cgae", async () => {
      const res = await runCgae();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] cgae crashed:`, (e as Error).message),
    );
  }

  if (cscaeOn) {
    await withScrapeRun("cscae", async () => {
      const res = await runCscae();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] cscae crashed:`, (e as Error).message),
    );
  }

  // Additional US state contractor / professional boards.
  for (const [flag, name, runFn] of [
    [illinoisIdfprOn, "illinois-idfpr", runIllinoisIdfpr],
    [newYorkDosOn, "new-york-dos", runNewYorkDos],
    [northCarolinaLbcOn, "north-carolina-lbc", runNorthCarolinaLbc],
    [virginiaDporOn, "virginia-dpor", runVirginiaDpor],
    [massachusettsDplOn, "massachusetts-dpl", runMassachusettsDpl],
    [coloradoDoraOn, "colorado-dora", runColoradoDora],
    [georgiaPlbOn, "georgia-plb", runGeorgiaPlb],
    [pennsylvaniaBpoaOn, "pennsylvania-bpoa", runPennsylvaniaBpoa],
    [wisconsinDspsOn, "wisconsin-dsps", runWisconsinDsps],
    [minnesotaDliOn, "minnesota-dli", runMinnesotaDli],
    [missouriDprOn, "missouri-dpr", runMissouriDpr],
    [ohioElicenseOn, "ohio-elicense", runOhioElicense],
    [michiganLaraOn, "michigan-lara", runMichiganLara],
    [marylandDllrOn, "maryland-dllr", runMarylandDllr],
    [newJerseyDcaOn, "new-jersey-dca", runNewJerseyDca],
    [tennesseeTdciOn, "tennessee-tdci", runTennesseeTdci],
    [cnbAvocatsOn, "cnb-avocats", runCnbAvocats],
    [architectesFrOn, "architectes-fr", runArchitectesFr],
    [oecFrOn, "oec-fr", runOecFr],
    [ordreVetFrOn, "ordre-vet-fr", runOrdreVetFr],
    [annuaireSanteAnsOn, "annuaire-sante-ans", runAnnuaireSanteAns],
    [sireneInseeOn, "sirene-insee", runSireneInsee],
    [ademeRgeOn, "ademe-rge", runAdemeRge],
    [finessOn, "finess", runFiness],
    [prixControleTechniqueOn, "prix-controle-technique", runPrixControleTechnique],
    [autoEcolesFrOn, "auto-ecoles-fr", runAutoEcolesFr],
    [geometresFrOn, "geometres-fr", runGeometresFr],
    [cnopPharmaciensOn, "cnop-pharmaciens", runCnopPharmaciens],
    [tsaskOn, "tsask", runTsask],
    [tsbcOn, "tsbc", runTsbc],
    [cpsaOn, "cpsa", runCpsa],
    [cpsmOn, "cpsm", runCpsm],
    [cpsnlOn, "cpsnl", runCpsnl],
    [cpspeiOn, "cpspei", runCpspei],
    [capPsychologistsOn, "cap-psychologists", runCapPsychologists],
    [cpmPhysioOn, "cpm-physio", runCpmPhysio],
    [lssSaskatchewanOn, "lss-saskatchewan", runLssSaskatchewan],
    [amvicDealersOn, "amvic-dealers", runAmvicDealers],
    [apegaOn, "apega", runApega],
    [notariadoMxOn, "notariado-mx", runNotariadoMx],
    [sedemaVerificentrosCdmxOn, "sedema-verificentros-cdmx", runSedemaVerificentrosCdmx],
    [verificacionEdomexOn, "verificacion-edomex", runVerificacionEdomex],
    [verificacionJaliscoOn, "verificacion-jalisco", runVerificacionJalisco],
    [cnsfAgentesOn, "cnsf-agentes", runCnsfAgentes],
    [colegioNotariosCdmxOn, "colegio-notarios-cdmx", runColegioNotariosCdmx],
    [fcarmArquitectosOn, "fcarm-arquitectos", runFcarmArquitectos],
    [fedmvzColegiosVetOn, "fedmvz-colegios-vet", runFedmvzColegiosVet],
    [conahcytSniiOn, "conahcyt-snii", runConahcytSnii],
    [satEfosEdosOn, "sat-efos-edos", runSatEfosEdos],
    [profecoSancionadosOn, "profeco-sancionados", runProfecoSancionados],
    [crePermisionariosOn, "cre-permisionarios", runCrePermisionarios],
    [siemOn, "siem", runSiem],
    [cofeprisFarmaciasOn, "cofepris-farmacias", runCofeprisFarmacias],
    [cnbvEntidadesOn, "cnbv-entidades", runCnbvEntidades],
    [padronGanaderoNacionalOn, "padron-ganadero-nacional", runPadronGanaderoNacional],
    [amdaDistribuidoresOn, "amda-distribuidores", runAmdaDistribuidores],
    [cmicConstructorasOn, "cmic-constructoras", runCmicConstructoras],
    [reFranchisesMxOn, "re-franchises-mx", runReFranchisesMx],
    [irsPtinOn, "irs-ptin", runIrsPtin],
    [cgcfeFisioterapeutasOn, "cgcfe-fisioterapeutas", runCgcfeFisioterapeutas],
    [senasicaMxVetOn, "senasica-mx-vet", runSenasicaMxVet],
    [denueMxOn, "denue-mx", runDenueMx],
    [oaaOn, "oaa", runOaa],
    [louisianaLslbcOn, "louisiana-lslbc", runLouisianaLslbc],
    [nycDobOn, "nyc-dob", runNycDob],
    [cgnNotariadoOn, "cgn-notariado", runCgnNotariado],
  ] as Array<[boolean, string, () => Promise<{ fetched: number; inserted: number; updated: number; skipped: number }>]>) {
    if (!flag) continue;
    await withScrapeRun(name, async () => {
      const res = await runFn();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] ${name} crashed:`, (e as Error).message),
    );
  }

  // Houzz US — workflow_dispatch only. Cap 500 rows/run.
  if (houzzEnabled) {
    await withScrapeRun("houzz", async () => {
      const res = await runCompetitorHouzz();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) => console.error(`[scraper] houzz crashed:`, (e as Error).message));
  }

  // US lawyers (Avvo) — workflow_dispatch + weekly Sun 13:00 UTC.
  // Cap 1000 rows/run. Immigration lawyers tagged as wedge_specialty=
  // 'extranjeria' (Prolio's revenue wedge in ES).
  if (usLawyersEnabled) {
    await withScrapeRun("us-lawyers", async () => {
      const res = await runCompetitorUsLawyers();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
        metadata: { wedge_extranjeria: res.wedge },
      };
    }).catch((e) =>
      console.error(`[scraper] us-lawyers crashed:`, (e as Error).message),
    );
  }

  // US bar associations + AILA — monthly day 3 05:00 UTC. Bar renewals
  // are annual; data is slow-moving. Only `bar-ca` (CalBar) emits rows
  // today; bar-ny/bar-tx/aila are stub adapters that log a skip reason
  // (see competitor-us-bar-associations.ts). Immigration practice areas
  // map to wedge_specialty='extranjeria'.
  if (usBarsEnabled) {
    await withScrapeRun("us-bars", async () => {
      const res = await runCompetitorUsBars();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
        metadata: {
          wedge_extranjeria: res.wedge,
          lawyer_general: res.general,
        },
      };
    }).catch((e) =>
      console.error(`[scraper] us-bars crashed:`, (e as Error).message),
    );
  }

  // CA professional regulators (CPSO + LSO + RCDSO) — monthly day 1
  // 13:00 UTC. RCDSO is the only adapter actually emitting rows as of
  // 2026-04-24; CPSO is Cloudflare-blocked, LSO is robots+Cloudflare-
  // blocked. The module emits its own per-college scrape_runs rows
  // (cpso/lso/rcdso) so /admin shows per-regulator yield even when
  // only one is built. No outer wrapper here.
  if (caProfessionalOn) {
    try {
      await runCompetitorCaProfessional();
    } catch (e) {
      console.error(
        `[scraper] ca-professional crashed:`,
        (e as Error).message,
      );
    }
  }

  // Doctoralia ES — weekly Sunday 12:00 UTC schedule + workflow_dispatch.
  // Cap PROLIO_DOCTORALIA_LIMIT (default 1000) rows/run. Iterates
  // (3 specialties × ~200 ES cities) but stops at the cap, so a typical
  // run touches ~30–35 pages. See .github/workflows/scrape-doctoralia.yml.
  if (doctoraliaEnabled) {
    await withScrapeRun("doctoralia", async () => {
      const res = await runCompetitorDoctoralia();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] doctoralia crashed:`, (e as Error).message),
    );
  }

  if (doctoraliaMxOn) {
    await withScrapeRun("doctoralia-mx", async () => {
      const res = await runCompetitorDoctoraliaMx();
      if (!res) return {};
      total += res.inserted + res.updated;
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] doctoralia-mx crashed:`, (e as Error).message),
    );
  }

  // Overture Maps — bulk POI enrichment. One-shot fetch returning rows
  // that go through the standard sink (same pattern as Wikidata).
  if (overtureOn) {
    await withScrapeRun("overture", async () => {
      const rows = await runOvertureEnrichment();
      if (rows.length === 0) return { rowsFetched: 0 };
      const { inserted, updated, skipped } = await sink.upsert(rows);
      total += inserted + updated;
      console.log(
        `[scraper] overture: found=${rows.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
      );
      return {
        rowsFetched: rows.length,
        rowsUpserted: inserted + updated,
        rowsSkipped: skipped,
      };
    }).catch((e) =>
      console.error(`[scraper] overture crashed:`, (e as Error).message),
    );
  }

  // Competitor NA marketplace — self-managed sink. Cap via
  // PROLIO_COMPETITOR_NA_LIMIT (default in source).
  if (competitorNaOn) {
    await withScrapeRun("competitor-na", async () => {
      await runCompetitorNa();
      return {};
    }).catch((e) =>
      console.error(`[scraper] competitor-na crashed:`, (e as Error).message),
    );
  }

  // Competitor ES mega — aggregated ES marketplace sweep. Returns
  // its own stats; emails are written directly to professional_emails.
  if (competitorEsMegaOn) {
    await withScrapeRun("competitor-es-mega", async () => {
      const res = await runCompetitorEsMega();
      total += res.inserted + res.updated;
      console.log(
        `[scraper] competitor-es-mega: fetched=${res.fetched} parsed=${res.parsed} ` +
          `inserted=${res.inserted} updated=${res.updated} skipped=${res.skipped} emails=${res.emails}`,
      );
      return {
        rowsFetched: res.fetched,
        rowsUpserted: res.inserted + res.updated,
        rowsSkipped: res.skipped,
        metadata: { emails: res.emails },
      };
    }).catch((e) =>
      console.error(`[scraper] competitor-es-mega crashed:`, (e as Error).message),
    );
  }

  const placesRequests = getGooglePlacesRequestsUsed();
  if (placesRequests > 0) {
    const estCost = (placesRequests * 0.032).toFixed(2);
    console.log(
      `[scraper] google_places requests=${placesRequests} est_cost=$${estCost}`,
    );
  }
  console.log(`[scraper] done — ${total} rows written across ${targets.length} targets`);
}

main().catch(async (error) => {
  console.error(error);
  // Don't let an alert failure mask the real cause — best effort.
  try {
    const { sendScraperAlert } = await import("./alerts.js");
    await sendScraperAlert(
      "critical",
      "Scraper crashed",
      `${(error as Error).stack ?? error}`.slice(0, 1500),
    );
  } catch {
    /* ignore */
  }
  process.exit(1);
});
