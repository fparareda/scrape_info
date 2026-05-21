/**
 * Weekly coverage report — posts a Telegram digest summarising the
 * last 7 days of gmaps-driven coverage growth.
 *
 * Runs Monday 09:00 UTC via .github/workflows/coverage-report.yml.
 *
 * Steps:
 *   1. Refresh `coverage_matrix_city` via RPC.
 *   2. Query last-7d adds from `professionals` (source='google_places')
 *      grouped by country.
 *   3. Top 10 (city, category) pairs by row count, last 7d.
 *   4. Count newly-seeded cities (first google_places row in last 7d).
 *   5. Coverage totals (≥1, ≥3, ≥10 oficios) per country from the
 *      matview.
 *   6. Format a plain-text digest and POST to Telegram (or print on
 *      --dry-run).
 *
 * All SQL lives here — no new migrations. Aggregations are done
 * client-side over paginated PostgREST reads. The
 * `professionals_created_source_idx (created_at DESC, source)` index
 * keeps the 7d range scan cheap.
 *
 * CLI:
 *   tsx src/run-coverage-report.ts            # post to Telegram
 *   tsx src/run-coverage-report.ts --dry-run  # print to stdout
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const COUNTRIES = ["ES", "FR", "MX", "US", "CA"] as const;
type Country = (typeof COUNTRIES)[number];

interface CliArgs {
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  return { dryRun: argv.includes("--dry-run") };
}

function getClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "coverage-report requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function refreshMatview(client: SupabaseClient): Promise<void> {
  console.error("→ refreshing coverage_matrix_city...");
  const t0 = Date.now();
  const { error } = await client.rpc("refresh_coverage_matrix_city");
  if (error) {
    console.error(
      `  ! refresh failed (${error.message}) — proceeding with stale matview`,
    );
    return;
  }
  console.error(`  … refreshed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/**
 * Fetch every `professionals` row inserted in the last 7 days from
 * google_places. We need both city_country and (city_slug, category_key)
 * for the per-country count, top-pair ranking, and "newly seeded city"
 * approximation, so pulling the rows once is simpler than three
 * separate aggregate calls (PostgREST has no GROUP BY).
 *
 * For 7d at current ingest rates this is ~tens of thousands of rows,
 * paginated 1000 at a time. The covering index keeps the scan cheap.
 */
async function fetchLast7dRows(
  client: SupabaseClient,
): Promise<
  Array<{
    city_country: string | null;
    city_slug: string | null;
    category_key: string | null;
    created_at: string;
  }>
> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const PAGE = 1000;
  const out: Array<{
    city_country: string | null;
    city_slug: string | null;
    category_key: string | null;
    created_at: string;
  }> = [];
  // Keyset pagination: walk created_at descending, using the last
  // created_at of each page as the next upper bound. This sidesteps
  // OFFSET deep-pagination cost (PostgREST's 60s statement_timeout
  // killed range(N, N+1000) for high N on the 7d window) and stays
  // on the (created_at DESC, source) index for every page.
  let cursor: string | null = null;
  while (true) {
    let q = client
      .from("professionals")
      .select("city_country, city_slug, category_key, created_at")
      .eq("source", "google_places")
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(PAGE);
    if (cursor) q = q.lt("created_at", cursor);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...(data as typeof out));
    if (data.length < PAGE) break;
    cursor = (data[data.length - 1] as { created_at: string }).created_at;
  }
  return out;
}

/**
 * Approximate "cities newly seeded this week" — for every (country,
 * city_slug) touched in the last 7d, check whether ANY older
 * google_places row exists. If not, the city is newly seeded.
 *
 * We do one tiny HEAD count per candidate pair. Candidates are
 * deduped first so the count stays bounded (~a few hundred per
 * country at most). Each call is an index-only lookup so total
 * runtime is seconds, not minutes.
 */
async function countNewlySeededCities(
  client: SupabaseClient,
  recentRows: Array<{ city_country: string | null; city_slug: string | null }>,
): Promise<Map<string, number>> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const candidates = new Map<string, { country: string; slug: string }>();
  for (const r of recentRows) {
    if (!r.city_country || !r.city_slug) continue;
    const key = `${r.city_country}::${r.city_slug}`;
    if (!candidates.has(key)) {
      candidates.set(key, { country: r.city_country, slug: r.city_slug });
    }
  }
  const result = new Map<string, number>();
  for (const country of COUNTRIES) result.set(country, 0);

  let i = 0;
  for (const { country, slug } of candidates.values()) {
    i++;
    if (i % 100 === 0) {
      console.error(`  · newly-seeded check ${i}/${candidates.size}`);
    }
    const { count, error } = await client
      .from("professionals")
      .select("id", { count: "exact", head: true })
      .eq("source", "google_places")
      .eq("city_country", country)
      .eq("city_slug", slug)
      .lt("created_at", since)
      .limit(1);
    if (error) {
      console.error(
        `  ! newly-seeded check failed for ${country}/${slug}: ${error.message}`,
      );
      continue;
    }
    if ((count ?? 0) === 0) {
      result.set(country, (result.get(country) ?? 0) + 1);
    }
  }
  return result;
}

/**
 * Coverage totals (≥1, ≥3, ≥10 oficios per city) per country.
 *
 * Read from `coverage_matrix_city` (already refreshed). Sum rows per
 * (country, city_slug) and bucket. Paginated; runs in seconds.
 */
async function loadCoverageTotals(client: SupabaseClient): Promise<
  Map<
    string,
    { ge1: number; ge3: number; ge10: number; totalCities: number }
  >
> {
  const byCity = new Map<string, Map<string, number>>(); // country -> slug -> oficio count
  for (const country of COUNTRIES) byCity.set(country, new Map());

  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await (
      client.from("coverage_matrix_city") as any
    )
      .select("city_country, city_slug, category_key, n")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data as Array<{
      city_country: string;
      city_slug: string;
      category_key: string;
      n: number;
    }>) {
      const bucket = byCity.get(row.city_country);
      if (!bucket) continue;
      if (Number(row.n) <= 0) continue;
      bucket.set(row.city_slug, (bucket.get(row.city_slug) ?? 0) + 1);
    }
    if (data.length < PAGE) break;
  }

  const result = new Map<
    string,
    { ge1: number; ge3: number; ge10: number; totalCities: number }
  >();
  for (const country of COUNTRIES) {
    const bucket = byCity.get(country)!;
    let ge1 = 0;
    let ge3 = 0;
    let ge10 = 0;
    for (const oficios of bucket.values()) {
      if (oficios >= 1) ge1++;
      if (oficios >= 3) ge3++;
      if (oficios >= 10) ge10++;
    }
    result.set(country, { ge1, ge3, ge10, totalCities: bucket.size });
  }
  return result;
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function buildDigest(args: {
  weekOf: string;
  addsByCountry: Map<string, number>;
  newCitiesByCountry: Map<string, number>;
  topPairs: Array<{ country: string; slug: string; category: string; n: number }>;
  coverage: Map<
    string,
    { ge1: number; ge3: number; ge10: number; totalCities: number }
  >;
}): string {
  const lines: string[] = [];
  lines.push(`📊 Coverage report — week of ${args.weekOf}`);
  lines.push("");
  // Per-country adds
  const sortedCountries = [...COUNTRIES].sort(
    (a, b) => (args.addsByCountry.get(b) ?? 0) - (args.addsByCountry.get(a) ?? 0),
  );
  let totalAdds = 0;
  let totalNewCities = 0;
  for (const c of sortedCountries) {
    const adds = args.addsByCountry.get(c) ?? 0;
    const newCities = args.newCitiesByCountry.get(c) ?? 0;
    totalAdds += adds;
    totalNewCities += newCities;
    lines.push(
      `${c}: +${fmtInt(adds)} pros (${fmtInt(newCities)} new cities seeded)`,
    );
  }
  lines.push("");
  lines.push(
    `Total: +${fmtInt(totalAdds)} pros, ${fmtInt(totalNewCities)} new cities`,
  );
  lines.push("");

  // Top pairs
  lines.push("Top growth (city × category):");
  if (args.topPairs.length === 0) {
    lines.push("  (no rows in the last 7d)");
  } else {
    args.topPairs.forEach((p, i) => {
      lines.push(
        `  ${i + 1}. ${p.country} ${p.slug} × ${p.category}: +${fmtInt(p.n)} rows`,
      );
    });
  }
  lines.push("");

  // Coverage by country
  lines.push("Coverage by country (≥1 / ≥3 / ≥10 oficios / total cities):");
  for (const c of COUNTRIES) {
    const cov = args.coverage.get(c);
    if (!cov) continue;
    lines.push(
      `  ${c}: ${fmtInt(cov.ge1)} / ${fmtInt(cov.ge3)} / ${fmtInt(cov.ge10)} / ${fmtInt(cov.totalCities)}`,
    );
  }
  return lines.join("\n");
}

async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error(
      "coverage-report send requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID",
    );
  }
  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
    },
  );
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
  };
  if (!json.ok) {
    throw new Error(
      `Telegram sendMessage failed: ${res.status} ${json.description ?? "unknown"}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();

  await refreshMatview(client);

  console.error("→ fetching last-7d google_places rows...");
  const t1 = Date.now();
  const recent = await fetchLast7dRows(client);
  console.error(
    `  … ${recent.length} rows in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
  );

  // Per-country adds.
  const addsByCountry = new Map<string, number>();
  for (const c of COUNTRIES) addsByCountry.set(c, 0);
  for (const r of recent) {
    if (!r.city_country) continue;
    addsByCountry.set(
      r.city_country,
      (addsByCountry.get(r.city_country) ?? 0) + 1,
    );
  }

  // Top 10 pairs.
  const pairCounts = new Map<
    string,
    { country: string; slug: string; category: string; n: number }
  >();
  for (const r of recent) {
    if (!r.city_country || !r.city_slug || !r.category_key) continue;
    const key = `${r.city_country}::${r.city_slug}::${r.category_key}`;
    const cur = pairCounts.get(key);
    if (cur) cur.n++;
    else
      pairCounts.set(key, {
        country: r.city_country,
        slug: r.city_slug,
        category: r.category_key,
        n: 1,
      });
  }
  const topPairs = [...pairCounts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 10);

  console.error("→ counting newly-seeded cities...");
  const newCitiesByCountry = await countNewlySeededCities(client, recent);

  console.error("→ loading coverage totals from matview...");
  const coverage = await loadCoverageTotals(client);

  const weekOf = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const digest = buildDigest({
    weekOf,
    addsByCountry,
    newCitiesByCountry,
    topPairs,
    coverage,
  });

  if (args.dryRun) {
    console.log(digest);
    console.error("\n[dry-run] — not sending to Telegram");
    return;
  }

  await sendTelegram(digest);
  console.error("✓ digest sent to Telegram");
}

main().catch((err) => {
  console.error("[coverage-report] fatal:", err);
  process.exit(1);
});
