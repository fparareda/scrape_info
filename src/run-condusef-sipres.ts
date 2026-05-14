/**
 * Standalone entry point for CONDUSEF SIPRES.
 *
 * Wired here (instead of via src/index.ts + _scrape-runner.yml) because
 * the source landed after the main runner was frozen for this PR.
 *
 *   Run: PROLIO_RUN_CONDUSEF_SIPRES=true tsx src/run-condusef-sipres.ts
 */

import { runCondusefSipres } from "./sources/condusef-sipres.js";

async function main(): Promise<void> {
  // Force-enable for this entry point. The env flag still gates inner
  // logic so unit tests / dry runs can opt out by unsetting it.
  process.env.PROLIO_RUN_CONDUSEF_SIPRES =
    process.env.PROLIO_RUN_CONDUSEF_SIPRES ?? "true";
  const result = await runCondusefSipres();
  console.log(
    `[condusef-sipres] done fetched=${result.fetched} inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped}`,
  );
}

main().catch((err) => {
  console.error("[condusef-sipres] fatal", err);
  process.exit(1);
});
