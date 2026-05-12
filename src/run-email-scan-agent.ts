/**
 * Email scan agent — iterates professionals with websites but no email,
 * crawls each site, extracts emails, updates tracking columns.
 *
 * Tracking columns (pre-flight verified):
 *   email_scan_attempts INT DEFAULT 0 NOT NULL
 *   last_email_scan_at  TIMESTAMPTZ
 *   email_scan_status   TEXT 'pending'|'scanned'|'no_emails'
 *
 * Run: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... tsx src/run-email-scan-agent.ts
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveMx } from "node:dns/promises";
import { writeFileSync } from "node:fs";

const START_MS = Date.now();
const HARD_CAP_MS = 58 * 60 * 1000; // 58 min, 2 min buffer for summary
const FETCH_TIMEOUT_MS = 15_000;
const RATE_LIMIT_MS = 800;
const BATCH_SIZE = 1000;
const PARALLELISM = 5;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const CONTACT_PATHS = ["/contact", "/contacto", "/aviso-legal"];

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface ProRow {
  id: string;
  website: string;
  email_scan_attempts: number;
}

type EmailSource = "mailto" | "jsonld" | "website_scrape" | "aviso_legal";

interface FoundEmail {
  email: string;
  source: EmailSource;
  confidence: number;
}

/* ------------------------------------------------------------------ */
/*  Counters                                                            */
/* ------------------------------------------------------------------ */

const stats = {
  scanned: 0,
  foundEmails: 0,
  noEmails: 0,
  errors: 0,
  errorHosts: new Map<string, number>(),
};

function elapsed(): number {
  return Date.now() - START_MS;
}

function overCap(): boolean {
  return elapsed() > HARD_CAP_MS;
}

/* ------------------------------------------------------------------ */
/*  Per-host rate limiter                                               */
/* ------------------------------------------------------------------ */

const lastFetchAt = new Map<string, number>();

async function rateLimit(host: string): Promise<void> {
  const last = lastFetchAt.get(host) ?? 0;
  const wait = RATE_LIMIT_MS - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastFetchAt.set(host, Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/*  robots.txt                                                          */
/* ------------------------------------------------------------------ */

const robotsCache = new Map<string, (path: string) => boolean>();

async function getRobots(origin: string): Promise<(path: string) => boolean> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;
  const checker = await loadRobots(origin);
  robotsCache.set(origin, checker);
  return checker;
}

async function loadRobots(origin: string): Promise<(path: string) => boolean> {
  const res = await fetchText(`${origin}/robots.txt`);
  if (!res.ok || !res.text) return () => true;
  const lines = res.text.split(/\r?\n/);
  const disallow: string[] = [];
  let inRelevant = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).toLowerCase().trim();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      const ua = value.toLowerCase();
      inRelevant = ua === "*" || ua.includes("prolio");
    } else if (inRelevant && key === "disallow" && value) {
      if (value === "/") return () => false;
      disallow.push(value);
    }
  }
  return (path: string) => !disallow.some((d) => path.startsWith(d));
}

/* ------------------------------------------------------------------ */
/*  HTTP fetch helper                                                   */
/* ------------------------------------------------------------------ */

interface FetchResult {
  ok: boolean;
  text: string;
  finalUrl: string;
  status: number;
  retryAfter?: number;
}

async function fetchText(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.5,*/*;q=0.1",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const retryAfter =
      res.status === 429
        ? Number.parseInt(res.headers.get("retry-after") ?? "60", 10) * 1000
        : undefined;
    if (!res.ok)
      return { ok: false, text: "", finalUrl: res.url || url, status: res.status, retryAfter };
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml|application\/xml/i.test(ct)) {
      return { ok: false, text: "", finalUrl: res.url || url, status: res.status };
    }
    const text = await res.text();
    return { ok: true, text, finalUrl: res.url || url, status: res.status };
  } catch {
    return { ok: false, text: "", finalUrl: url, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  Email extraction                                                    */
/* ------------------------------------------------------------------ */

const JUNK_LOCAL =
  /^(no-?reply|postmaster|webmaster|hostmaster|mailer-daemon|donotreply|abuse|privacy|dpo|gdpr|security|atencionalcliente|tiendaonline|clientes-internet|soporteonline|publicaffairs|press|webteam|soporte|support|patients|socialmedia|noreply|info-?noreply)@/i;
const JUNK_DOMAIN =
  /@(sentry\.io|gravatar\.com|google-analytics\.com|example\.com|example\.org|example\.net|domain\.com|test\.com|wordpress\.org|wordpress\.com|yourdomain\.com|email\.com|mail\.com|miempresa\.es|mysite\.com|wpdns\.ca|euromaster\.com|endesaonline\.com|saltoki\.es|citroen\.com|confortauto\.com|goodyear\.|vithas\.es|hospitalesparque\.es|hospiten\.com|doctoralia\.com|thriveworks\.com|novanthealth\.org|softrontax\.com|uthscsa\.edu|protectionreport\.com|theharriscenter\.org|aitax\.ca|google\.com)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp|css|js|woff2?|ttf|otf|eot)$/i;
// Bot's own UA contact address — some sites reflect it back
const BOT_EMAIL = "ferranp.work@gmail.com";

function isJunk(email: string): boolean {
  if (email.length > 80) return true;
  if (email === BOT_EMAIL) return true;
  if (JUNK_LOCAL.test(email)) return true;
  if (JUNK_DOMAIN.test(email)) return true;
  if (IMAGE_EXT.test(email)) return true;
  const atIdx = email.indexOf("@");
  if (atIdx < 1) return true;
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  // Reject unicode-escape artifacts (e.g. "u003emartin" from >> in JS strings)
  if (/u[0-9a-f]{4}/i.test(local)) return true;
  // Reject placeholder-style addresses (e.g. xxx@xxxx.com)
  if (/^x+$/i.test(local)) return true;
  // Reject local parts that don't start with alphanumeric
  if (!/^[a-z0-9]/i.test(local)) return true;
  return !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain);
}

function extractMailto(html: string): Array<{ email: string; source: EmailSource }> {
  const out: Array<{ email: string; source: EmailSource }> = [];
  const re = /mailto:([^"'\s?>&#]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const email = decodeURIComponent(m[1]).trim().toLowerCase().replace(/[?&].*$/, "").replace(/^mailto:/i, "").replace(/^[^a-z0-9]+/, "");
    out.push({ email, source: "mailto" });
  }
  return out;
}

function extractJsonLd(html: string): Array<{ email: string; source: EmailSource }> {
  const out: Array<{ email: string; source: EmailSource }> = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim()) as unknown;
      const bag = new Set<string>();
      walkJson(parsed, bag);
      for (const e of bag) out.push({ email: e, source: "jsonld" });
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

function walkJson(node: unknown, acc: Set<string>): void {
  if (!node) return;
  if (typeof node === "string") {
    const mm = node.match(/^mailto:(.+)$/i);
    if (mm) acc.add(mm[1].trim().toLowerCase());
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walkJson(c, acc);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k.toLowerCase() === "email" && typeof v === "string") {
        acc.add(v.trim().toLowerCase().replace(/^mailto:/i, ""));
      } else {
        walkJson(v, acc);
      }
    }
  }
}

function extractPlain(html: string): Array<{ email: string; source: EmailSource }> {
  const out: Array<{ email: string; source: EmailSource }> = [];
  const re = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ email: m[0].toLowerCase(), source: "website_scrape" });
  }
  return out;
}

function extractObfuscated(html: string): Array<{ email: string; source: EmailSource }> {
  const out: Array<{ email: string; source: EmailSource }> = [];
  const re =
    /([a-z0-9._-]+)\s*[\[(]?\s*(?:at|arroba|\[at\]|\(at\))\s*[\])]?\s*([a-z0-9.-]+)\s*[\[(]?\s*(?:dot|punto|\[dot\]|\(dot\))\s*[\])]?\s*([a-z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ email: `${m[1]}@${m[2]}.${m[3]}`.toLowerCase(), source: "website_scrape" });
  }
  return out;
}

function extractAll(html: string): Array<{ email: string; source: EmailSource }> {
  return [
    ...extractMailto(html),
    ...extractJsonLd(html),
    ...extractObfuscated(html),
    ...extractPlain(html),
  ];
}

/* ------------------------------------------------------------------ */
/*  MX verification cache                                               */
/* ------------------------------------------------------------------ */

const mxCache = new Map<string, Promise<boolean>>();

function hasMx(domain: string): Promise<boolean> {
  const d = domain.toLowerCase();
  const cached = mxCache.get(d);
  if (cached) return cached;
  const p = resolveMx(d)
    .then((r) => r.length > 0)
    .catch(() => false);
  mxCache.set(d, p);
  return p;
}

/* ------------------------------------------------------------------ */
/*  Per-site shallow crawl                                              */
/* ------------------------------------------------------------------ */

function isContactPath(urlStr: string): boolean {
  try {
    const p = new URL(urlStr).pathname.toLowerCase();
    return /contact|aviso|legal|about|sobre|equipo|team/.test(p);
  } catch {
    return false;
  }
}

async function crawlPro(pro: ProRow): Promise<FoundEmail[]> {
  let normalized = pro.website.trim();
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
  let origin: string;
  let host: string;
  try {
    const u = new URL(normalized);
    origin = `${u.protocol}//${u.host}`;
    host = u.host;
  } catch {
    return [];
  }

  await rateLimit(host);
  const robotsAllow = await getRobots(origin);

  const pagesToFetch: string[] = [normalized];
  for (const p of CONTACT_PATHS) {
    const fullUrl = `${origin}${p}`;
    try {
      const path = new URL(fullUrl).pathname;
      if (robotsAllow(path)) pagesToFetch.push(fullUrl);
    } catch {
      /* skip */
    }
  }

  const hits = new Map<string, { source: EmailSource; isContact: boolean }>();

  for (const pageUrl of pagesToFetch) {
    if (overCap()) break;
    let path: string;
    try {
      path = new URL(pageUrl).pathname;
    } catch {
      continue;
    }
    if (!robotsAllow(path)) continue;

    await rateLimit(host);
    const res = await fetchText(pageUrl);

    if (res.status === 429 && res.retryAfter) {
      await sleep(Math.min(res.retryAfter, 30_000));
      continue;
    }
    if (!res.ok) continue;

    const isContact = isContactPath(pageUrl);
    for (const { email, source } of extractAll(res.text)) {
      if (isJunk(email)) continue;
      if (!hits.has(email)) {
        hits.set(email, { source, isContact });
      }
    }
  }

  if (!hits.size) return [];

  const scored: FoundEmail[] = [];
  for (const [email, { source, isContact }] of hits) {
    const domain = email.slice(email.indexOf("@") + 1);
    const mx = await hasMx(domain);
    if (!mx) continue;
    let confidence: number;
    if (source === "mailto") confidence = 0.95;
    else if (source === "jsonld") confidence = 0.9;
    else if (isContact) confidence = 0.8;
    else confidence = 0.6;
    scored.push({ email, source, confidence });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  return scored;
}

/* ------------------------------------------------------------------ */
/*  DB helpers                                                          */
/* ------------------------------------------------------------------ */

async function updateFound(
  db: SupabaseClient,
  row: ProRow,
  email: string,
): Promise<void> {
  const newAttempts = row.email_scan_attempts + 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db.from("professionals") as any).update({
    email,
    email_scan_status: "scanned",
    email_scan_attempts: newAttempts,
    last_email_scan_at: new Date().toISOString(),
  }).eq("id", row.id);
  if (error) console.error(`[agent] update found error ${row.id}:`, error.message);
}

async function updateNotFound(db: SupabaseClient, row: ProRow): Promise<void> {
  const newAttempts = row.email_scan_attempts + 1;
  const newStatus = newAttempts >= 5 ? "no_emails" : "pending";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db.from("professionals") as any).update({
    email_scan_attempts: newAttempts,
    last_email_scan_at: new Date().toISOString(),
    email_scan_status: newStatus,
  }).eq("id", row.id);
  if (error) console.error(`[agent] update not-found error ${row.id}:`, error.message);
  if (newStatus === "no_emails") stats.noEmails++;
}

/* ------------------------------------------------------------------ */
/*  Batch query                                                         */
/* ------------------------------------------------------------------ */

async function fetchBatch(db: SupabaseClient): Promise<ProRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db.from("professionals") as any)
    .select("id, website, email_scan_attempts")
    .not("website", "is", null)
    .neq("website", "")
    .or("email.is.null,email.eq.")
    .or("email_scan_status.is.null,email_scan_status.eq.pending")
    .lt("email_scan_attempts", 5)
    .order("last_email_scan_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE);
  if (error) throw new Error(`Batch query failed: ${error.message}`);
  return (data ?? []) as ProRow[];
}

async function countQueue(db: SupabaseClient): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count, error } = await (db.from("professionals") as any)
    .select("id", { count: "exact", head: true })
    .not("website", "is", null)
    .neq("website", "")
    .or("email.is.null,email.eq.")
    .or("email_scan_status.is.null,email_scan_status.eq.pending")
    .lt("email_scan_attempts", 5);
  if (error) {
    console.error("[agent] countQueue error:", error.message);
    return -1;
  }
  return count ?? 0;
}

/* ------------------------------------------------------------------ */
/*  Worker                                                              */
/* ------------------------------------------------------------------ */

async function worker(
  db: SupabaseClient,
  queue: ProRow[],
): Promise<void> {
  while (queue.length) {
    if (overCap()) {
      console.log("[agent] hard cap reached, stopping worker");
      break;
    }
    const row = queue.shift();
    if (!row) break;
    try {
      const emails = await crawlPro(row);
      stats.scanned++;
      if (emails.length > 0) {
        const best = emails[0];
        await updateFound(db, row, best.email);
        stats.foundEmails++;
        console.log(`[agent] ✓ ${row.id} → ${best.email} (${best.source})`);
      } else {
        await updateNotFound(db, row);
        if ((row.email_scan_attempts + 1) >= 5) {
          console.log(`[agent] ✗ ${row.id} → no_emails (5 strikes)`);
        }
      }
    } catch (err) {
      stats.errors++;
      const msg = (err as Error).message;
      let host = "unknown";
      try {
        host = new URL(row.website).host;
      } catch { /* */ }
      stats.errorHosts.set(host, (stats.errorHosts.get(host) ?? 0) + 1);
      console.error(`[agent] error ${row.id} (${host}):`, msg);
      // Still update attempt counter so we don't retry infinitely
      try {
        await updateNotFound(db, row);
      } catch { /* swallow secondary error */ }
    }
    if (stats.scanned > 0 && stats.scanned % 50 === 0) {
      const mins = Math.round(elapsed() / 60000);
      console.log(
        `[agent] progress scanned=${stats.scanned} emails=${stats.foundEmails} no_emails=${stats.noEmails} errors=${stats.errors} elapsed=${mins}m`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Summary writer                                                      */
/* ------------------------------------------------------------------ */

function writeSummary(
  pendingQueue: number,
  exhaustionPath: string,
): void {
  const date = new Date().toISOString().slice(0, 10);
  const runtimeMin = Math.round(elapsed() / 60000);
  const topErrors = [...stats.errorHosts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h, n]) => `${h}(${n})`)
    .join(", ");

  const lines = [
    `📧 Prolio email crawl — ${date}`,
    `Scanned: ${stats.scanned} websites`,
    `Found emails: ${stats.foundEmails}`,
    `Marked no_emails (5 fails): ${stats.noEmails}`,
    `Pending queue: ${pendingQueue}`,
    `Exhaustion path: ${exhaustionPath}`,
    `Errors: ${stats.errors}${topErrors ? ` (top 3: ${topErrors})` : ""}`,
    `Runtime: ${runtimeMin} minutes`,
  ];
  const content = lines.join("\n") + "\n";
  writeFileSync("/tmp/summary.md", content);
  console.log("\n" + content);
}

/* ------------------------------------------------------------------ */
/*  Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    const msg = "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY";
    writeFileSync("/tmp/summary.md", `Pre-flight abort: ${msg}\n`);
    throw new Error(msg);
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("[agent] fetching batch...");
  const batch = await fetchBatch(db);
  console.log(`[agent] batch size: ${batch.length}`);

  if (batch.length === 0) {
    const remaining = await countQueue(db);
    console.log(`[agent] queue already empty (remaining=${remaining})`);
    writeSummary(remaining, "not triggered");
    return;
  }

  const queue = [...batch];
  await Promise.all(
    Array.from({ length: PARALLELISM }, () => worker(db, queue)),
  );

  // Count remaining after batch
  const remaining = await countQueue(db);
  let exhaustionPath = "not triggered";

  if (remaining === 0 && !overCap()) {
    console.log("[agent] queue exhausted — exhaustion path not implemented in this run");
    exhaustionPath = "queue exhausted — new trade expansion deferred to next agent run";
  }

  writeSummary(remaining, exhaustionPath);
}

main().catch((err) => {
  const msg = String(err?.message ?? err);
  console.error("[agent] fatal:", msg);
  try {
    writeFileSync(
      "/tmp/summary.md",
      `📧 Prolio email crawl — ${new Date().toISOString().slice(0, 10)}\nFatal error: ${msg}\n`,
    );
  } catch { /* */ }
  process.exit(1);
});
