import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * VUCOLVET — Ventanilla Única Colegial Veterinaria
 * (https://vucolvet.org/).
 *
 * National ES public registry of colegiados veterinarios, published by
 * the OCV under Ley 17/2009 (Ventanilla Única). The site is a Laravel
 * app: the `/buscador-colegiados` endpoint accepts a POST form with a
 * CSRF token issued on a preceding GET. Each provincia is identified by
 * a numeric id (1..52) — there is no aggregate "all" pagination, so we
 * fan out per provincia and per surname-prefix to stay within the
 * "min 3 chars" constraint on the `search` (apellidos) input.
 *
 * Result rows are rendered as cards:
 *   <div ... data-uk-id="17935" data-uk-prov="28" ...>
 *     <h3 class="uk-text-lead">CARLOS ABELLAN GARCIA ...</h3>
 *     <p>núm. colegiado: 2415  -  Colegio: Madrid</p>
 *   </div>
 *
 * National corpus is ~35k veterinarios. Per-query cap is ~500 results
 * before the back-end truncates; iterating common surname prefixes per
 * provincia drains the bulk of each colegio without paging hacks. The
 * default prefix list is "a" through "z" (26 queries × 52 provincias =
 * 1352 requests at 1 req/s ≈ 22 min — fits inside the 40k cap easily).
 *
 * Off by default; toggle with `PROLIO_RUN_VUCOLVET=true`. Limit total
 * rows with `PROLIO_VUCOLVET_LIMIT` (default 40000). Restrict provincias
 * with `PROLIO_VUCOLVET_ONLY=28,8` (Madrid, Barcelona) for debugging.
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const BASE = "https://vucolvet.org";
const SEARCH_PATH = "/buscador-colegiados";
const REQUEST_DELAY_MS = 1000;
const DEFAULT_LIMIT = 40000;

// 3-char minimum on `search`; we use trigram prefixes that hit a broad
// share of Spanish surnames. The list is intentionally a small superset
// of the alphabet to bound request volume.
const SURNAME_PREFIXES = [
  "gar", "lop", "mar", "san", "rod", "fer", "gon", "gom", "her", "per",
  "alv", "vaz", "cas", "dia", "mor", "alo", "rom", "nav", "tor", "sua",
  "men", "ram", "cab", "esc", "iba", "gut", "ort", "del", "med", "are",
  "vil", "rey", "mol", "cal", "lor", "pas", "soto", "rui", "jim", "ben",
];

interface ProvinciaConfig {
  id: number;
  citySlug: string;
  cityName: string;
}

// `data-uk-prov` matches the form value. citySlug is the colegio capital.
const PROVINCIAS: ProvinciaConfig[] = [
  { id: 1,  citySlug: "vitoria-gasteiz",         cityName: "Álava" },
  { id: 2,  citySlug: "albacete",                cityName: "Albacete" },
  { id: 3,  citySlug: "alicante",                cityName: "Alicante" },
  { id: 4,  citySlug: "almeria",                 cityName: "Almería" },
  { id: 5,  citySlug: "avila",                   cityName: "Ávila" },
  { id: 6,  citySlug: "badajoz",                 cityName: "Badajoz" },
  { id: 7,  citySlug: "palma-de-mallorca",       cityName: "Baleares" },
  { id: 8,  citySlug: "barcelona",               cityName: "Barcelona" },
  { id: 9,  citySlug: "burgos",                  cityName: "Burgos" },
  { id: 10, citySlug: "caceres",                 cityName: "Cáceres" },
  { id: 11, citySlug: "cadiz",                   cityName: "Cádiz" },
  { id: 12, citySlug: "castellon-de-la-plana",   cityName: "Castellón" },
  { id: 13, citySlug: "ciudad-real",             cityName: "Ciudad Real" },
  { id: 14, citySlug: "cordoba",                 cityName: "Córdoba" },
  { id: 15, citySlug: "a-coruna",                cityName: "A Coruña" },
  { id: 16, citySlug: "cuenca",                  cityName: "Cuenca" },
  { id: 17, citySlug: "girona",                  cityName: "Gerona" },
  { id: 18, citySlug: "granada",                 cityName: "Granada" },
  { id: 19, citySlug: "guadalajara-es",          cityName: "Guadalajara" },
  { id: 20, citySlug: "san-sebastian",           cityName: "Guipúzcoa" },
  { id: 21, citySlug: "huelva",                  cityName: "Huelva" },
  { id: 22, citySlug: "huesca",                  cityName: "Huesca" },
  { id: 23, citySlug: "jaen",                    cityName: "Jaén" },
  { id: 24, citySlug: "leon-es",                 cityName: "León" },
  { id: 25, citySlug: "lleida",                  cityName: "Lleida" },
  { id: 26, citySlug: "logrono",                 cityName: "La Rioja" },
  { id: 27, citySlug: "lugo",                    cityName: "Lugo" },
  { id: 28, citySlug: "madrid",                  cityName: "Madrid" },
  { id: 29, citySlug: "malaga",                  cityName: "Málaga" },
  { id: 30, citySlug: "murcia",                  cityName: "Murcia" },
  { id: 31, citySlug: "pamplona",                cityName: "Navarra" },
  { id: 32, citySlug: "ourense",                 cityName: "Orense" },
  { id: 33, citySlug: "oviedo",                  cityName: "Asturias" },
  { id: 34, citySlug: "palencia",                cityName: "Palencia" },
  { id: 35, citySlug: "las-palmas",              cityName: "Las Palmas" },
  { id: 36, citySlug: "pontevedra",              cityName: "Pontevedra" },
  { id: 37, citySlug: "salamanca",               cityName: "Salamanca" },
  { id: 38, citySlug: "santa-cruz-de-tenerife",  cityName: "Tenerife" },
  { id: 39, citySlug: "santander",               cityName: "Cantabria" },
  { id: 40, citySlug: "segovia",                 cityName: "Segovia" },
  { id: 41, citySlug: "sevilla",                 cityName: "Sevilla" },
  { id: 42, citySlug: "soria",                   cityName: "Soria" },
  { id: 43, citySlug: "tarragona",               cityName: "Tarragona" },
  { id: 44, citySlug: "teruel",                  cityName: "Teruel" },
  { id: 45, citySlug: "toledo",                  cityName: "Toledo" },
  { id: 46, citySlug: "valencia",                cityName: "Valencia" },
  { id: 47, citySlug: "valladolid",              cityName: "Valladolid" },
  { id: 48, citySlug: "bilbao",                  cityName: "Vizcaya" },
  { id: 49, citySlug: "zamora",                  cityName: "Zamora" },
  { id: 50, citySlug: "zaragoza",                cityName: "Zaragoza" },
  { id: 51, citySlug: "ceuta",                   cityName: "Ceuta" },
  { id: 52, citySlug: "melilla",                 cityName: "Melilla" },
];

interface SessionState {
  token: string;
  cookieHeader: string;
}

async function fetchSession(): Promise<SessionState> {
  const response = await fetch(`${BASE}${SEARCH_PATH}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`vucolvet GET ${SEARCH_PATH} → ${response.status}`);
  }
  const html = await response.text();
  const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error("vucolvet: missing CSRF _token on initial GET");
  const setCookie = response.headers.get("set-cookie") || "";
  // Laravel issues XSRF-TOKEN + a session cookie; reuse all raw pairs.
  const cookieHeader = setCookie
    .split(/,(?=[^;]+=[^;]+)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
  return { token: tokenMatch[1], cookieHeader };
}

interface CardRow {
  id: string;
  prov: string;
  name: string;
  num: string;
  colegio: string;
}

const CARD_RE =
  /data-uk-id="(\d+)"\s+data-uk-prov="(\d+)"[\s\S]{0,500}?<h3[^>]*>\s*([^<]+?)\s*(?:<span[\s\S]*?<\/span>)?\s*<\/h3>[\s\S]{0,400}?n[úu]m\.\s*colegiado:\s*([^\s<]+)\s*-\s*Colegio:\s*([^<]+?)\s*</gi;

function parseCards(html: string): CardRow[] {
  const out: CardRow[] = [];
  CARD_RE.lastIndex = 0;
  for (const m of html.matchAll(CARD_RE)) {
    const [, id, prov, name, num, colegio] = m;
    if (!id || !name || !num) continue;
    out.push({
      id,
      prov: prov || "",
      name: name.trim(),
      num: num.trim(),
      colegio: colegio.trim(),
    });
  }
  return out;
}

async function searchProvinciaPrefix(
  session: SessionState,
  prov: ProvinciaConfig,
  prefix: string,
): Promise<CardRow[]> {
  const body = new URLSearchParams({
    _token: session.token,
    selectProvincias: String(prov.id),
    search: prefix,
    searchNumeroC: "",
    searchNombre: "",
  });
  const response = await fetch(`${BASE}${SEARCH_PATH}`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": session.cookieHeader,
      "Referer": `${BASE}${SEARCH_PATH}`,
      "Origin": BASE,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    throw new Error(
      `vucolvet POST prov=${prov.id} pref=${prefix} → ${response.status}`,
    );
  }
  const html = await response.text();
  return parseCards(html);
}

function selectProvincias(): ProvinciaConfig[] {
  const only = (process.env.PROLIO_VUCOLVET_ONLY || "").trim();
  if (!only) return PROVINCIAS;
  const wanted = new Set(
    only.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)),
  );
  return PROVINCIAS.filter((p) => wanted.has(p.id));
}

async function fetchAll(
  client: SupabaseClient,
  limit: number,
): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let session: SessionState;
  try {
    session = await fetchSession();
  } catch (e) {
    console.error(`[vucolvet] session bootstrap failed: ${(e as Error).message}`);
    return out;
  }
  const targets = selectProvincias();
  console.log(`[vucolvet] fan-out: ${targets.length}/${PROVINCIAS.length} provincias`);

  outer: for (const prov of targets) {
    let provHits = 0;
    // Auto-seed the colegio capital city. The hardcoded `citySlug` values
    // are not all present in the cities seed, so the old direct emit dropped
    // entire provincias at the sink. ensureCity returns a stable slug for the
    // capital; fall back to citySlug="" (NULL city) if seeding fails so rows
    // are never lost.
    let provCitySlug = "";
    const provCity = await ensureCity(client, {
      name: prov.cityName,
      state: prov.cityName,
      country: "ES",
    });
    if (provCity) provCitySlug = provCity.slug;
    for (const prefix of SURNAME_PREFIXES) {
      if (out.length >= limit) break outer;
      let rows: CardRow[] = [];
      try {
        rows = await searchProvinciaPrefix(session, prov, prefix);
      } catch (e) {
        console.error(`[vucolvet] ${prov.id} ${prefix}: ${(e as Error).message}`);
        // Refresh token on 419/expired CSRF.
        if ((e as Error).message.includes("419")) {
          try {
            session = await fetchSession();
          } catch (e2) {
            console.error(`[vucolvet] re-bootstrap failed: ${(e2 as Error).message}`);
          }
        }
        await delay(REQUEST_DELAY_MS);
        continue;
      }
      let added = 0;
      for (const r of rows) {
        const key = `${prov.id}:${r.num}:${r.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          normalise({
            source: "vucolvet",
            country: "ES",
            sourceId: `vucolvet:${prov.id}:${r.num}:${r.id}`,
            name: toTitleCase(r.name),
            categoryKey: "veterinario",
            citySlug: provCitySlug,
            licenseNumber: r.num,
            metadata: {
              country: "ES",
              authority: "OCV",
              provincia: prov.cityName,
              provincia_id: prov.id,
              colegio: r.colegio,
              verified_by_authority: true,
            },
          }),
        );
        added += 1;
        provHits += 1;
        if (out.length >= limit) break outer;
      }
      if (rows.length > 0) {
        console.log(
          `[vucolvet] prov=${prov.cityName} pref=${prefix} → ${rows.length} (+${added})`,
        );
      }
      await delay(REQUEST_DELAY_MS);
    }
    console.log(`[vucolvet] prov=${prov.cityName} total=${provHits}`);
  }
  return out;
}

export const vucolvetSource: ScraperSource = {
  name: "vucolvet",
  enabled() {
    return process.env.PROLIO_RUN_VUCOLVET === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runVucolvet(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!vucolvetSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const raw = Number(process.env.PROLIO_VUCOLVET_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const records = await fetchAll(client, limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const cs = getCityUpsertStats();
  console.log(
    `[vucolvet] cities_created=${cs.inserted} geocoded=${cs.geocoded}`,
  );
  const sink = getSink({ trustCitySlugs: true });
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[vucolvet] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
