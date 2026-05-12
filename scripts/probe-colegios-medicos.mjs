/**
 * One-shot pre-flight probe for all 52 provincial colegios oficiales de
 * médicos (OMC). Classifies each site by reachability pattern.
 *
 * Usage:
 *   node apps/scraper/scripts/probe-colegios-medicos.mjs > /tmp/probe.txt
 *
 * Verdicts:
 *   IMPLEMENTED       — JSON or clean HTML buscador accessible unauth
 *   SKIP_CAPTCHA      — reCAPTCHA / cloudflare / similar challenge
 *   SKIP_404          — buscador paths return 404
 *   SKIP_TIMEOUT      — DNS / TCP / TLS / hang
 *   SKIP_JS_ONLY      — page 200 but no server-rendered list; needs JS
 *   SKIP_NO_BUSCADOR  — homepage 200 but no "buscador de colegiados"
 *                       link found within 1 hop
 *
 * Politeness: serial, 700ms between hosts, 10s per request timeout.
 */

import { setTimeout as sleep } from "node:timers/promises";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 6_000;
const THROTTLE_MS = 400;
const CONCURRENCY = 8;

/**
 * Canonical list from https://www.cgcom.es/colegios-mapa (52 entries =
 * 50 provinces + Ceuta + Melilla). Codes are lowercase-ASCII province
 * slugs. capitalSlug is the provincial capital's slug in our ES cities
 * seed (checked against apps/web+scraper data in follow-up).
 */
const COLEGIOS = [
  { code: "alava",       name: "Álava",          url: "https://icomav.es",              capital: "vitoria" },
  { code: "albacete",    name: "Albacete",       url: "https://www.comalbacete.net",    capital: "albacete" },
  { code: "alicante",    name: "Alicante",       url: "https://coma.es",                capital: "alicante" },
  { code: "almeria",     name: "Almería",        url: "https://www.comalmeria.es",      capital: "almeria" },
  { code: "asturias",    name: "Asturias",       url: "https://icomast.es",             capital: "oviedo" },
  { code: "avila",       name: "Ávila",          url: "https://www.comav.es",           capital: "avila" },
  { code: "badajoz",     name: "Badajoz",        url: "https://www.combadajoz.com",     capital: "badajoz" },
  { code: "baleares",    name: "Baleares",       url: "https://www.comib.com",          capital: "palma-de-mallorca" },
  { code: "barcelona",   name: "Barcelona",      url: "https://www.comb.cat",           capital: "barcelona" },
  { code: "bizkaia",     name: "Bizkaia",        url: "https://www.cmb.eus",            capital: "bilbao" },
  { code: "burgos",      name: "Burgos",         url: "https://www.combu.es",           capital: "burgos" },
  { code: "caceres",     name: "Cáceres",        url: "https://comeca.org",             capital: "caceres" },
  { code: "cadiz",       name: "Cádiz",          url: "https://comcadiz.es",            capital: "cadiz" },
  { code: "cantabria",   name: "Cantabria",      url: "https://www.comcantabria.es",    capital: "santander" },
  { code: "castellon",   name: "Castellón",      url: "https://comcas.es",              capital: "castellon-de-la-plana" },
  { code: "ceuta",       name: "Ceuta",          url: "https://comceuta.es",            capital: "ceuta" },
  { code: "ciudad-real", name: "Ciudad Real",    url: "https://comciudadreal.es",       capital: "ciudad-real" },
  { code: "coruna",      name: "A Coruña",       url: "https://www.comc.es",            capital: "a-coruna" },
  { code: "cordoba",     name: "Córdoba",        url: "https://www.comcordoba.com",     capital: "cordoba" },
  { code: "cuenca",      name: "Cuenca",         url: "https://comcuenca.org",          capital: "cuenca" },
  { code: "gipuzkoa",    name: "Gipuzkoa",       url: "https://www.comgi.eus",          capital: "san-sebastian" },
  { code: "girona",      name: "Girona",         url: "https://www.comg.cat",           capital: "girona" },
  { code: "granada",     name: "Granada",        url: "https://www.comgranada.com",     capital: "granada" },
  { code: "guadalajara", name: "Guadalajara",    url: "http://www.comguada.es",         capital: "guadalajara" },
  { code: "huelva",      name: "Huelva",         url: "http://www.comhuelva.com",       capital: "huelva" },
  { code: "huesca",      name: "Huesca",         url: "https://comhuesca.es",           capital: "huesca" },
  { code: "jaen",        name: "Jaén",           url: "https://www.colmedjaen.es",      capital: "jaen" },
  { code: "leon",        name: "León",           url: "https://www.comleon.es",         capital: "leon" },
  { code: "lleida",      name: "Lleida",         url: "https://www.comll.cat",          capital: "lleida" },
  { code: "lugo",        name: "Lugo",           url: "https://comlugo.org",            capital: "lugo" },
  { code: "madrid",      name: "Madrid",         url: "https://www.icomem.es",          capital: "madrid" },
  { code: "malaga",      name: "Málaga",         url: "https://commalaga.com",          capital: "malaga" },
  { code: "melilla",     name: "Melilla",        url: "https://commelilla.es",          capital: "melilla" },
  { code: "murcia",      name: "Murcia",         url: "https://www.commurcia.es",       capital: "murcia" },
  { code: "navarra",     name: "Navarra",        url: "https://colegiodemedicos.es",    capital: "pamplona" },
  { code: "ourense",     name: "Ourense",        url: "https://www.cmourense.org",      capital: "ourense" },
  { code: "palencia",    name: "Palencia",       url: "http://www.compalencia.org",     capital: "palencia" },
  { code: "las-palmas",  name: "Las Palmas",     url: "https://www.medicoslaspalmas.es",capital: "las-palmas-de-gran-canaria" },
  { code: "pontevedra",  name: "Pontevedra",     url: "https://www.cmpont.es",          capital: "pontevedra" },
  { code: "la-rioja",    name: "La Rioja",       url: "https://medicosrioja.com",       capital: "logrono" },
  { code: "salamanca",   name: "Salamanca",      url: "https://comsalamanca.es",        capital: "salamanca" },
  { code: "segovia",     name: "Segovia",        url: "https://www.comsegovia.com",     capital: "segovia" },
  { code: "sevilla",     name: "Sevilla",        url: "https://www.comsevilla.es",      capital: "sevilla" },
  { code: "soria",       name: "Soria",          url: "https://www.comsor.es",          capital: "soria" },
  { code: "tenerife",    name: "S.C. Tenerife",  url: "https://medicostenerife.es",     capital: "santa-cruz-de-tenerife" },
  { code: "tarragona",   name: "Tarragona",      url: "https://comt.cat",               capital: "tarragona" },
  { code: "teruel",      name: "Teruel",         url: "http://www.comteruel.es",        capital: "teruel" },
  { code: "toledo",      name: "Toledo",         url: "http://www.comtoledo.org",       capital: "toledo" },
  { code: "valencia",    name: "Valencia",       url: "https://www.comv.es",            capital: "valencia" },
  { code: "valladolid",  name: "Valladolid",     url: "https://medicosva.com",          capital: "valladolid" },
  { code: "zamora",      name: "Zamora",         url: "https://www.colmeza.com",        capital: "zamora" },
  { code: "zaragoza",    name: "Zaragoza",       url: "https://www.comz.org",           capital: "zaragoza" },
];

// Candidate buscador path suffixes to try on each homepage.
const BUSCADOR_PATHS = [
  "/buscador-colegiados",
  "/buscador-de-colegiados",
  "/buscador",
  "/buscar-colegiados",
  "/ventanilla-unica",
  "/ventanilla-publica",
  "/consulta-publica-colegiados",
  "/colegiados",
  "/ca/cerca-de-col-legiats",
];

async function timedFetch(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text().catch(() => "");
    return { ok: true, status: res.status, url: res.url, body: text };
  } catch (err) {
    return { ok: false, status: 0, url, body: "", error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

function classifyHome(body) {
  const lower = body.toLowerCase();
  const captcha =
    lower.includes("g-recaptcha") ||
    lower.includes("grecaptcha") ||
    lower.includes("recaptcha/api") ||
    lower.includes("cf-turnstile") ||
    lower.includes("cleantalk") ||
    lower.includes("hcaptcha");
  const buscadorHints = [
    "buscador de colegiados",
    "buscador colegiados",
    "buscar colegiado",
    "cerca de col",
    "ventanilla única",
    "ventanilla unica",
    "consulta pública",
    "consulta publica",
    "registro de colegiados",
  ];
  const hasBuscadorLink = buscadorHints.some((h) => lower.includes(h));
  return { captcha, hasBuscadorLink };
}

function extractBuscadorHref(body, baseUrl) {
  // Look for anchors whose text or href mentions buscador/colegiados.
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{0,120})<\/a>/gi;
  const matches = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    const href = m[1];
    const text = m[2].toLowerCase();
    if (
      /buscador|busqueda|búsqueda|colegiado|cercador|ventanilla|consulta/.test(
        text,
      ) ||
      /buscador|busqueda|cercador|ventanilla|colegiados|consulta/i.test(href)
    ) {
      try {
        const abs = new URL(href, baseUrl).toString();
        matches.push({ href: abs, text: text.trim() });
      } catch {}
    }
  }
  return matches.slice(0, 5);
}

function classifyBuscadorPage(body) {
  const lower = body.toLowerCase();
  const captcha =
    lower.includes("g-recaptcha") ||
    lower.includes("grecaptcha") ||
    lower.includes("recaptcha/api") ||
    lower.includes("cf-turnstile") ||
    lower.includes("cleantalk") ||
    lower.includes("hcaptcha");
  // JSON-ish or row-ish signals:
  const jsonForm =
    /action=["'][^"']*(procesar|ajax|api|buscar|query|search)[^"']*["']/i.test(
      body,
    );
  const resultTable =
    /<table[\s\S]{0,2000}colegiad/i.test(body) ||
    /class=["'][^"']*(result|listado|colegiado)[^"']*["']/i.test(body);
  return { captcha, jsonForm, resultTable, empty: body.trim().length < 200 };
}

async function probe(col) {
  const report = { code: col.code, name: col.name, url: col.url };
  // 1) homepage
  const home = await timedFetch(col.url);
  await sleep(THROTTLE_MS);
  if (!home.ok) {
    report.verdict = "SKIP_TIMEOUT";
    report.note = home.error?.slice(0, 100);
    return report;
  }
  if (home.status >= 500) {
    report.verdict = "SKIP_TIMEOUT";
    report.note = `home ${home.status}`;
    return report;
  }
  if (home.status === 403 || home.status === 401) {
    report.verdict = "SKIP_CAPTCHA";
    report.note = `home ${home.status}`;
    return report;
  }

  const homeInfo = classifyHome(home.body);
  const candidates = new Set();
  // Prefer links discovered on the homepage (cheap, specific).
  for (const link of extractBuscadorHref(home.body, home.url)) {
    candidates.add(link.href);
  }
  // Fall back to a handful of common paths only if none found.
  if (candidates.size === 0) {
    for (const p of ["/buscador-colegiados", "/buscador", "/colegiados"]) {
      candidates.add(new URL(p, home.url).toString());
    }
  }
  // Cap total candidates for speed.
  const cappedCandidates = Array.from(candidates).slice(0, 5);

  // 2) try buscador candidates until one returns 200 with plausible content
  let best = null;
  for (const cand of cappedCandidates) {
    if (best && best.jsonForm) break;
    const r = await timedFetch(cand);
    await sleep(THROTTLE_MS);
    if (!r.ok) continue;
    if (r.status === 404) continue;
    if (r.status >= 400) continue;
    const info = classifyBuscadorPage(r.body);
    if (info.empty) continue;
    if (info.captcha) {
      best = { url: cand, info, status: r.status };
      break;
    }
    if (info.jsonForm || info.resultTable) {
      best = { url: cand, info, status: r.status };
      break;
    }
    best = best ?? { url: cand, info, status: r.status };
  }

  if (!best) {
    report.verdict = homeInfo.captcha ? "SKIP_CAPTCHA" : "SKIP_NO_BUSCADOR";
    report.note = "no buscador path reachable";
    return report;
  }
  if (best.info.captcha) {
    report.verdict = "SKIP_CAPTCHA";
    report.note = best.url;
    return report;
  }
  if (best.info.jsonForm || best.info.resultTable) {
    report.verdict = "IMPLEMENTED_CANDIDATE"; // needs manual confirm + adapter
    report.note = best.url;
    return report;
  }
  report.verdict = "SKIP_JS_ONLY";
  report.note = best.url;
  return report;
}

function withCeiling(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function main() {
  console.log("# Pre-flight probe", new Date().toISOString());
  console.log("code\tname\turl\tverdict\tnote");
  process.stdout.write?.(""); // flush hint
  const queue = [...COLEGIOS];
  const workers = Array.from({ length: CONCURRENCY }, async (_, wid) => {
    while (queue.length) {
      const c = queue.shift();
      if (!c) break;
      const fallback = { code: c.code, name: c.name, url: c.url, verdict: "SKIP_TIMEOUT", note: "hard ceiling 45s" };
      let r;
      try {
        r = await withCeiling(probe(c), 45_000, fallback);
      } catch (err) {
        r = { ...fallback, note: String(err).slice(0, 80) };
      }
      console.log(`${r.code}\t${r.name}\t${r.url}\t${r.verdict}\t${r.note ?? ""}`);
    }
  });
  await Promise.all(workers);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
