/**
 * Scraper-side Telegram alerting. Mirrors apps/web/lib/alerts/telegram.ts
 * — separate file because scraper is its own package and can't import
 * the `server-only` web helper.
 *
 * Env: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
 * No-ops silently when either is missing (local dev).
 */

export type Severity = "critical" | "high" | "warn";

const LEVEL_PREFIX: Record<Severity, string> = {
  critical: "🔴 CRITICAL",
  high: "🟠 HIGH",
  warn: "🟡 WARN",
};

export async function sendScraperAlert(
  severity: Severity,
  title: string,
  body?: string,
  tag = "scraper",
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const text =
    `${LEVEL_PREFIX[severity]} — ${title} #${tag}` +
    (body ? `\n\n${body}` : "");
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // Alerts must never break a scrape.
  }
}
