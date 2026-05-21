// Shared .env.local parser for bulk-ingest scripts.
// Looks up keys from process.env first, then falls back to .env.local at the
// repo root. Never hardcodes credentials.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// scripts/bulk-ingest/_lib → repo root
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const ENV_PATH = resolve(REPO_ROOT, ".env.local");

let cached = null;

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes("=") || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    out[k] = v;
  }
  return out;
}

export function loadEnv() {
  if (cached) return cached;
  const fileEnv = parseEnvFile(ENV_PATH);
  cached = new Proxy({}, {
    get(_, key) {
      return process.env[key] ?? fileEnv[key];
    },
  });
  return cached;
}

export function requireSupabase() {
  const env = loadEnv();
  const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local",
    );
    process.exit(1);
  }
  return { SUPABASE_URL, SERVICE_KEY };
}

export { REPO_ROOT };
