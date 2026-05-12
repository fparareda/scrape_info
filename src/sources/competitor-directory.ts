/**
 * Competitor directory ingesters.
 *
 * Two adapters pull electricista pros from competitor WordPress
 * directories and upsert them into `public.professionals` + any
 * found emails into `public.professional_emails`.
 *
 *  - TumejorElectricistaAdapter: WP + Directorist. Discovers province
 *    pages from the sitemap, then paginates the AJAX-free search
 *    endpoint (`/instaladores/?in_loc=<Province>&pagenum=N`) to find
 *    per-pro detail permalinks `/instaladores/instaladorv/?id=<id>`.
 *    Detail pages have a clean `.atbd_contact_info` block with
 *    tel:/mailto: links and a Provincia row.
 *
 *  - ElectricistaYaAdapter: WP + Yoast + GenerateBlocks. City-province
 *    pages under `/<province>-<city>/` list N pros inline, one block
 *    per electricista (`<h2 class="jc-nom-elec"><span>NAME</span>`,
 *    `.jc-f-phone a[href^=tel:]`, `.jc-f-address-visible`).
 *
 * Both adapters:
 *  - Honour robots.txt (reuse the local parser here — we don't import
 *    the email-crawler module because we want per-adapter UA fallback
 *    on 403).
 *  - 1 concurrent request per host, 250ms throttle.
 *  - 8s fetch timeout.
 *  - Max pages per run capped at PROLIO_COMPETITOR_SCRAPER_LIMIT
 *    (default 500) across all adapters.
 *
 * No new deps — pure `fetch` + regex. Parsing tolerance beats XML/HTML
 * strictness here because the target markup is extremely stable
 * (Directorist theme, GenerateBlocks template).
 */

import { resolveMx } from "node:dns/promises";
import type { SupabaseClient } from "@supabase/supabase-js";

/* -------------------------------------------------------------------- */
/*                             Constants                                 */
/* -------------------------------------------------------------------- */

const BOT_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 8_000;
const THROTTLE_MS = 250;
const DEFAULT_MAX_PAGES = 500;

/* -------------------------------------------------------------------- */
/*                        Province → city slug                           */
/* -------------------------------------------------------------------- */

/**
 * Map competitor province URL segments (tumejorelectricista) and the
 * first URL segment of electricistaya (province or province alias) to
 * a city slug we actually seed in `cities`. These are the best guess
 * mappings — competitors index by province, we index by municipio.
 * Unmapped provinces → row is skipped by the sink's city FK check.
 */
const PROVINCE_TO_CITY_SLUG: Record<string, string> = {
  // TME + EYA: shared ES province slugs.
  "a-coruna": "a-coruna",
  "coruna-a": "a-coruna",
  "la-coruna": "la-coruna",
  alacant: "alicante",
  alicante: "alicante",
  alava: "vitoria-gasteiz",
  araba: "vitoria-gasteiz",
  albacete: "albacete",
  almeria: "almeria",
  asturias: "oviedo",
  avila: "avila",
  badajoz: "badajoz",
  balears: "palma-de-mallorca",
  "balears-illes": "palma-de-mallorca",
  mallorca: "palma-de-mallorca",
  barcelona: "barcelona",
  bizkaia: "bilbao",
  vizcaya: "bilbao",
  burgos: "burgos",
  caceres: "caceres",
  cadiz: "cadiz",
  cantabria: "santander",
  castello: "castellon",
  castellon: "castellon",
  ceuta: "ceuta",
  "ciudad-real": "ciudad-real",
  cordoba: "cordoba",
  cuenca: "cuenca",
  girona: "gerona",
  gerona: "gerona",
  granada: "granada",
  guadalajara: "guadalajara",
  guipuzkoa: "san-sebastian",
  gipuzkoa: "san-sebastian",
  huelva: "huelva",
  huesca: "huesca",
  jaen: "jaen",
  "la-rioja": "logrono",
  rioja: "logrono",
  "las-palmas": "las-palmas-de-gran-canaria",
  leon: "leon",
  lleida: "lleida",
  lerida: "lerida",
  lugo: "lugo",
  madrid: "madrid",
  malaga: "malaga",
  melilla: "melilla",
  murcia: "murcia",
  nafarroa: "pamplona",
  navarra: "pamplona",
  ourense: "orense",
  orense: "orense",
  palencia: "palencia",
  pontevedra: "pontevedra",
  salamanca: "salamanca",
  "santa-cruz-de-tenerife": "santa-cruz-de-tenerife",
  segovia: "segovia",
  sevilla: "sevilla",
  soria: "soria",
  tarragona: "tarragona",
  teruel: "teruel",
  toledo: "toledo",
  valencia: "valencia",
  valladolid: "valladolid",
  zamora: "zamora",
  zaragoza: "zaragoza",
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

/* -------------------------------------------------------------------- */
/*                       Email junk filter + MX                          */
/* -------------------------------------------------------------------- */

/**
 * Mirrors `isJunkEmail` from email-crawler.ts. Duplicated here to keep
 * this module self-contained — the crawler doesn't export it.
 */
const JUNK_LOCAL =
  /^(no-?reply|postmaster|webmaster|hostmaster|mailer-daemon|donotreply|abuse|privacy|dpo|gdpr|security)@/i;
const JUNK_DOMAIN =
  /@(sentry\.io|gravatar\.com|google-analytics\.com|googleads\.com|googleads\.g\.doubleclick\.net|example\.com|example\.org|example\.net|domain\.com|test\.com|wordpress\.org|wordpress\.com|yourdomain\.com|email\.com|mail\.com|your-?domain\.com|myemail\.com)$/i;
const IMAGE_TLD =
  /\.(png|jpe?g|gif|svg|webp|ico|bmp|css|js|woff2?|ttf|otf|eot)$/i;

function isJunkEmail(email: string): boolean {
  if (email.length > 80) return true;
  if (JUNK_LOCAL.test(email)) return true;
  if (JUNK_DOMAIN.test(email)) return true;
  if (IMAGE_TLD.test(email)) return true;
  const atIdx = email.indexOf("@");
  if (atIdx < 1) return true;
  const domain = email.slice(atIdx + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return true;
  return false;
}

function makeMxCache(): (domain: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (domain: string) => {
    const d = domain.toLowerCase();
    const cached = cache.get(d);
    if (cached) return cached;
    const p = (async () => {
      try {
        const records = await resolveMx(d);
        return records.length > 0;
      } catch {
        return false;
      }
    })();
    cache.set(d, p);
    return p;
  };
}

/* -------------------------------------------------------------------- */
/*                        Per-host queued fetch                          */
/* -------------------------------------------------------------------- */

interface HostState {
  ua: string;
  chain: Promise<unknown>;
  lastAt: number;
}

interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
}

function createHostClient(): (url: string) => Promise<FetchResult> {
  const hosts = new Map<string, HostState>();

  function getHost(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  }

  async function rawFetch(url: string, ua: string): Promise<FetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
          "Accept-Language": "es-ES,es;q=0.9",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      const text = res.ok ? await res.text() : "";
      return { ok: res.ok, status: res.status, text };
    } catch {
      return { ok: false, status: 0, text: "" };
    } finally {
      clearTimeout(timer);
    }
  }

  return async (url: string): Promise<FetchResult> => {
    const host = getHost(url);
    if (!host) return { ok: false, status: 0, text: "" };
    const state: HostState =
      hosts.get(host) ??
      ({ ua: BOT_UA, chain: Promise.resolve(), lastAt: 0 } as HostState);
    hosts.set(host, state);

    const task = async (): Promise<FetchResult> => {
      const wait = Math.max(0, state.lastAt + THROTTLE_MS - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      state.lastAt = Date.now();
      let res = await rawFetch(url, state.ua);
      // UA fallback: if a 403 happens with our bot UA, switch this host
      // to a browser UA for the rest of the run.
      if (res.status === 403 && state.ua === BOT_UA) {
        state.ua = BROWSER_UA;
        state.lastAt = Date.now();
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
        res = await rawFetch(url, state.ua);
      }
      return res;
    };

    const next = state.chain.then(task, task) as Promise<FetchResult>;
    state.chain = next.catch(() => undefined);
    return next;
  };
}

/* -------------------------------------------------------------------- */
/*                            robots.txt                                 */
/* -------------------------------------------------------------------- */

type RobotsCheck = (path: string) => boolean;

async function loadRobots(
  origin: string,
  hostFetch: (url: string) => Promise<FetchResult>,
): Promise<RobotsCheck> {
  const res = await hostFetch(`${origin}/robots.txt`);
  if (!res.ok || !res.text) return () => true;
  const disallow: string[] = [];
  let inBlock = false;
  for (const rawLine of res.text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw?.toLowerCase().trim();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      const ua = value.toLowerCase();
      inBlock = ua === "*" || ua.includes("prolio");
    } else if (inBlock && key === "disallow" && value) {
      if (value === "/") return () => false;
      disallow.push(value);
    }
  }
  return (path: string) => !disallow.some((d) => path.startsWith(d));
}

/* -------------------------------------------------------------------- */
/*                            Text helpers                               */
/* -------------------------------------------------------------------- */

function decodeEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function normalisePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return undefined;
  if (digits.startsWith("+")) return digits;
  // Spanish mobile/landline: 9 digits starting with 6/7/8/9.
  if (digits.length === 9 && /^[6789]/.test(digits)) return `+34${digits}`;
  // Some sites include 34 prefix without +.
  if (digits.length === 11 && digits.startsWith("34")) return `+${digits}`;
  return digits;
}

/* -------------------------------------------------------------------- */
/*                              Types                                    */
/* -------------------------------------------------------------------- */

type AdapterName = "tumejorelectricista" | "electricistaya";

interface CompetitorPro {
  source: AdapterName;
  sourceId: string;
  name: string;
  citySlug: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  sourceUrl: string;
}

export interface CompetitorDirectoryResult {
  fetched: number;
  upserted: number;
  withEmail: number;
  withPhone: number;
  failures: number;
}

interface RunOpts {
  adapters?: AdapterName[];
  limit?: number;
}

interface RunCtx {
  hostFetch: (url: string) => Promise<FetchResult>;
  robots: Map<string, RobotsCheck>;
  budget: { remaining: number };
  hasMx: (domain: string) => Promise<boolean>;
}

/* -------------------------------------------------------------------- */
/*                  Robots-gated fetch (shared per run)                  */
/* -------------------------------------------------------------------- */

async function ctxFetch(
  ctx: RunCtx,
  url: string,
): Promise<FetchResult | null> {
  if (ctx.budget.remaining <= 0) return null;
  let origin: string;
  let pathname: string;
  try {
    const u = new URL(url);
    origin = `${u.protocol}//${u.host}`;
    pathname = u.pathname;
  } catch {
    return null;
  }
  let check = ctx.robots.get(origin);
  if (!check) {
    check = await loadRobots(origin, ctx.hostFetch);
    ctx.robots.set(origin, check);
  }
  if (!check(pathname)) return null;
  ctx.budget.remaining -= 1;
  return ctx.hostFetch(url);
}

/* -------------------------------------------------------------------- */
/*                TumejorElectricistaAdapter implementation              */
/* -------------------------------------------------------------------- */

async function listTmeProvinces(ctx: RunCtx): Promise<string[]> {
  const res = await ctxFetch(
    ctx,
    "https://tumejorelectricista.es/page-sitemap.xml",
  );
  if (!res || !res.ok) return [];
  const provinces = new Set<string>();
  const re = /<loc>https:\/\/tumejorelectricista\.es\/localidad\/([a-z0-9-]+)\/<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(res.text)) !== null) {
    if (m[1]) provinces.add(m[1]);
  }
  return [...provinces];
}

const TME_PROVINCE_LABEL: Record<string, string> = {
  "a-coruna": "Coruña, A",
  alacant: "Alicante",
  alava: "Álava",
  albacete: "Albacete",
  almeria: "Almería",
  asturias: "Asturias",
  avila: "Ávila",
  badajoz: "Badajoz",
  balears: "Balears, Illes",
  barcelona: "Barcelona",
  bizkaia: "Bizkaia",
  burgos: "Burgos",
  caceres: "Cáceres",
  cadiz: "Cádiz",
  cantabria: "Cantabria",
  castello: "Castellón",
  ceuta: "Ceuta",
  "ciudad-real": "Ciudad Real",
  cordoba: "Córdoba",
  cuenca: "Cuenca",
  girona: "Girona",
  granada: "Granada",
  guadalajara: "Guadalajara",
  guipuzkoa: "Guipuzkoa",
  huelva: "Huelva",
  huesca: "Huesca",
  jaen: "Jaén",
  "la-rioja": "Rioja, La",
  "las-palmas": "Palmas, Las",
  leon: "León",
  lleida: "Lleida",
  lugo: "Lugo",
  madrid: "Madrid",
  malaga: "Málaga",
  melilla: "Melilla",
  murcia: "Murcia",
  nafarroa: "Navarra",
  ourense: "Ourense",
  palencia: "Palencia",
  pontevedra: "Pontevedra",
  salamanca: "Salamanca",
  "santa-cruz-de-tenerife": "Santa Cruz de Tenerife",
  segovia: "Segovia",
  sevilla: "Sevilla",
  soria: "Soria",
  tarragona: "Tarragona",
  teruel: "Teruel",
  toledo: "Toledo",
  valencia: "Valencia",
  valladolid: "Valladolid",
  zamora: "Zamora",
  zaragoza: "Zaragoza",
};

async function listTmeDetailUrls(
  ctx: RunCtx,
  provinceLabel: string,
): Promise<string[]> {
  const urls = new Set<string>();
  let page = 1;
  const maxPages = 400; // hard ceiling per province
  while (page <= maxPages && ctx.budget.remaining > 0) {
    const url = `https://tumejorelectricista.es/instaladores/?in_loc=${encodeURIComponent(
      provinceLabel,
    )}&pagenum=${page}`;
    const res = await ctxFetch(ctx, url);
    if (!res || !res.ok) break;
    const before = urls.size;
    const re =
      /href="(https:\/\/tumejorelectricista\.es\/instaladores\/instaladorv\/\?id=\d+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(res.text)) !== null) {
      urls.add(m[1]);
    }
    if (urls.size === before) break; // pagination exhausted
    // Cap loop via pagenum=N links visible on page.
    const nextRe = /pagenum=(\d+)/g;
    let maxSeen = page;
    let nm: RegExpExecArray | null;
    while ((nm = nextRe.exec(res.text)) !== null) {
      const n = Number(nm[1]);
      if (Number.isFinite(n) && n > maxSeen) maxSeen = n;
    }
    if (page >= maxSeen) break;
    page += 1;
  }
  return [...urls];
}

function parseTmeDetail(
  html: string,
  sourceUrl: string,
): CompetitorPro | null {
  const idMatch = sourceUrl.match(/[?&]id=(\d+)/);
  if (!idMatch) return null;
  const sourceId = idMatch[1];

  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const name = h1Match ? stripTags(h1Match[1]) : "";
  if (!name) return null;

  // Province block looks like:
  //   <div class="atbd_info">MADRID - Madrid</div>
  const provMatch = html.match(
    /fa-map-marker[\s\S]{0,200}?<div class="atbd_info">([^<]+)<\/div>/i,
  );
  const provRaw = provMatch ? stripTags(provMatch[1]) : "";
  // "MADRID - Madrid" → take first chunk, lowercase, slugify.
  const provinceToken = provRaw.split("-")[0]?.trim() ?? "";
  const provinceSlug = slugify(provinceToken);
  const citySlug = PROVINCE_TO_CITY_SLUG[provinceSlug];
  if (!citySlug) return null;

  const phoneMatch = html.match(/href="tel:([^"]+)"/i);
  const phone = phoneMatch ? normalisePhone(phoneMatch[1]) : undefined;

  const mailMatch = html.match(/href="mailto:([^"?]+)/i);
  const rawEmail = mailMatch
    ? decodeURIComponent(mailMatch[1]).trim().toLowerCase()
    : undefined;
  const email = rawEmail && !isJunkEmail(rawEmail) ? rawEmail : undefined;

  // Directorist sometimes exposes an external website link with class
  // "eventweb" — cheaply grab the first non-competitor external http(s).
  let website: string | undefined;
  const webRe =
    /<a[^>]+href="(https?:\/\/(?!(?:www\.)?tumejorelectricista\.es|wa\.me|api\.whatsapp|maps\.google|www\.google|facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com)[^"]+)"[^>]*class="[^"]*eventweb/i;
  const webMatch = html.match(webRe);
  if (webMatch) website = webMatch[1];

  // Address row (optional). Directorist uses "Dirección" label.
  let address: string | undefined;
  const addrMatch = html.match(
    /fa-map[^"]*"[^>]*>\s*Direcci[oó]n[\s\S]{0,40}?<div class="atbd_info"[^>]*>([^<]+)/i,
  );
  if (addrMatch) address = stripTags(addrMatch[1]);

  return {
    source: "tumejorelectricista",
    sourceId,
    name,
    citySlug,
    phone,
    email,
    website,
    address,
    sourceUrl,
  };
}

async function runTme(ctx: RunCtx): Promise<CompetitorPro[]> {
  const out: CompetitorPro[] = [];
  const provinces = await listTmeProvinces(ctx);
  console.log(`[competitor] tme: ${provinces.length} provinces in sitemap`);
  for (const provSlug of provinces) {
    if (ctx.budget.remaining <= 0) break;
    const label = TME_PROVINCE_LABEL[provSlug];
    if (!label) continue;
    const detailUrls = await listTmeDetailUrls(ctx, label);
    for (const url of detailUrls) {
      if (ctx.budget.remaining <= 0) break;
      const res = await ctxFetch(ctx, url);
      if (!res || !res.ok) continue;
      const pro = parseTmeDetail(res.text, url);
      if (pro) out.push(pro);
    }
  }
  return out;
}

/* -------------------------------------------------------------------- */
/*                 ElectricistaYaAdapter implementation                  */
/* -------------------------------------------------------------------- */

async function listEyaCityPages(ctx: RunCtx): Promise<string[]> {
  // Iterate post-sitemap.xml, post-sitemap2.xml, …
  const urls = new Set<string>();
  for (const sitemapUrl of [
    "https://electricistaya.es/post-sitemap.xml",
    "https://electricistaya.es/post-sitemap2.xml",
  ]) {
    const res = await ctxFetch(ctx, sitemapUrl);
    if (!res || !res.ok) continue;
    const re = /<loc>(https:\/\/electricistaya\.es\/[a-z0-9-]+\/)<\/loc>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(res.text)) !== null) {
      // Only keep `<province>-<city>` style slugs (have a dash).
      const u = m[1];
      try {
        const pathname = new URL(u).pathname.replace(/^\/|\/$/g, "");
        if (!pathname.includes("-")) continue;
        urls.add(u);
      } catch {
        /* ignore */
      }
    }
  }
  return [...urls];
}

function parseEyaCityPage(
  html: string,
  sourceUrl: string,
): CompetitorPro[] {
  const out: CompetitorPro[] = [];
  // province slug = first URL segment before first `-`.
  let pathSlug = "";
  try {
    pathSlug = new URL(sourceUrl).pathname.replace(/^\/|\/$/g, "");
  } catch {
    return out;
  }
  // Take everything up to and including city (we try the full slug
  // first, then fall back to the first token as province).
  const tokens = pathSlug.split("-");
  let citySlug: string | undefined;
  // Try longest matches first against PROVINCE_TO_CITY_SLUG.
  for (let i = tokens.length; i >= 1; i -= 1) {
    const candidate = tokens.slice(0, i).join("-");
    if (PROVINCE_TO_CITY_SLUG[candidate]) {
      citySlug = PROVINCE_TO_CITY_SLUG[candidate];
      break;
    }
  }
  if (!citySlug) return out;

  // Each listing is framed by an <h2 class="jc-nom-elec ..."> with
  // the name in the first nested <span>.
  const blockRe =
    /<h2[^>]*class="[^"]*jc-nom-elec[^"]*"[^>]*>[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?(?=<h2[^>]*class="[^"]*jc-nom-elec|<\/article|<footer)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const name = stripTags(m[1]);
    if (!name) continue;
    const block = m[0];
    const phoneMatch = block.match(/href="tel:([^"]+)"/i);
    const phone = phoneMatch
      ? normalisePhone(decodeURIComponent(phoneMatch[1]))
      : undefined;
    let address: string | undefined;
    const addrMatch = block.match(
      /<span class="jc-f-address-visible"[^>]*>([^<]+)<\/span>/i,
    );
    if (addrMatch) address = stripTags(addrMatch[1]);
    // Stable source_id: slug(name) + city + phone last 6 digits (if any)
    // gives us a deterministic dedupable key even without a numeric id.
    const phoneTail = phone ? phone.slice(-6) : "x";
    const sourceId = `${slugify(name)}__${citySlug}__${phoneTail}`.slice(0, 100);
    out.push({
      source: "electricistaya",
      sourceId,
      name,
      citySlug,
      phone,
      address,
      sourceUrl,
    });
  }
  return out;
}

async function runEya(ctx: RunCtx): Promise<CompetitorPro[]> {
  const out: CompetitorPro[] = [];
  const pages = await listEyaCityPages(ctx);
  console.log(`[competitor] eya: ${pages.length} city pages in sitemaps`);
  for (const url of pages) {
    if (ctx.budget.remaining <= 0) break;
    const res = await ctxFetch(ctx, url);
    if (!res || !res.ok) continue;
    out.push(...parseEyaCityPage(res.text, url));
  }
  return out;
}

/* -------------------------------------------------------------------- */
/*                              Persistence                              */
/* -------------------------------------------------------------------- */

function buildSlug(name: string, citySlug: string, sourceId: string): string {
  const base = slugify(`${name}-${citySlug}`);
  // Suffix with a short hash of the source_id so two competitor rows
  // with identical name+city don't collide.
  const tail = slugify(sourceId).slice(-6) || "x";
  const slug = `${base}-${tail}`;
  return slug.length > 80 ? slug.slice(0, 80) : slug;
}

async function upsertPros(
  client: SupabaseClient,
  pros: CompetitorPro[],
  hasMx: (domain: string) => Promise<boolean>,
): Promise<{ upserted: number; withEmail: number; withPhone: number }> {
  if (pros.length === 0) return { upserted: 0, withEmail: 0, withPhone: 0 };

  // 1. Upsert into professionals.
  const payloads = pros.map((p) => ({
    slug: buildSlug(p.name, p.citySlug, p.sourceId),
    name: p.name,
    category_key: "electricidad",
    city_slug: p.citySlug,
    headline: "",
    description: "",
    email: p.email ?? null,
    phone: p.phone ?? null,
    website: p.website ?? null,
    address: p.address ?? null,
    source: p.source,
    source_id: p.sourceId,
    is_published: true,
    metadata: { source_url: p.sourceUrl },
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (client.from("professionals") as any).upsert(
    payloads,
    { onConflict: "source,source_id", ignoreDuplicates: false },
  );
  if (error) {
    // Slug collision fallback: row-by-row with numeric suffix.
    if (error.code === "23505") {
      let ok = 0;
      for (const payload of payloads) {
        for (let suffix = 1; suffix < 20; suffix += 1) {
          const slug =
            suffix === 1 ? payload.slug : `${payload.slug}-${suffix}`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: e2 } = await (client.from("professionals") as any)
            .upsert({ ...payload, slug }, {
              onConflict: "source,source_id",
              ignoreDuplicates: false,
            });
          if (!e2) {
            ok += 1;
            break;
          }
          if (e2.code !== "23505") {
            console.log("[competitor] upsert row error", e2.message);
            break;
          }
        }
      }
      const withEmail = pros.filter((p) => p.email).length;
      const withPhone = pros.filter((p) => p.phone).length;
      console.log(
        `[competitor] upserted (row-fallback): ${ok}/${pros.length}`,
      );
      return { upserted: ok, withEmail, withPhone };
    }
    console.log("[competitor] upsert batch error:", error.message);
    return { upserted: 0, withEmail: 0, withPhone: 0 };
  }

  // 2. Upsert emails into professional_emails (MX-verified).
  const withEmails = pros.filter((p) => p.email);
  if (withEmails.length > 0) {
    // Fetch back professional IDs via (source, source_id).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: idRows } = await (client.from("professionals") as any)
      .select("id, source, source_id")
      .in(
        "source_id",
        withEmails.map((p) => p.sourceId),
      )
      .in("source", Array.from(new Set(withEmails.map((p) => p.source))));
    const idMap = new Map<string, string>();
    for (const row of (idRows ?? []) as Array<{
      id: string;
      source: string;
      source_id: string;
    }>) {
      idMap.set(`${row.source}::${row.source_id}`, row.id);
    }

    const emailRows: Array<Record<string, unknown>> = [];
    for (const p of withEmails) {
      if (!p.email) continue;
      const id = idMap.get(`${p.source}::${p.sourceId}`);
      if (!id) continue;
      const domain = p.email.slice(p.email.indexOf("@") + 1);
      // MX gate — competitor emails are curated but we still want deliverable.
      if (!(await hasMx(domain))) continue;
      emailRows.push({
        professional_id: id,
        email: p.email,
        source: "manual",
        confidence: 0.9,
        discovered_at_url: p.sourceUrl,
        verified_at: new Date().toISOString(),
      });
    }
    if (emailRows.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: eErr } = await (client.from("professional_emails") as any)
        .upsert(emailRows, {
          onConflict: "professional_id,email",
          ignoreDuplicates: false,
        });
      if (eErr) {
        console.log("[competitor] email upsert error:", eErr.message);
      }
    }
  }

  const withEmail = pros.filter((p) => p.email).length;
  const withPhone = pros.filter((p) => p.phone).length;
  return { upserted: pros.length, withEmail, withPhone };
}

/* -------------------------------------------------------------------- */
/*                              Public API                               */
/* -------------------------------------------------------------------- */

export function competitorDirectoryEnabled(): boolean {
  return process.env.PROLIO_RUN_COMPETITOR_SCRAPER === "true";
}

export async function runCompetitorDirectoryScraper(
  client: SupabaseClient,
  opts: RunOpts = {},
): Promise<CompetitorDirectoryResult> {
  const adapters: AdapterName[] = opts.adapters ?? [
    "tumejorelectricista",
    "electricistaya",
  ];
  const limit = opts.limit ?? DEFAULT_MAX_PAGES;

  const ctx: RunCtx = {
    hostFetch: createHostClient(),
    robots: new Map(),
    budget: { remaining: limit },
    hasMx: makeMxCache(),
  };

  let fetched = 0;
  let failures = 0;
  const all: CompetitorPro[] = [];

  for (const adapter of adapters) {
    try {
      const rows =
        adapter === "tumejorelectricista"
          ? await runTme(ctx)
          : await runEya(ctx);
      console.log(
        `[competitor] ${adapter}: harvested=${rows.length} budget-left=${ctx.budget.remaining}`,
      );
      all.push(...rows);
      fetched += rows.length;
    } catch (err) {
      failures += 1;
      console.log(
        `[competitor] ${adapter} failed:`,
        (err as Error).message,
      );
    }
  }

  // Dedup within run (source, source_id).
  const seen = new Set<string>();
  const unique = all.filter((p) => {
    const k = `${p.source}::${p.sourceId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Chunked upsert — keep each batch under the PostgREST URL limit.
  let upserted = 0;
  let withEmail = 0;
  let withPhone = 0;
  const BATCH = 200;
  for (let i = 0; i < unique.length; i += BATCH) {
    try {
      const res = await upsertPros(
        client,
        unique.slice(i, i + BATCH),
        ctx.hasMx,
      );
      upserted += res.upserted;
      withEmail += res.withEmail;
      withPhone += res.withPhone;
    } catch (err) {
      failures += 1;
      console.log("[competitor] upsert chunk error:", (err as Error).message);
    }
  }

  console.log(
    `[competitor] done — fetched=${fetched} upserted=${upserted} withEmail=${withEmail} withPhone=${withPhone} failures=${failures}`,
  );

  return { fetched, upserted, withEmail, withPhone, failures };
}
