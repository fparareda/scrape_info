/**
 * Free website → email extractor.
 *
 * For every published professional with a website we fetch the homepage
 * (and a handful of contact-ish paths as fallback), mine the HTML for
 * emails via several strategies (mailto:, obfuscated [at]/(at), plain
 * regex, JSON-LD ContactPoint), drop obvious junk, verify MX, and upsert
 * into `public.professional_emails`.
 *
 * Zero paid APIs, zero new deps — just `fetch`, regex and `node:dns`.
 *
 * Enabled via PROLIO_RUN_EMAIL_EXTRACTOR=true. Supports a one-off
 * force-mode via PROLIO_EMAIL_EXTRACTOR_IDS=<uuid,uuid,…>.
 */

import { resolveMx } from "node:dns/promises";
import type { SupabaseClient } from "@supabase/supabase-js";

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FETCH_TIMEOUT_MS = 8_000;
const CANDIDATE_PATHS = [
  "/contacto",
  "/contact",
  "/aviso-legal",
  "/legal",
  "/about",
  "/sobre-nosotros",
];
const PARALLELISM = 10;

type EmailSource =
  | "website_scrape"
  | "mailto"
  | "jsonld"
  | "aviso_legal";

interface FoundEmail {
  email: string;
  source: EmailSource;
  confidence: number;
  discoveredAtUrl: string;
}

interface Pro {
  id: string;
  website: string | null;
}

export interface EmailExtractorResult {
  scraped: number;
  found: number;
  newEmails: number;
  failures: number;
}

interface Opts {
  limit?: number;
  professionalIds?: string[];
}

/* -------------------------------------------------------------------- */
/*                              URL / fetch                             */
/* -------------------------------------------------------------------- */

function normalizeUrl(raw: string): string | null {
  let trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `https://${trimmed}`;
  try {
    const u = new URL(trimmed);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchHtml(
  url: string,
): Promise<{ ok: boolean; html: string; url: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, html: "", url };
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml|application\/xml|text\/plain/i.test(ct)) {
      return { ok: false, html: "", url };
    }
    const html = await res.text();
    return { ok: true, html, url: res.url || url };
  } catch {
    return { ok: false, html: "", url };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------- */
/*                           Email extraction                           */
/* -------------------------------------------------------------------- */

const JUNK_LOCAL = /^(no-?reply|postmaster|webmaster|hostmaster|mailer-daemon|donotreply)@/i;
const JUNK_DOMAIN =
  /@(sentry\.io|gravatar\.com|google-analytics\.com|googleads\.com|googleads\.g\.doubleclick\.net|example\.com|example\.org|domain\.com|test\.com|wordpress\.org|wordpress\.com|yourdomain\.com|email\.com)$/i;
const IMAGE_TLD = /\.(png|jpe?g|gif|svg|webp|ico|bmp|css|js|woff2?)$/i;
const ADMIN_WORDPRESS = /^admin@wordpress/i;

function isJunkEmail(email: string): boolean {
  if (email.length > 80) return true;
  if (JUNK_LOCAL.test(email)) return true;
  if (ADMIN_WORDPRESS.test(email)) return true;
  if (JUNK_DOMAIN.test(email)) return true;
  if (IMAGE_TLD.test(email)) return true;
  // Basic structural sanity — at least one dot in domain, domain >= 3 chars.
  const atIdx = email.indexOf("@");
  if (atIdx < 1) return true;
  const domain = email.slice(atIdx + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return true;
  return false;
}

interface RawHit {
  email: string;
  source: EmailSource;
}

function extractMailto(html: string): RawHit[] {
  const out: RawHit[] = [];
  const re = /mailto:([^"'\s?>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const email = decodeURIComponent(m[1]).trim().toLowerCase();
    out.push({ email, source: "mailto" });
  }
  return out;
}

function extractObfuscated(html: string): RawHit[] {
  const out: RawHit[] = [];
  const re =
    /([a-z0-9._-]+)\s*[\[(]?\s*at\s*[\])]?\s*([a-z0-9.-]+)\s*[\[(]?\s*dot\s*[\])]?\s*([a-z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({
      email: `${m[1]}@${m[2]}.${m[3]}`.toLowerCase(),
      source: "website_scrape",
    });
  }
  return out;
}

function extractPlain(html: string): RawHit[] {
  const out: RawHit[] = [];
  const re = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ email: m[0].toLowerCase(), source: "website_scrape" });
  }
  return out;
}

function walkJsonForEmails(node: unknown, acc: Set<string>): void {
  if (!node) return;
  if (typeof node === "string") {
    // Strings sometimes contain "mailto:foo@bar.com"
    const m = node.match(/^mailto:(.+)$/i);
    if (m) acc.add(m[1].trim().toLowerCase());
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walkJsonForEmails(child, acc);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key.toLowerCase() === "email" && typeof value === "string") {
        acc.add(value.trim().toLowerCase().replace(/^mailto:/i, ""));
      } else {
        walkJsonForEmails(value, acc);
      }
    }
  }
}

function extractJsonLd(html: string): RawHit[] {
  const out: RawHit[] = [];
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const bag = new Set<string>();
      walkJsonForEmails(parsed, bag);
      for (const email of bag) out.push({ email, source: "jsonld" });
    } catch {
      // Malformed JSON-LD is common (CMS trailing commas). Ignore.
    }
  }
  return out;
}

function extractAll(html: string): RawHit[] {
  return [
    ...extractMailto(html),
    ...extractJsonLd(html),
    ...extractObfuscated(html),
    ...extractPlain(html),
  ];
}

/* -------------------------------------------------------------------- */
/*                            MX verification                           */
/* -------------------------------------------------------------------- */

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
/*                          Confidence scoring                          */
/* -------------------------------------------------------------------- */

function isLegalOrContactPath(urlStr: string): boolean {
  try {
    const path = new URL(urlStr).pathname.toLowerCase();
    return /contact|aviso|legal/.test(path);
  } catch {
    return false;
  }
}

function scoreHit(
  hit: RawHit,
  hasMx: boolean,
  pageUrl: string,
): { source: EmailSource; confidence: number } | null {
  if (!hasMx) return null;
  if (hit.source === "mailto") return { source: "mailto", confidence: 0.95 };
  if (hit.source === "jsonld") return { source: "jsonld", confidence: 0.9 };
  // Obfuscated patterns came through extractObfuscated — we tag them as
  // website_scrape internally. Detect by shape: the plain-regex pass will
  // also produce an entry for the de-obfuscated address, but confidence
  // from the obfuscated pass wins if present. We upsert highest-conf
  // per email later.
  if (isLegalOrContactPath(pageUrl)) {
    // Found on /contacto or /aviso-legal → 0.8
    return { source: "aviso_legal", confidence: 0.8 };
  }
  return { source: "website_scrape", confidence: 0.6 };
}

/* -------------------------------------------------------------------- */
/*                        Per-host rate limiting                        */
/* -------------------------------------------------------------------- */

function makeHostQueue(): <T>(host: string, task: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(host: string, task: () => Promise<T>): Promise<T> => {
    const prev = chains.get(host) ?? Promise.resolve();
    const next = prev.then(() => task(), () => task());
    chains.set(
      host,
      next.catch(() => {
        /* swallow */
      }),
    );
    return next;
  };
}

/* -------------------------------------------------------------------- */
/*                        Per-pro extraction logic                      */
/* -------------------------------------------------------------------- */

async function extractForPro(
  pro: Pro,
  hasMx: (domain: string) => Promise<boolean>,
  withHost: <T>(host: string, task: () => Promise<T>) => Promise<T>,
): Promise<FoundEmail[]> {
  if (!pro.website) return [];
  const normalized = normalizeUrl(pro.website);
  if (!normalized) return [];
  let origin: string;
  let host: string;
  try {
    const u = new URL(normalized);
    origin = `${u.protocol}//${u.host}`;
    host = u.host;
  } catch {
    return [];
  }

  // 1) Homepage.
  const pages: { url: string; html: string }[] = [];
  const home = await withHost(host, () => fetchHtml(normalized));
  if (home.ok && home.html) {
    pages.push({ url: home.url, html: home.html });
  } else {
    // 2) Fallback paths — first that succeeds wins. We still try all
    // serially per-host (rate-limit), but stop as soon as one returns.
    for (const path of CANDIDATE_PATHS) {
      const candidateUrl = `${origin}${path}`;
      const res = await withHost(host, () => fetchHtml(candidateUrl));
      if (res.ok && res.html) {
        pages.push({ url: res.url, html: res.html });
        break;
      }
    }
  }

  // 3) If homepage worked, also probe /contacto and /aviso-legal for
  //    higher-confidence signals — cheap and worth it.
  if (home.ok) {
    for (const path of ["/contacto", "/aviso-legal"]) {
      const candidateUrl = `${origin}${path}`;
      const res = await withHost(host, () => fetchHtml(candidateUrl));
      if (res.ok && res.html) pages.push({ url: res.url, html: res.html });
    }
  }

  if (pages.length === 0) return [];

  // Aggregate best hit per email across pages.
  const best = new Map<string, FoundEmail>();
  for (const page of pages) {
    const hits = extractAll(page.html);
    for (const hit of hits) {
      const email = hit.email;
      if (isJunkEmail(email)) continue;
      const atIdx = email.indexOf("@");
      if (atIdx < 0) continue;
      const domain = email.slice(atIdx + 1);
      const mxOk = await hasMx(domain);
      const scored = scoreHit(hit, mxOk, page.url);
      if (!scored) continue;
      const prev = best.get(email);
      if (!prev || scored.confidence > prev.confidence) {
        best.set(email, {
          email,
          source: scored.source,
          confidence: scored.confidence,
          discoveredAtUrl: page.url,
        });
      }
    }
  }
  return [...best.values()];
}

/* -------------------------------------------------------------------- */
/*                               Main run                               */
/* -------------------------------------------------------------------- */

async function loadPros(
  client: SupabaseClient,
  opts: Opts,
): Promise<Pro[]> {
  if (opts.professionalIds && opts.professionalIds.length > 0) {
    const { data, error } = await client
      .from("professionals")
      .select("id, website")
      .in("id", opts.professionalIds);
    if (error) throw error;
    return (data ?? []) as Pro[];
  }

  const limit = opts.limit ?? 500;

  // Pull the set of pros already scraped so we can exclude them in-memory
  // (Supabase client doesn't support `NOT IN (subquery)` directly).
  // professional_emails is small enough to page through.
  const scraped = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from("professional_emails")
      .select("professional_id")
      .eq("source", "website_scrape")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) scraped.add((row as { professional_id: string }).professional_id);
    if (data.length < pageSize) break;
  }

  // Fetch candidates in pages until we have `limit` unscraped ones.
  const out: Pro[] = [];
  const rowPage = 500;
  for (let from = 0; out.length < limit; from += rowPage) {
    const { data, error } = await client
      .from("professionals")
      .select("id, website")
      .eq("is_published", true)
      .not("website", "is", null)
      .range(from, from + rowPage - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data as Pro[]) {
      if (out.length >= limit) break;
      if (!row.website) continue;
      if (scraped.has(row.id)) continue;
      out.push(row);
    }
    if (data.length < rowPage) break;
  }
  return out;
}

async function promisePool<T, R>(
  items: T[],
  size: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

export async function runEmailExtractor(
  client: SupabaseClient,
  opts: Opts = {},
): Promise<EmailExtractorResult> {
  const pros = await loadPros(client, opts);
  console.log(`[email-extractor] candidates: ${pros.length}`);

  if (pros.length === 0) {
    return { scraped: 0, found: 0, newEmails: 0, failures: 0 };
  }

  const hasMx = makeMxCache();
  const withHost = makeHostQueue();

  let scraped = 0;
  let found = 0;
  let failures = 0;
  const allRows: {
    professional_id: string;
    email: string;
    source: EmailSource;
    confidence: number;
    discovered_at_url: string;
    verified_at: string;
  }[] = [];

  await promisePool(pros, PARALLELISM, async (pro, idx) => {
    scraped += 1;
    try {
      const results = await extractForPro(pro, hasMx, withHost);
      if (results.length > 0) {
        found += 1;
        const now = new Date().toISOString();
        for (const r of results) {
          allRows.push({
            professional_id: pro.id,
            email: r.email,
            source: r.source,
            confidence: r.confidence,
            discovered_at_url: r.discoveredAtUrl,
            verified_at: now,
          });
        }
      }
      if ((idx + 1) % 25 === 0) {
        console.log(
          `[email-extractor] progress ${idx + 1}/${pros.length} — found=${found} failures=${failures}`,
        );
      }
    } catch (err) {
      failures += 1;
      console.warn(
        `[email-extractor] pro=${pro.id} failed: ${(err as Error).message}`,
      );
    }
  });

  // Upsert in chunks to avoid payload limits (500/chunk mirrors sink.ts).
  let newEmails = 0;
  const chunkSize = 500;
  for (let i = 0; i < allRows.length; i += chunkSize) {
    const chunk = allRows.slice(i, i + chunkSize);
    const { data, error } = await client
      .from("professional_emails")
      .upsert(chunk, {
        onConflict: "professional_id,email",
        ignoreDuplicates: false,
      })
      .select("id");
    if (error) {
      failures += 1;
      console.error(`[email-extractor] upsert error: ${error.message}`);
      continue;
    }
    newEmails += data?.length ?? 0;
  }

  console.log(
    `[email-extractor] done — scraped=${scraped} found=${found} rows=${allRows.length} newEmails=${newEmails} failures=${failures}`,
  );

  return { scraped, found, newEmails, failures };
}

export function emailExtractorEnabled(): boolean {
  return process.env.PROLIO_RUN_EMAIL_EXTRACTOR === "true";
}
