/**
 * Deep-crawler runner. Fires from index.ts when
 * PROLIO_RUN_EMAIL_CRAWLER=true.
 *
 * Envs:
 *   - PROLIO_EMAIL_CRAWLER_LIMIT=<n>   (default 100 pros/run)
 *   - PROLIO_EMAIL_CRAWLER_IDS=<uuid,…>  (force these pros only)
 */

import { createClient } from "@supabase/supabase-js";
import { runEmailCrawler, type EmailCrawlerResult } from "./sources/email-crawler.js";
import { sendScraperAlert } from "./alerts.js";

function parseIds(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function main(): Promise<EmailCrawlerResult | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Email crawler needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const limit = parseLimit(process.env.PROLIO_EMAIL_CRAWLER_LIMIT);
  const professionalIds = parseIds(process.env.PROLIO_EMAIL_CRAWLER_IDS);

  const result = await runEmailCrawler(db, { limit, professionalIds });

  if (result.newEmails > 0) {
    await sendScraperAlert(
      "high",
      `🕸️ Email crawler — ${result.newEmails} nuevos`,
      `Crawled ${result.crawled} sites · ${result.pagesFetched} pages · ${result.prosWithEmails} pros with emails · ${result.newEmails} rows inserted · ${result.igHandlesDetected} IG handles · ${result.failures} failures`,
      "crawler",
    );
  }
  return result;
}
