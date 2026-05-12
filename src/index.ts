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
    !npiOn
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
        "PROLIO_RUN_NPI=true",
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
