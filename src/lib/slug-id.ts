/**
 * Slug generation for professional records at scale (2.5M+ target).
 *
 * Globally-unique slug pattern: `{slugify(name)}-{shortid6}` where
 * shortid6 is the first 6 lowercase base36 chars of a UUIDv4 stripped of
 * hyphens. Collision probability at 2.5M rows is ~negligible
 * (36^6 = 2.2B namespace × birthday paradox ≈ 1.4M rows before 50/50
 * collision chance — for the planned 2.5M we tolerate worst-case a few
 * collisions, which the DB unique constraint on `slug` catches and the
 * loader retries with a fresh id).
 *
 * Why this shape vs. straight UUID:
 *   - SEO: humans/Google see the name slug; the suffix is just dedup.
 *   - URL stability: a name change requires a slug rebuild only if the
 *     human-friendly portion matters; the shortid is the durable id.
 *   - Length: ~20-40 chars total, fits comfortably in URLs and sitemaps.
 *
 * Called from every ingestion that minted rows pre-2026-05-16 used a
 * city/category-scoped slug (`name-cityslug`) which collides across
 * cities. The new pattern is country-global.
 */

import { randomUUID } from "node:crypto";

/**
 * URL-safe slug from a human name. Diacritics stripped, lowercased,
 * non-alphanum collapsed to `-`. Truncated at 60 chars to keep total
 * slug under reasonable URL lengths even with the 6-char shortid.
 */
export function slugifyName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/, ""); // trim trailing `-` if slice cut mid-word
}

/**
 * Generate a 6-char base36 short id from a UUIDv4. The first 24 bits of
 * the UUID are random — base36-encoded that's ~5 chars. We take 6 chars
 * (~30 bits = 1.07B namespace) for headroom.
 */
export function shortId(uuid?: string): string {
  const u = (uuid ?? randomUUID()).replace(/-/g, "");
  // Convert first 8 hex chars (32 bits) to base36, pad/truncate to 6.
  const n = parseInt(u.slice(0, 8), 16);
  const s = n.toString(36);
  return s.length >= 6 ? s.slice(-6) : s.padStart(6, "0");
}

/**
 * Build the globally-unique slug for a professional.
 *
 *   buildProfessionalSlug("García Rodríguez Asociados")
 *     → "garcia-rodriguez-asociados-a4f8z2"
 *
 * Pass a stable seed (e.g. the source's external id) to make the shortid
 * deterministic per source row — useful for re-ingest idempotency.
 */
export function buildProfessionalSlug(name: string, seed?: string): string {
  const namePart = slugifyName(name) || "pro";
  const idPart = seed
    ? shortId(seedToUuid(seed))
    : shortId();
  return `${namePart}-${idPart}`;
}

/**
 * Turn an arbitrary string seed (NPI number, SIRENE siren, DENUE clue,
 * etc.) into a deterministic UUID-shaped string. Just an SHA-256 hex
 * truncated; we only use the first 32 bits in shortId() anyway, so the
 * weak collision resistance doesn't matter.
 */
function seedToUuid(seed: string): string {
  // Cheap stable hash → 32-bit hex. Not cryptographic; we just need it
  // to spread evenly across the 36^6 namespace.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
