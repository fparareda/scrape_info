/**
 * Minimal wrapper around runEmailExtractor. Called from index.ts when
 * PROLIO_RUN_EMAIL_EXTRACTOR=true. Supports:
 *   - PROLIO_EMAIL_EXTRACTOR_LIMIT=<n>   (default 500)
 *   - PROLIO_EMAIL_EXTRACTOR_IDS=<uuid,uuid,…>   (force these pros only)
 */

import { createClient } from "@supabase/supabase-js";
import { runEmailExtractor } from "./sources/email-extractor.js";
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

export async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Email extractor needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const limit = parseLimit(process.env.PROLIO_EMAIL_EXTRACTOR_LIMIT);
  const professionalIds = parseIds(process.env.PROLIO_EMAIL_EXTRACTOR_IDS);

  const result = await runEmailExtractor(db, { limit, professionalIds });

  if (result.newEmails > 0) {
    await sendScraperAlert(
      "high",
      `📧 Email extractor — ${result.newEmails} nuevos`,
      `Batch: ${result.scraped} scraped, ${result.found} pros with emails, ${result.newEmails} rows inserted`,
      "emails",
    );
  }
}
