/**
 * Colegio ↔ Google Places cross-match.
 *
 * The marketing plan the team approved wants pros whose data came from
 * a colegio (only name + licence — no contact) to inherit phone/address/
 * rating/etc. from a matching Google Places entry in the same city. The
 * sink already keeps rows keyed by (source, source_id) distinct, so
 * this job doesn't collapse them — it fills the colegio row's contact
 * fields in place.
 *
 * Matching strategy (deterministic, no ML):
 *   1. Block by (categoryKey, citySlug) so we never compare across cities.
 *   2. Normalise both names: lowercase, strip accents, strip titles
 *      (Dr/Dra/Lic/Col·legiat), collapse whitespace.
 *   3. Score candidates with Jaro-Winkler.
 *   4. ≥0.92 → auto-merge. 0.80-0.92 → record to `events` for manual review.
 *   5. <0.80 → drop.
 *
 * Enabled via PROLIO_RUN_CROSSMATCH=true.
 */

import { createClient } from "@supabase/supabase-js";

const AUTO_MERGE_THRESHOLD = 0.92;
const REVIEW_THRESHOLD = 0.80;

interface Pro {
  id: string;
  name: string;
  category_key: string;
  city_slug: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  review_count: number | null;
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normaliseName(raw: string): string {
  return stripAccents(raw)
    .toLowerCase()
    .replace(/\b(dr|dra|lic|col·legiat|colegiado|sr|sra|d\.|dña\.)\s*/gi, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaro-Winkler similarity. Returns 0..1. */
function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);
    for (let j = start; j < end; j += 1) {
      if (s2Matches[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let t = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i += 1) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k += 1;
    if (s1[i] !== s2[k]) t += 1;
    k += 1;
  }
  const transpositions = t / 2;
  const jaro =
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions) / matches) /
    3;
  // Jaro-Winkler bonus for common prefix (up to 4 chars).
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i += 1) {
    if (s1[i] === s2[i]) prefix += 1;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

export async function runCrossMatch(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Cross-match needs Supabase env vars");
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Load colegio pros with missing contact fields.
  const { data: sparse, error: sparseErr } = await db
    .from("professionals")
    .select(
      "id, name, category_key, city_slug, phone, email, website, address, lat, lng, rating, review_count",
    )
    .eq("source", "colegio")
    .eq("is_published", true)
    .is("phone", null)
    .limit(5000);
  if (sparseErr) throw sparseErr;
  if (!sparse || sparse.length === 0) {
    console.log("[cross-match] no sparse colegio rows to enrich");
    return;
  }

  // Group candidates by (category, city) so we only compare within block.
  const blocks = new Map<string, Pro[]>();
  for (const row of sparse as unknown as Pro[]) {
    const k = `${row.category_key}::${row.city_slug}`;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k)!.push(row);
  }

  let autoMerged = 0;
  let queuedForReview = 0;
  let scanned = 0;

  for (const [blockKey, sparseRows] of blocks) {
    const [categoryKey, citySlug] = blockKey.split("::");
    const { data: rich, error: richErr } = await db
      .from("professionals")
      .select(
        "id, name, category_key, city_slug, phone, email, website, address, lat, lng, rating, review_count",
      )
      .eq("source", "google_places")
      .eq("category_key", categoryKey)
      .eq("city_slug", citySlug)
      .eq("is_published", true)
      .limit(1000);
    if (richErr) {
      console.error(`[cross-match] block ${blockKey} skipped:`, richErr.message);
      continue;
    }
    if (!rich || rich.length === 0) continue;

    for (const s of sparseRows) {
      scanned += 1;
      const sNorm = normaliseName(s.name);
      let bestScore = 0;
      let bestCandidate: Pro | null = null;
      for (const g of rich as unknown as Pro[]) {
        const score = jaroWinkler(sNorm, normaliseName(g.name));
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = g;
        }
      }
      if (!bestCandidate || bestScore < REVIEW_THRESHOLD) continue;

      if (bestScore >= AUTO_MERGE_THRESHOLD) {
        // Merge: copy contact fields onto the colegio row. Keep the
        // row's own license_number (trust signal from the colegio).
        const patch = {
          phone: bestCandidate.phone,
          email: bestCandidate.email ?? null,
          website: bestCandidate.website ?? null,
          address: bestCandidate.address ?? null,
          lat: bestCandidate.lat ?? null,
          lng: bestCandidate.lng ?? null,
          rating: bestCandidate.rating ?? null,
          review_count: bestCandidate.review_count ?? null,
        };
        const { error: updErr } = await db
          .from("professionals")
          .update(patch)
          .eq("id", s.id);
        if (updErr) {
          console.error(
            `[cross-match] update ${s.id} failed:`,
            updErr.message,
          );
        } else {
          autoMerged += 1;
        }
      } else {
        // Queue for manual review via events table.
        await db.from("events").insert({
          type: "cross_match_review",
          metadata: {
            sparse_id: s.id,
            candidate_id: bestCandidate.id,
            sparse_name: s.name,
            candidate_name: bestCandidate.name,
            score: bestScore,
            category_key: categoryKey,
            city_slug: citySlug,
          },
        });
        queuedForReview += 1;
      }
    }
  }

  console.log(
    `[cross-match] scanned=${scanned} auto_merged=${autoMerged} review_queued=${queuedForReview}`,
  );
}

export function crossMatchEnabled(): boolean {
  return process.env.PROLIO_RUN_CROSSMATCH === "true";
}
