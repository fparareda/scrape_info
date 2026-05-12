/**
 * Pattern-based email discovery with MX validation.
 *
 * For every published pro with `website` but no `email`, generate ~8
 * candidate addresses using common business-mailbox patterns and accept
 * the first 3 whose registrable domain resolves at least one MX record.
 *
 * Why pattern+MX (and not SMTP):
 *   - SMTP RCPT-TO probing is unreliable (catch-all servers say YES to
 *     everything; tarpits say NO to everything; some block our cloud IP
 *     range outright). And it's RBL-toxic.
 *   - Pure pattern guessing would flood `professional_emails` with
 *     noise. MX validation gates out parked / typoed domains where
 *     none of the candidates would deliver.
 *   - Confidence stays in [0.5, 0.7]: MX existence is necessary but
 *     not sufficient. A downstream `mailto`/`jsonld` row from the live
 *     site can still upgrade to 0.9–0.95.
 *
 * Off by default. Enabled via PROLIO_RUN_PATTERN_MX=true. Budget via
 * PROLIO_PATTERN_MX_LIMIT (default 1000 pros/run). Concurrency 10
 * inline — no `p-limit` dep.
 */

import { resolveMx } from "node:dns/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withScrapeRun } from "../telemetry.js";

const SOURCE = "pattern-mx";
const TELEMETRY_SOURCE = "pattern-mx-email";
const DEFAULT_LIMIT = 1000;
const CONCURRENCY = 10;
const MAX_ACCEPTED_PER_PRO = 3;

/**
 * Catch-all consumer mailbox providers. We can't infer specific
 * addresses on these — every candidate would pass MX (the provider
 * obviously has MX records) but the candidate likely doesn't exist as
 * a real mailbox. Skip the whole pro outright.
 */
const CATCHALL_DOMAINS = new Set<string>([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.es",
  "live.com",
  "yahoo.com",
  "yahoo.es",
  "hotmail.com",
  "hotmail.es",
  "icloud.com",
  "me.com",
  "gmx.com",
  "gmx.es",
  "proton.me",
  "protonmail.com",
]);

/**
 * Substrings in MX hostnames that betray a parked / for-sale domain.
 * These resolve MX records (often pointing at the parking provider's
 * own catchall) but no message will ever reach a real human.
 */
const PARKED_MX_BLACKLIST = ["parked", "domainparking", "brandshelter", "sedoparking"];

interface PatternMxOpts {
  limit?: number;
}

interface Pro {
  id: string;
  name: string | null;
  website: string | null;
}

interface Candidate {
  email: string;
  confidence: number;
}

/* -------------------------------------------------------------------- */
/*                        Domain extraction helper                       */
/* -------------------------------------------------------------------- */

/**
 * Extract a registrable-ish domain from a free-form website value.
 * Strips protocol, leading `www.`, path/query/hash. Returns null if
 * the input is unparseable or doesn't look like a domain at all.
 *
 * We deliberately don't use the public-suffix list (no new dep). For
 * our use case "registrable" means "what would you put in front of
 * @info" — `acme.co.uk` stays `acme.co.uk`, `team.acme.com` stays
 * `team.acme.com`. False positives on subdomains are tolerable: an MX
 * record on the subdomain is still a valid signal.
 */
export function extractDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  return host;
}

/* -------------------------------------------------------------------- */
/*                            Name parsing                               */
/* -------------------------------------------------------------------- */

/**
 * Strip Spanish honorifics and reduce a free-form display name to a
 * (firstname, lastname) tuple usable in email locals. Returns null
 * when the name isn't recognisably a person (e.g. company name, single
 * token, or contains digits).
 */
function parsePersonName(
  raw: string | null,
): { first: string; last: string } | null {
  if (!raw) return null;
  if (/\d/.test(raw)) return null;
  const stripped = raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  const honorifics = new Set([
    "dr", "dra", "doctor", "doctora", "sr", "sra", "don", "dona",
    "lic", "ing", "arq", "abogado", "abogada",
  ]);
  const companyHints = new Set([
    "sl", "s.l", "sa", "s.a", "slu", "scp", "sc", "sociedad",
    "asociados", "asoc", "y", "and", "&",
  ]);
  const tokens = stripped
    .split(" ")
    .map((t) => t.replace(/^\.|\.$/g, ""))
    .filter((t) => t.length > 0 && !honorifics.has(t));
  if (tokens.some((t) => companyHints.has(t))) return null;
  const cleaned = tokens.filter((t) => t.length >= 2);
  if (cleaned.length < 2) return null;
  return { first: cleaned[0], last: cleaned[cleaned.length - 1] };
}

/* -------------------------------------------------------------------- */
/*                          Candidate generation                         */
/* -------------------------------------------------------------------- */

/**
 * Generate candidate (email, confidence) pairs in priority order. The
 * runner walks the list, MX-validates the shared domain once, and
 * accepts the first MAX_ACCEPTED_PER_PRO entries.
 */
export function generateCandidates(
  domain: string,
  name: string | null,
): Candidate[] {
  const out: Candidate[] = [
    { email: `info@${domain}`, confidence: 0.6 },
    { email: `contacto@${domain}`, confidence: 0.6 },
    { email: `hola@${domain}`, confidence: 0.6 },
    { email: `admin@${domain}`, confidence: 0.6 },
  ];
  const person = parsePersonName(name);
  if (person) {
    const { first, last } = person;
    out.push(
      { email: `${first}@${domain}`, confidence: 0.5 },
      { email: `${first}.${last}@${domain}`, confidence: 0.7 },
      { email: `${first[0]}.${last}@${domain}`, confidence: 0.6 },
      { email: `${last}@${domain}`, confidence: 0.5 },
    );
  }
  return out;
}

/* -------------------------------------------------------------------- */
/*                           MX validation                               */
/* -------------------------------------------------------------------- */

interface MxResult {
  ok: boolean;
  parked: boolean;
}

function makeMxCache(): (domain: string) => Promise<MxResult> {
  const cache = new Map<string, Promise<MxResult>>();
  return (domain: string) => {
    const d = domain.toLowerCase();
    const cached = cache.get(d);
    if (cached) return cached;
    const p = (async (): Promise<MxResult> => {
      try {
        const records = await resolveMx(d);
        if (!records.length) return { ok: false, parked: false };
        const parked = records.some((r) => {
          const host = (r.exchange ?? "").toLowerCase();
          return PARKED_MX_BLACKLIST.some((needle) => host.includes(needle));
        });
        return { ok: !parked, parked };
      } catch {
        return { ok: false, parked: false };
      }
    })();
    cache.set(d, p);
    return p;
  };
}

/* -------------------------------------------------------------------- */
/*                           Pre-write dedup                             */
/* -------------------------------------------------------------------- */

/**
 * Returns the set of professional_ids in `ids` that already have at
 * least one `professional_emails` row with confidence >= 0.7. We won't
 * re-write low-confidence pattern guesses on top of a high-confidence
 * direct extraction.
 */
async function loadHighConfidenceProIds(
  client: SupabaseClient,
  ids: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (client.from("professional_emails") as any)
      .select("professional_id, confidence")
      .in("professional_id", chunk)
      .gte("confidence", 0.7);
    if (error) {
      console.warn(`[pattern-mx] dedup query error: ${error.message}`);
      continue;
    }
    for (const r of (data ?? []) as Array<{ professional_id: string }>) {
      out.add(r.professional_id);
    }
  }
  return out;
}

/* -------------------------------------------------------------------- */
/*                          Candidate loading                            */
/* -------------------------------------------------------------------- */

async function loadCandidates(
  client: SupabaseClient,
  limit: number,
): Promise<Pro[]> {
  // Over-fetch ×2 because dedup may eliminate ~half on already-processed
  // pros. PostgREST can't easily do a NOT EXISTS subquery across tables,
  // so we apply it in JS via loadHighConfidenceProIds.
  const target = limit * 2;
  const out: Pro[] = [];
  for (let from = 0; out.length < target; from += 1000) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (client.from("professionals") as any)
      .select("id, name, website")
      .eq("is_published", true)
      .is("email", null)
      .not("website", "is", null)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.warn(`[pattern-mx] candidate query error: ${error.message}`);
      break;
    }
    if (!data || !data.length) break;
    for (const r of data as Pro[]) out.push({ id: r.id, name: r.name, website: r.website });
    if (data.length < 1000) break;
  }
  return out.slice(0, target);
}

/* -------------------------------------------------------------------- */
/*                              Upsert                                   */
/* -------------------------------------------------------------------- */

async function insertEmails(
  client: SupabaseClient,
  rows: Array<{ professional_id: string; email: string; confidence: number }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    ...r,
    source: SOURCE,
    verified_at: new Date().toISOString(),
  }));
  let inserted = 0;
  for (let i = 0; i < payload.length; i += 500) {
    const chunk = payload.slice(i, i + 500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error, data } = await (client.from("professional_emails") as any)
      .upsert(chunk, {
        onConflict: "professional_id,email",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) {
      console.warn(`[pattern-mx] upsert error: ${error.message}`);
      continue;
    }
    inserted += (data ?? []).length;
  }
  return inserted;
}

/* -------------------------------------------------------------------- */
/*                              Main runner                              */
/* -------------------------------------------------------------------- */

export function patternMxEnabled(): boolean {
  return process.env.PROLIO_RUN_PATTERN_MX === "true";
}

export interface PatternMxResult {
  prosProcessed: number;
  prosSkipped: number;
  emailsWritten: number;
}

export async function runPatternMx(
  client: SupabaseClient,
  opts: PatternMxOpts = {},
): Promise<PatternMxResult> {
  const envLimit = Number.parseInt(process.env.PROLIO_PATTERN_MX_LIMIT ?? "", 10);
  const effectiveLimit =
    opts.limit && opts.limit > 0
      ? opts.limit
      : Number.isFinite(envLimit) && envLimit > 0
        ? envLimit
        : DEFAULT_LIMIT;

  const counters = { prosProcessed: 0, prosSkipped: 0, emailsWritten: 0 };

  await withScrapeRun(TELEMETRY_SOURCE, async () => {
    const candidates = await loadCandidates(client, effectiveLimit);
    const skipIds = await loadHighConfidenceProIds(
      client,
      candidates.map((p) => p.id),
    );
    const queue = candidates
      .filter((p) => !skipIds.has(p.id))
      .slice(0, effectiveLimit);
    counters.prosSkipped += skipIds.size;

    console.log(
      `[pattern-mx] candidates=${candidates.length} usable=${queue.length} (skipped ${skipIds.size} high-confidence)`,
    );

    const hasMx = makeMxCache();

    async function handlePro(pro: Pro): Promise<void> {
      counters.prosProcessed += 1;
      const domain = extractDomain(pro.website);
      if (!domain) { counters.prosSkipped += 1; return; }
      if (CATCHALL_DOMAINS.has(domain)) { counters.prosSkipped += 1; return; }
      const mx = await hasMx(domain);
      if (!mx.ok) { counters.prosSkipped += 1; return; }
      const candidatesForPro = generateCandidates(domain, pro.name);
      // All candidates share the same domain → MX already passed →
      // accept the first MAX_ACCEPTED_PER_PRO directly.
      const accepted = candidatesForPro.slice(0, MAX_ACCEPTED_PER_PRO);
      if (accepted.length === 0) { counters.prosSkipped += 1; return; }
      const inserted = await insertEmails(
        client,
        accepted.map((c) => ({
          professional_id: pro.id,
          email: c.email,
          confidence: c.confidence,
        })),
      );
      counters.emailsWritten += inserted;
    }

    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      const batch = queue.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(handlePro));
      if ((i + batch.length) % 100 === 0 || i + batch.length === queue.length) {
        console.log(
          `[pattern-mx] progress ${i + batch.length}/${queue.length} written=${counters.emailsWritten}`,
        );
      }
    }

    console.log(
      `[pattern-mx] done — processed=${counters.prosProcessed} skipped=${counters.prosSkipped} written=${counters.emailsWritten}`,
    );

    return {
      rowsFetched: counters.prosProcessed,
      rowsUpserted: counters.emailsWritten,
      rowsSkipped: counters.prosSkipped,
      metadata: { limit: effectiveLimit },
    };
  });

  return {
    prosProcessed: counters.prosProcessed,
    prosSkipped: counters.prosSkipped,
    emailsWritten: counters.emailsWritten,
  };
}
