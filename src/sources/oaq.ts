import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * OAQ — Ordre des Architectes du Québec.
 *
 * Pre-flight 2026-05-07: the public "Trouver un architecte" page
 * (https://www.oaq.com/services-de-larchitecte/trouver-un-architecte/)
 * loads a JSON API at:
 *
 *   POST https://www.oaq.com/wp-json/oaq/v1/architects/search
 *
 * with form-encoded body. An empty body returns the full active roster
 * (~4.9k architects) in a single response. Each result includes name,
 * permis, employer, phone, and full professional address (ville,
 * region_administrative, code_postal). No CAPTCHA, no Cloudflare, no
 * Imperva — plain WordPress REST endpoint, fronted by reCAPTCHA only on
 * other forms (contact). The recaptcha v3 site key visible in the page
 * source is not enforced on architects/search (verified via curl, no
 * X-Recaptcha-Token header required).
 *
 * Strategy: one POST to fetch the full list, then filter by ville and
 * map to seeded QC city slugs. Quebec has ~17 administrative regions
 * but city granularity is what matters for the directory ISR pages —
 * we keep the major cities and drop the rest (sink filters unseeded
 * slugs anyway, with a warning log).
 *
 * Off by default; `PROLIO_RUN_OAQ=true` to enable.
 * Cap via `PROLIO_OAQ_LIMIT` (default 1500 — full dataset is ~4.9k but
 * the cap keeps polite ceiling matching the task spec; raise in CI env
 * once stable).
 */

const BASE = process.env.PROLIO_OAQ_BASE || "https://www.oaq.com";
const ENDPOINT = "/wp-json/oaq/v1/architects/search";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 1000;
const REQUEST_JITTER_MS = 500;
const DEFAULT_LIMIT = 1500;

/**
 * Map of `ville` (free-text city name in OAQ payload) → seeded QC
 * city slug in the prolio cities table. We support the dozen+ largest
 * QC municipalities; everything else is dropped by the sink (which
 * already logs unseeded slugs).
 */
const QC_CITY_SLUG_BY_VILLE = new Map<string, string>([
  ["montréal", "montreal"],
  ["montreal", "montreal"],
  ["québec", "quebec-city"],
  ["quebec", "quebec-city"],
  ["laval", "laval"],
  ["gatineau", "gatineau"],
  ["longueuil", "longueuil"],
  ["sherbrooke", "sherbrooke"],
  ["trois-rivières", "trois-rivieres"],
  ["trois-rivieres", "trois-rivieres"],
  ["saguenay", "saguenay"],
  ["lévis", "levis"],
  ["levis", "levis"],
  ["terrebonne", "terrebonne"],
  ["saint-jérôme", "saint-jerome"],
  ["saint-jerome", "saint-jerome"],
  ["drummondville", "drummondville"],
  ["granby", "granby"],
  ["brossard", "brossard"],
  ["repentigny", "repentigny"],
]);

interface OaqAddress {
  adresse_civique?: string | null;
  adresse_civique2?: string | null;
  region_administrative?: string | null;
  ville?: string | null;
  province?: string | null;
  pays?: string | null;
  code_postal?: string | null;
}

interface OaqMember {
  prenom?: string;
  nom?: string;
  numero_de_permis?: string;
  annee_inscription?: number;
  employeur?: string;
  telephone?: string;
  membre_retraite?: boolean;
  limitation_droit_exercice?: boolean;
  suspension_droit_exercice?: boolean;
  adresse_professionnelle?: OaqAddress;
  sanitized_name?: string;
}

interface OaqResponse {
  results?: OaqMember[];
  total?: number;
  criteria?: unknown;
}

function jitter(): number {
  return REQUEST_DELAY_MS + Math.floor(Math.random() * REQUEST_JITTER_MS);
}

function resolveCitySlug(ville: string | null | undefined): string | null {
  if (!ville) return null;
  const key = ville.trim().toLowerCase();
  return QC_CITY_SLUG_BY_VILLE.get(key) ?? null;
}

function formatAddress(addr: OaqAddress | undefined): string | undefined {
  if (!addr) return undefined;
  const parts = [
    [addr.adresse_civique, addr.adresse_civique2].filter(Boolean).join(" "),
    addr.ville,
    addr.province,
    addr.code_postal,
  ]
    .map((s) => (s ? String(s).trim() : ""))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function buildName(m: OaqMember): string {
  const prenom = (m.prenom ?? "").trim();
  const nom = (m.nom ?? "").trim();
  return toTitleCase([prenom, nom].filter(Boolean).join(" "));
}

async function fetchAllArchitects(): Promise<OaqMember[]> {
  const url = `${BASE}${ENDPOINT}`;
  const body = new URLSearchParams();
  body.set("region", "");
  // Polite: tiny delay before the (single) request so the runner
  // never hammers the host even if invoked in tight loops.
  await delay(jitter());
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`OAQ ${ENDPOINT} → ${response.status}`);
  }
  const json = (await response.json()) as OaqResponse | false;
  if (!json || typeof json !== "object" || !Array.isArray(json.results)) {
    throw new Error("OAQ search returned unexpected payload");
  }
  console.log(`[oaq] api total=${json.total ?? "?"} returned=${json.results.length}`);
  return json.results;
}

function toRecord(m: OaqMember): ScrapedProfessional | null {
  const num = (m.numero_de_permis ?? "").trim();
  if (!num) return null;
  const name = buildName(m);
  if (!name) return null;
  const ville = m.adresse_professionnelle?.ville ?? null;
  const citySlug = resolveCitySlug(ville);
  if (!citySlug) return null;
  const phoneRaw = (m.telephone ?? "").trim();
  const phone = phoneRaw ? phoneRaw : undefined;
  return normalise({
    source: "oaq",
    sourceId: `oaq:${num}`,
    name,
    categoryKey: "arquitecto",
    citySlug,
    phone,
    address: formatAddress(m.adresse_professionnelle),
    licenseNumber: num,
    metadata: {
      country: "CA",
      province: "QC",
      authority: "OAQ",
      verified_by_authority: true,
      employer: m.employeur ?? null,
      annee_inscription: m.annee_inscription ?? null,
      retraite: Boolean(m.membre_retraite),
      limitation_droit_exercice: Boolean(m.limitation_droit_exercice),
      suspension_droit_exercice: Boolean(m.suspension_droit_exercice),
      region_administrative: m.adresse_professionnelle?.region_administrative ?? null,
    },
  });
}

export const oaqSource: ScraperSource = {
  name: "oaq",
  enabled() {
    return process.env.PROLIO_RUN_OAQ === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOaq(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!oaqSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_OAQ_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  let members: OaqMember[];
  try {
    members = await fetchAllArchitects();
  } catch (error) {
    console.error(`[oaq] fetch failed: ${(error as Error).message}`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const seen = new Set<string>();
  const records: ScrapedProfessional[] = [];
  let droppedNoCity = 0;
  let droppedRetired = 0;
  for (const m of members) {
    if (records.length >= limit) break;
    if (m.membre_retraite) {
      droppedRetired += 1;
      continue;
    }
    const rec = toRecord(m);
    if (!rec) {
      if (m.numero_de_permis) droppedNoCity += 1;
      continue;
    }
    if (seen.has(rec.sourceId)) continue;
    seen.add(rec.sourceId);
    records.push(rec);
  }

  console.log(
    `[oaq] mapped=${records.length} dropped_no_city=${droppedNoCity} dropped_retired=${droppedRetired} limit=${limit}`,
  );

  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[oaq] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
