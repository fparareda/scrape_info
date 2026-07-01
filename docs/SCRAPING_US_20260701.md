# US Scraper Research — 2026-07-01

## Summary

Read prior research docs (`SCRAPING_US_20260615.md`, `SCRAPING_US_2026-06-13.md`,
`SCRAPING_US_20260612.md`, and grepped all other `docs/SCRAPING_US_*.md`) and the
full `src/sources/` listing before researching, to avoid re-treading already
rejected candidates. Dozens of state licensing-board candidates (South Carolina
LLR, Utah DOPL, New Mexico RLD, West Virginia CLB, Montana DLIBSD, Mississippi
MSBOC, Wyoming boards, Hawaii MyPVL, Kansas, Idaho, Alaska CBPL, Oklahoma CIB,
Arkansas CLB) have already been thoroughly investigated and rejected across the
2026-05-13 through 2026-06-15 passes for robots.txt blocks, WAF/bot-detection,
login walls, paid-only access, or JS-only SPAs. Rather than re-probe those dead
ends, this pass looked for a **category gap** instead of a **state gap**.

### Category-coverage audit

Counted `categoryKey` usage across all `src/sources/*.ts` files. The thinnest
CategoryKey values overall were `itv` (21 occurrences) and `cerrajero` (20),
`notario` (19), and `extranjeria` (13). Checked which of the `itv`-mapped
sources are US-specific: **none** — all existing `itv` sources are Spain (DGT,
RASIC, RII) or Mexico (verification centers, SIEM) sources. No US source maps
any dataset to `itv` (vehicle inspection) yet. That's the fresh gap.

---

## Candidate Evaluated

### New York State DMV — Vehicle Inspection Stations (Socrata)

- **Host:** `data.ny.gov` (Socrata), dataset "Facilities Licensed by the DMV",
  view ID `nhjr-rpi2` — the SAME underlying dataset already partially used by
  the existing `ny-dmv-repair-shops.ts` source (which filters
  `business_type=RS` for `mecanica`).
- **New slice used:** `business_type in ('ISP','ISD','ISF')` — Inspection
  Station Private / Dealer / Fleet. These are NYS DMV-licensed vehicle safety
  inspection stations, the direct US analogue of Spain's `itv` category.
- **No overlap with `ny-dmv-repair-shops`:** that source only pulls
  `business_type=RS`; this candidate pulls `ISP`/`ISD`/`ISF` — mutually
  exclusive business_type codes within the same 55k-row dataset, verified via
  a Socrata `$group=business_type` count query.

#### Pre-flight checklist

| Check | Result |
|---|---|
| robots.txt allows fetch path | Yes — `data.ny.gov/robots.txt` disallows only `/api/odata/` and `/api/collocate*`; `/resource/` (the SODA JSON API path used) is not mentioned anywhere in the Disallow list. `Crawl-delay: 1` honoured via paged $limit/$offset requests. |
| No JS-only SPA | Yes — plain Socrata JSON REST API (SODA), no browser rendering required |
| ≥500 records | Yes — 10,955 total (see counts below), well above floor |
| No Cloudflare/WAF/CAPTCHA/login | Yes — public anonymous GET, confirmed via `curl` |
| Maps to existing CategoryKey | Yes — `itv` (vehicle inspection stations) |

#### Verified record counts (2026-07-01, via `$select=business_type,count(*)&$group=business_type`)

| business_type | Meaning | Count |
|---|---|---|
| ISP | Inspection Station — Private | 10,408 |
| ISD | Inspection Station — Dealer | 326 |
| ISF | Inspection Station — Fleet | 221 |
| **Total (itv)** | | **10,955** |

(For reference, full dataset is 55,133+ rows across 21 business_type codes;
`RS` = 18,268 repair shops already claimed by `ny-dmv-repair-shops`.)

#### Sample row (business_type=ISP)

```json
{
  "facility": "2310115",
  "facility_name": "A 1 ALL GERMAN CAR",
  "facility_street": "400 W 219 ST",
  "facility_city": "NEW YORK",
  "facility_state": "NY",
  "facility_zip_code": "10034",
  "owner_name": "VAN BISHKOFF",
  "business_type": "ISP",
  "expiration_date": "03/31/2021"
}
```

**Result: SELECTED**

---

## Implementation

- Source file: `src/sources/ny-dmv-inspection-stations.ts`
- Pattern: mirrors `src/sources/ny-dmv-repair-shops.ts` almost exactly (same
  host/dataset, paged SODA JSON fetch, `normalise()` + `slugify()` for city,
  `getSink().upsert()`), with the `$where=business_type in(...)` filter swapped
  and `categoryKey` set to `itv` instead of `mecanica`.
- `ScrapeSource` union: added `"ny-dmv-inspection-stations"` to `src/types.ts`.
- Wired in `src/index.ts` at the 4 standard touch points (import, `*On` enabled
  flag, early-exit gating `!nyDmvInspectionStationsOn`, exec/dispatch tuple).
- Env flag: `PROLIO_RUN_NY_DMV_INSPECTION_STATIONS=true` (off by default).
- Limit cap: `PROLIO_NY_DMV_INSPECTION_STATIONS_LIMIT` (default 20,000 — covers
  the full ~10,955-row target with headroom).
- Workflow runner mapping added to `.github/workflows/_scrape-runner.yml`.
- New cron file: `.github/workflows/scrape-ny-dmv-inspection-stations.yml` —
  monthly (7th of month, 08:00 UTC; offset by a day from
  `scrape-ny-dmv-repair-shops.yml`'s 6th-of-month slot since both hit the same
  dataset/host and a license-registry snapshot like this changes slowly).
- `npm run typecheck` passes clean.
