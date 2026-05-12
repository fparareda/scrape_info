#!/usr/bin/env node
/**
 * Telegram connectivity probe.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/ping-telegram.mjs
 *   npm run ping:telegram
 *
 * 1. getMe       — validates the bot token (returns bot username + id).
 * 2. sendMessage — proves the bot can reach the configured chat_id.
 *
 * Exits non-zero on any failure so it can be used as a CI gate.
 */

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.error(
    "[ping-telegram] missing env: " +
      [!token && "TELEGRAM_BOT_TOKEN", !chatId && "TELEGRAM_CHAT_ID"]
        .filter(Boolean)
        .join(", "),
  );
  process.exit(2);
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const me = await tg("getMe");
if (!me.json.ok) {
  console.error("[ping-telegram] getMe failed:", me.status, me.json);
  process.exit(1);
}
console.log(
  `[ping-telegram] token OK — bot @${me.json.result.username} (id=${me.json.result.id})`,
);

const now = new Date().toISOString();
const send = await tg("sendMessage", {
  chat_id: chatId,
  text: `🟢 ping from scrape_info — ${now}`,
  disable_web_page_preview: true,
});
if (!send.json.ok) {
  console.error("[ping-telegram] sendMessage failed:", send.status, send.json);
  process.exit(1);
}
console.log(
  `[ping-telegram] sent to chat ${chatId} — message_id=${send.json.result.message_id}`,
);
