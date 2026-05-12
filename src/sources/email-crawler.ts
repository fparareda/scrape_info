/**
 * Deep site crawler for email discovery.
 *
 * The `email-extractor.ts` sibling probes the homepage + 6 known contact-ish
 * paths. That catches ~85% of lawyer sites but misses firms that gate
 * contact behind team pages, service sub-pages, English mirrors, blog
 * author bios, etc. This crawler does an honest BFS over the site tree up
 * to MAX_DEPTH, bounded at MAX_PAGES_PER_SITE, respecting robots.txt and
 * per-host rate limits.
 *
 * Zero new deps, zero paid APIs.
 *
 * Enabled via PROLIO_RUN_EMAIL_CRAWLER=true. Supports force-mode via
 * PROLIO_EMAIL_CRAWLER_IDS=<uuid,uuid,…>. Defaults to batches of 100 pros
 * per run (tighter than the shallow extractor's 500 because each crawl
 * does ~20× more work).
 */

import { resolveMx } from "node:dns/promises";
import type { SupabaseClient } from "@supabase/supabase-js";

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PAGES_PER_SITE = 25;
const MAX_DEPTH = 3;
const PARALLELISM = 5;
// Hard cap on the total work a single run does: even with the batch
// limit + per-site caps, a pathological set of very-large sites could
// balloon to ~10k page fetches. This guardrail guarantees the GH
// Actions job finishes inside 45 min.
const MAX_TOTAL_PAGES = 2_500;

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

export interface EmailCrawlerResult {
  crawled: number;
  pagesFetched: number;
  prosWithEmails: number;
  newEmails: number;
  failures: number;
  igHandlesDetected: number;
}

interface IgHit {
  handle: string;
  confidence: number;
  pageUrl: string;
}

/* -------------------------------------------------------------------- */
/*                       Instagram handle extraction                     */
/* -------------------------------------------------------------------- */

/**
 * IG direct scraping is a bust in 2026 (login walls + Meta v. Bright
 * Data 2024). But sniffing the handle from the pro's OWN site is
 * zero-risk: same HTTP we already make, just one more regex.
 *
 * Three patterns, anchor-href first (highest signal), then shortlink,
 * then raw-text URL fallback.
 */
const IG_PATTERNS: Array<{ re: RegExp; confidence: number }> = [
  {
    re: /href=["']https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)\/?["']/gi,
    confidence: 0.9,
  },
  {
    re: /href=["']https?:\/\/(?:www\.)?instagr\.am\/([a-zA-Z0-9._]+)\/?["']/gi,
    confidence: 0.85,
  },
  {
    re: /https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/gi,
    confidence: 0.5,
  },
];

const IG_GENERIC = new Set([
  "explore",
  "developer",
  "developers",
  "about",
  "accounts",
  "help",
  "legal",
  "directory",
  "p",
  "reel",
  "reels",
  "tv",
  "stories",
  "web",
  "session",
  "privacy",
  "terms",
]);

const IG_HANDLE_RE = /^[a-zA-Z0-9._]{3,30}$/;

function extractInstagramHandles(html: string, pageUrl: string): IgHit[] {
  const out: IgHit[] = [];
  const seenOnPage = new Set<string>();
  for (const { re, confidence } of IG_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const raw = m[1];
      if (!raw) continue;
      // Strip trailing dots that frequently leak in raw-text matches.
      const handle = raw.replace(/[.]+$/, "").toLowerCase();
      if (!IG_HANDLE_RE.test(handle)) continue;
      if (IG_GENERIC.has(handle)) continue;
      const key = `${handle}|${confidence}`;
      if (seenOnPage.has(key)) continue;
      seenOnPage.add(key);
      out.push({ handle, confidence, pageUrl });
    }
  }
  return out;
}

interface Opts {
  limit?: number;
  professionalIds?: string[];
}

/* -------------------------------------------------------------------- */
/*                              URL helpers                              */
/* -------------------------------------------------------------------- */

function normalizeUrl(raw: string, base?: string): string | null {
  let trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject obvious non-http schemes inline (mailto:, tel:, javascript:)
  if (/^(mailto|tel|javascript|data|#):/i.test(trimmed)) return null;
  // Relative URL → resolve against base
  if (base && !/^https?:\/\//i.test(trimmed)) {
    try {
      trimmed = new URL(trimmed, base).toString();
    } catch {
      return null;
    }
  } else if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  try {
    const u = new URL(trimmed);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    // Strip tracking params — reduces dedup false-negatives on sites
    // that linke the same page with different utm_* combinations.
    for (const param of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
    ]) {
      u.searchParams.delete(param);
    }
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchText(
  url: string,
  accept = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.5,*/*;q=0.1",
): Promise<{ ok: boolean; text: string; url: string; ct: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      redirect: "follow",
      signal: controller.signal,
    });
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok) return { ok: false, text: "", url, ct };
    const text = await res.text();
    return { ok: true, text, url: res.url || url, ct };
  } catch {
    return { ok: false, text: "", url, ct: "" };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------- */
/*                             robots.txt                               */
/* -------------------------------------------------------------------- */

/**
 * Minimal robots.txt parser. We honour `User-agent: *` (and any explicit
 * Prolio-Bot block if present). We collect `Disallow:` prefixes and do a
 * simple `path.startsWith(prefix)` match, which is the standard broad
 * interpretation. `Allow:` overrides are ignored — if a site really
 * needs that granularity they'll tag us a specific UA.
 */
async function loadRobots(
  origin: string,
): Promise<(path: string) => boolean> {
  const res = await fetchText(`${origin}/robots.txt`, "text/plain,*/*");
  if (!res.ok || !res.text) return () => true; // missing robots → allow all
  const lines = res.text.split(/\r?\n/);
  const disallow: string[] = [];
  let inRelevantBlock = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw?.toLowerCase().trim();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      const ua = value.toLowerCase();
      inRelevantBlock = ua === "*" || ua.includes("prolio");
    } else if (inRelevantBlock && key === "disallow" && value) {
      // Ignore malformed patterns — empty or root-only.
      if (value === "/") {
        // Full disallow — just block everything by returning always-false.
        return () => false;
      }
      disallow.push(value);
    }
  }
  return (path: string) => !disallow.some((d) => path.startsWith(d));
}

/* -------------------------------------------------------------------- */
/*                           Email extraction                            */
/* -------------------------------------------------------------------- */

const JUNK_LOCAL =
  /^(no-?reply|postmaster|webmaster|hostmaster|mailer-daemon|donotreply|abuse|privacy|dpo|gdpr|security)@/i;
const JUNK_DOMAIN =
  /@(sentry\.io|gravatar\.com|google-analytics\.com|googleads\.com|googleads\.g\.doubleclick\.net|example\.com|example\.org|example\.net|domain\.com|test\.com|wordpress\.org|wordpress\.com|yourdomain\.com|email\.com|mail\.com|your-?domain\.com|myemail\.com)$/i;
const IMAGE_TLD = /\.(png|jpe?g|gif|svg|webp|ico|bmp|css|js|woff2?|ttf|otf|eot)$/i;
const ADMIN_WORDPRESS = /^admin@(wordpress|wp)/i;

function isJunkEmail(email: string): boolean {
  if (email.length > 80) return true;
  if (JUNK_LOCAL.test(email)) return true;
  if (ADMIN_WORDPRESS.test(email)) return true;
  if (JUNK_DOMAIN.test(email)) return true;
  if (IMAGE_TLD.test(email)) return true;
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
    /([a-z0-9._-]+)\s*[\[(]?\s*(?:at|arroba|\[at\]|\(at\))\s*[\])]?\s*([a-z0-9.-]+)\s*[\[(]?\s*(?:dot|punto|\[dot\]|\(dot\))\s*[\])]?\s*([a-z]{2,})/gi;
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
      // Ignore malformed JSON-LD.
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
/*                           Link extraction                             */
/* -------------------------------------------------------------------- */

/**
 * Pull every `<a href="…">` from the HTML. Cheap regex pass — we
 * tolerate some false positives (e.g. JS-constructed hrefs) because
 * the URL normaliser rejects them.
 */
function extractLinks(html: string, baseUrl: string, sameHost: string): string[] {
  const out = new Set<string>();
  const re = /<a[^>]+href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1] ?? m[2] ?? m[3];
    if (!href) continue;
    const normalized = normalizeUrl(href, baseUrl);
    if (!normalized) continue;
    try {
      const u = new URL(normalized);
      // Same-host only (don't follow to LinkedIn/Twitter/Google Maps).
      if (u.host !== sameHost) continue;
      // Skip asset-looking URLs.
      if (IMAGE_TLD.test(u.pathname)) continue;
      // Skip obvious noise paths that rarely surface emails.
      if (/^\/(wp-json|wp-admin|wp-content|api|feed|rss|search|print|\?)/.test(
        u.pathname + u.search,
      )) {
        continue;
      }
      out.add(normalized);
    } catch {
      // ignore
    }
  }
  return [...out];
}

/* -------------------------------------------------------------------- */
/*                            MX verification                            */
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
/*                          Confidence scoring                           */
/* -------------------------------------------------------------------- */

function isLegalOrContactPath(urlStr: string): boolean {
  try {
    const path = new URL(urlStr).pathname.toLowerCase();
    return /contact|aviso|legal|about|sobre|equipo|team/.test(path);
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
  if (isLegalOrContactPath(pageUrl)) {
    return { source: "aviso_legal", confidence: 0.8 };
  }
  return { source: "website_scrape", confidence: 0.6 };
}

/* -------------------------------------------------------------------- */
/*                        Per-host rate limiting                         */
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
/*                     Per-pro deep BFS crawl                            */
/* -------------------------------------------------------------------- */

interface CrawlOutcome {
  emails: FoundEmail[];
  pagesFetched: number;
  skippedByRobots: number;
  igHits: IgHit[];
}

async function crawlSite(
  pro: Pro,
  hasMx: (domain: string) => Promise<boolean>,
  withHost: <T>(host: string, task: () => Promise<T>) => Promise<T>,
  globalPageBudget: { remaining: number },
): Promise<CrawlOutcome> {
  const emptyOutcome: CrawlOutcome = {
    emails: [],
    pagesFetched: 0,
    skippedByRobots: 0,
    igHits: [],
  };
  if (!pro.website) return emptyOutcome;
  const normalized = normalizeUrl(pro.website);
  if (!normalized) return emptyOutcome;
  let origin: string;
  let host: string;
  try {
    const u = new URL(normalized);
    origin = `${u.protocol}//${u.host}`;
    host = u.host;
  } catch {
    return emptyOutcome;
  }

  const robotsAllow = await withHost(host, () => loadRobots(origin));

  const seen = new Set<string>([normalized]);
  let queue: { url: string; depth: number }[] = [{ url: normalized, depth: 0 }];
  let pagesFetched = 0;
  let skippedByRobots = 0;
  const hits = new Map<string, { hit: RawHit; pageUrl: string }>();
  const igHits: IgHit[] = [];

  while (queue.length && pagesFetched < MAX_PAGES_PER_SITE) {
    if (globalPageBudget.remaining <= 0) break;
    // Pop the next URL; BFS so we drain all depth-N before N+1.
    const next = queue.shift();
    if (!next) break;
    // robots.txt check.
    try {
      const path = new URL(next.url).pathname;
      if (!robotsAllow(path)) {
        skippedByRobots += 1;
        continue;
      }
    } catch {
      continue;
    }
    const res = await withHost(host, () => fetchText(next.url));
    globalPageBudget.remaining -= 1;
    if (!res.ok) continue;
    // Only crawl HTML-ish pages. PDFs can still contain emails but the
    // regex would blow up on binary content; skip.
    if (!/text\/html|application\/xhtml|application\/xml/i.test(res.ct)) continue;
    pagesFetched += 1;

    const rawHits = extractAll(res.text);
    for (const hit of rawHits) {
      if (isJunkEmail(hit.email)) continue;
      // Keep the first-seen variant per email (highest-confidence-wins
      // is done after MX later).
      if (!hits.has(hit.email)) hits.set(hit.email, { hit, pageUrl: res.url });
    }

    // Same HTML, free piggyback: scan for IG profile links.
    for (const ig of extractInstagramHandles(res.text, res.url)) {
      igHits.push(ig);
    }

    // Expand frontier only if we haven't hit depth limit.
    if (next.depth < MAX_DEPTH) {
      const links = extractLinks(res.text, res.url, host);
      for (const link of links) {
        if (seen.size >= MAX_PAGES_PER_SITE * 4) break;
        if (seen.has(link)) continue;
        seen.add(link);
        queue.push({ url: link, depth: next.depth + 1 });
      }
    }
  }

  // Score each email.
  const scored: FoundEmail[] = [];
  for (const [email, { hit, pageUrl }] of hits) {
    const domain = email.slice(email.indexOf("@") + 1);
    const mx = await hasMx(domain);
    const score = scoreHit(hit, mx, pageUrl);
    if (!score) continue;
    scored.push({
      email,
      source: score.source,
      confidence: score.confidence,
      discoveredAtUrl: pageUrl,
    });
  }
  // Dedup: keep highest confidence per email.
  const best = new Map<string, FoundEmail>();
  for (const e of scored) {
    const prev = best.get(e.email);
    if (!prev || e.confidence > prev.confidence) best.set(e.email, e);
  }
  return {
    emails: [...best.values()],
    pagesFetched,
    skippedByRobots,
    igHits,
  };
}

/* -------------------------------------------------------------------- */
/*                  IG handle: per-run dedup + JSONB merge               */
/* -------------------------------------------------------------------- */

/**
 * Pick the most-frequent handle across pages; tie-break by first seen
 * (which respects pattern-priority: anchor > shortlink > raw).
 */
function chooseIgHandle(hits: IgHit[]): IgHit | null {
  if (!hits.length) return null;
  const counts = new Map<string, { count: number; first: IgHit }>();
  for (const h of hits) {
    const prev = counts.get(h.handle);
    if (prev) {
      prev.count += 1;
    } else {
      counts.set(h.handle, { count: 1, first: h });
    }
  }
  let best: { count: number; first: IgHit } | null = null;
  for (const v of counts.values()) {
    if (!best || v.count > best.count) best = v;
  }
  return best ? best.first : null;
}

/**
 * Merge `instagram` into `professionals.metadata` without clobbering
 * other JSONB keys. Read-modify-write because Supabase JS doesn't expose
 * the `||` jsonb operator. RLS doesn't block — caller uses service role.
 */
async function writeInstagramMetadata(
  client: SupabaseClient,
  proId: string,
  pick: IgHit,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (client.from("professionals") as any)
    .select("metadata")
    .eq("id", proId)
    .single();
  if (error) {
    console.log("[email-crawler] ig read metadata error", error.message);
    return false;
  }
  const current =
    data && typeof data === "object" && data.metadata && typeof data.metadata === "object"
      ? (data.metadata as Record<string, unknown>)
      : {};
  const existing = current.instagram as
    | { handle?: string; detected_at?: string; source_url?: string }
    | undefined;
  // Idempotent: skip rewrite if the same handle is already pinned.
  if (existing && existing.handle === pick.handle) return false;
  const merged = {
    ...current,
    instagram: {
      handle: pick.handle,
      detected_at: new Date().toISOString(),
      source_url: pick.pageUrl,
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updErr } = await (client.from("professionals") as any)
    .update({ metadata: merged })
    .eq("id", proId);
  if (updErr) {
    console.log("[email-crawler] ig write metadata error", updErr.message);
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------- */
/*                              Main runner                              */
/* -------------------------------------------------------------------- */

export function emailCrawlerEnabled(): boolean {
  return process.env.PROLIO_RUN_EMAIL_CRAWLER === "true";
}

/** 30-day skip window for monthly cadence. */
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

async function loadPros(
  client: SupabaseClient,
  opts: Opts,
): Promise<Pro[]> {
  if (opts.professionalIds && opts.professionalIds.length) {
    const ids = opts.professionalIds;
    const { data } = await (client.from("professionals") as any)
      .select("id, website")
      .in("id", ids);
    return (data ?? []) as Pro[];
  }

  const limit = opts.limit ?? 100;
  const forceRefresh = process.env.PROLIO_CRAWLER_FORCE_REFRESH === "true";
  const windowCutoff = new Date(Date.now() - MONTHLY_WINDOW_MS).toISOString();
  const shard = Number.parseInt(process.env.PROLIO_CRAWLER_SHARD ?? "0", 10);
  const shardOffset =
    Number.isFinite(shard) && shard >= 0 ? shard * limit : 0;

  const recentlyCrawled = new Set<string>();
  if (!forceRefresh) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await (client
        .from("v_professional_last_crawl") as any)
        .select("professional_id, last_crawl_at")
        .gte("last_crawl_at", windowCutoff)
        .range(from, from + 999);
      if (error || !data || !data.length) break;
      for (const r of data as Array<{ professional_id: string }>) {
        recentlyCrawled.add(r.professional_id);
      }
      if (data.length < 1000) break;
    }
  }

  const candidates: Pro[] = [];
  let skipped = 0;
  for (let from = 0; candidates.length < limit; from += 1000) {
    const { data, error } = await (client.from("professionals") as any)
      .select("id, website")
      .eq("is_published", true)
      .not("website", "is", null)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error || !data || !data.length) break;
    for (const r of data as Pro[]) {
      if (recentlyCrawled.has(r.id)) continue;
      if (skipped < shardOffset) {
        skipped += 1;
        continue;
      }
      candidates.push(r);
      if (candidates.length >= limit) break;
    }
    if (data.length < 1000) break;
  }
  return candidates;
}

/** Record a single crawl run for monthly-cadence tracking. */
async function recordCrawlHistory(
  client: SupabaseClient,
  proId: string,
  outcome: {
    pagesFetched: number;
    emailsFound: number;
    newEmails: number;
    maxConfidence: number | null;
    skippedByRobots: number;
    errorNote?: string | null;
  },
): Promise<void> {
  const { error } = await (client.from("email_crawl_history") as any).insert({
    professional_id: proId,
    crawled_at: new Date().toISOString(),
    pages_fetched: outcome.pagesFetched,
    emails_found: outcome.emailsFound,
    new_emails: outcome.newEmails,
    max_confidence: outcome.maxConfidence,
    skipped_by_robots: outcome.skippedByRobots,
    error_note: outcome.errorNote ?? null,
  });
  if (error) {
    console.log("[email-crawler] history insert error", error.message);
  }
}

async function upsertEmails(
  client: SupabaseClient,
  proId: string,
  found: FoundEmail[],
): Promise<number> {
  if (!found.length) return 0;
  const rows = found.map((f) => ({
    professional_id: proId,
    email: f.email,
    source: f.source,
    confidence: f.confidence,
    discovered_at_url: f.discoveredAtUrl,
    verified_at: new Date().toISOString(),
  }));
  // Chunked upsert to stay under URL limits.
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error, data } = await (client
      .from("professional_emails") as any)
      .upsert(chunk, {
        onConflict: "professional_id,email",
        ignoreDuplicates: false,
      })
      .select("id");
    if (error) {
      console.log("[email-crawler] upsert error", error.message);
      continue;
    }
    inserted += (data ?? []).length;
  }
  return inserted;
}

export async function runEmailCrawler(
  client: SupabaseClient,
  opts: Opts = {},
): Promise<EmailCrawlerResult> {
  const pros = await loadPros(client, opts);
  console.log(`[email-crawler] candidates: ${pros.length}`);
  const hasMx = makeMxCache();
  const withHost = makeHostQueue();
  const budget = { remaining: MAX_TOTAL_PAGES };

  let crawled = 0;
  let pagesFetched = 0;
  let prosWithEmails = 0;
  let newEmails = 0;
  let failures = 0;
  let igHandlesDetected = 0;

  async function worker(queue: Pro[]): Promise<void> {
    while (queue.length) {
      const pro = queue.shift();
      if (!pro) return;
      let outcome: CrawlOutcome | null = null;
      let errorNote: string | null = null;
      let insertedThisPro = 0;
      try {
        outcome = await crawlSite(pro, hasMx, withHost, budget);
        crawled += 1;
        pagesFetched += outcome.pagesFetched;
        if (outcome.emails.length > 0) {
          prosWithEmails += 1;
          insertedThisPro = await upsertEmails(client, pro.id, outcome.emails);
          newEmails += insertedThisPro;
        }
        const igPick = chooseIgHandle(outcome.igHits);
        if (igPick) {
          const wrote = await writeInstagramMetadata(client, pro.id, igPick);
          if (wrote) igHandlesDetected += 1;
        }
      } catch (err) {
        failures += 1;
        errorNote = (err as Error).message.slice(0, 500);
        console.log("[email-crawler] crawl error", {
          pro: pro.id,
          err: errorNote,
        });
      }

      // Always record history — even zero-emails / zero-pages is signal
      // for the monthly cadence (this pro is "done for 30 days" now).
      const maxConf = outcome?.emails.length
        ? Math.max(...outcome.emails.map((e) => e.confidence))
        : null;
      await recordCrawlHistory(client, pro.id, {
        pagesFetched: outcome?.pagesFetched ?? 0,
        emailsFound: outcome?.emails.length ?? 0,
        newEmails: insertedThisPro,
        maxConfidence: maxConf,
        skippedByRobots: outcome?.skippedByRobots ?? 0,
        errorNote,
      });

      if (crawled > 0 && crawled % 10 === 0) {
        console.log(
          `[email-crawler] progress ${crawled}/${pros.length} — pages=${pagesFetched} pros-with-email=${prosWithEmails} budget-left=${budget.remaining}`,
        );
      }
    }
  }

  const queue = [...pros];
  await Promise.all(
    Array.from({ length: PARALLELISM }, () => worker(queue)),
  );

  console.log(
    `[email-crawler] done — crawled=${crawled} pagesFetched=${pagesFetched} prosWithEmails=${prosWithEmails} newEmails=${newEmails} igHandlesDetected=${igHandlesDetected} failures=${failures}`,
  );

  return {
    crawled,
    pagesFetched,
    prosWithEmails,
    newEmails,
    failures,
    igHandlesDetected,
  };
}
