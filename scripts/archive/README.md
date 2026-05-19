# Archived one-shot scripts

These scripts ran once (or a few times) to apply the cross-country slug
fix and city seed. They are kept for traceability — none of them is part
of a normal scrape run.

| Script | Used for | Context |
|---|---|---|
| `sprint-0-rpc-loop.mjs` | Backfill `city_country` in chunks via the `backfill_city_country_chunks` RPC | PR #50, Sprint 0 phase 1 |
| `sprint-0-backfill-country.mjs` | Earlier (slower) per-slug variant of the same backfill, kept for reference | PR #50, Sprint 0 phase 1 |
| `sprint-1-regeocode.mjs` | First attempt at re-geocoding A.2 sources from metadata (dry-run by default) | PR #50, Sprint 1 |
| `sprint-1-regeocode-loop.mjs` | v1 of the RPC-loop runner; bailed under load | PR #50, Sprint 1 |
| `sprint-1-regeocode-v2.mjs` | v2 keyset-by-id runner used to finish APEGA/TSASK/CPSNS/COFEPRIS | PR #50, Sprint 1 |
| `sprint-1-address-loop.mjs` | Runner for datos-gob-es/RCDSO/OAQ regeocode via `regeocode_*_v2` RPCs | Sprint B (incomplete; retry in quiet window) |
| `sprint-f-seed-cities.mjs` | Bulk-load 41k cities from GeoNames | PR #51, Sprint F |
| `codemod-add-country.mjs` | Codemod that injected `country: "XX"` into 130 source files | PR #50, Sprint C |
| `audit-city-concentration.mjs` | Read-only audit of the city × category matrix concentrations | pre-PR #50 |

If you need to run them again, copy back to `scripts/` and run with
`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in env.
