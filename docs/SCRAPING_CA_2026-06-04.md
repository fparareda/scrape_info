# CA Scraper Pre-flight — 2026-06-04

**Result: BUILT — `apegnb-nb-engineers` (APEGNB NB ~6,901 engineers, `ingenieria`)**

## Candidates evaluated

| Source | URL | Status |
|--------|-----|--------|
| **APEGNB NB Engineers** | myapegnb.apegnb.com | ✅ BUILT |
| CPA Ontario | cpaontario.ca | ⛔ Cloudflare 403 on entire domain |
| NSVMA NS Vets (PDF) | nsvma.ca/official-register | ⚠️ 676 records in PDF (borderline; PDF font issues) |
| EGBC BC Engineers | egbc.ca | Not fully verified |

## APEGNB pre-flight findings (2026-06-04)

- **robots.txt**: Only Disallows calendar patterns (`/calendar/action~*/`). Path `/Registry/`
  is allowed. No Cloudflare, no CAPTCHA, no login required.
- **Server**: Apache / ASP.NET WebForms + Telerik RadGrid controls.
- **Public registry notice**: "APEGNB PUBLIC REGISTRY — contains the names of all persons
  and entities who are currently registered with APEGNB."
- **Access method**: blank form POST → VIEWSTATE/EVENTVALIDATION round-trip; Telerik
  RadGrid pagination via `__doPostBack(gridClientId, 'Page$N')`.
- **Record count**: 6,901 items in 346 pages at 20/page; ~138 pages at 50/page.
- **Row data**: Name, Designation (P.Eng./P.Geo./E.I.T.), Status, Valid Until, Member ID.
  City is on the detail page (`/Registry/Member-Details.aspx?ID={id}`); detail pages are
  not fetched in the current implementation (adds ~1.9h at 1 req/s for 6,901 rows).
  City defaults to `fredericton` (provincial capital) for all rows in v1.
- **No phone/email** on public registry pages (by design — APEGNB privacy policy).

## Implementation notes

- Category: `ingenieria` — NB engineers + geoscientists, country `CA`, province `NB`
- Telerik grid client ID is auto-discovered from first-page pager link regex
- City default: `fredericton` (v1 — all rows). Future: fetch detail pages for top N
  to populate city from actual member data (opt-in via env var).
- Monthly cron: NB licences renew annually.
- Cap: `PROLIO_APEGNB_LIMIT=8000` (covers full 6,901 roll)

## First-run checklist

On first run with `PROLIO_RUN_APEGNB_NB_ENGINEERS=true`, verify:
1. VIEWSTATE bundle is extracted (`[apegnb] totalCount=6901 gridClientId=...` in logs)
2. Rows parse correctly (`[apegnb] parsed=6901 total`)
3. After status filter (`Entitled to Practice`), row count should be ~5,000–6,500
4. Upserted count lands in expected range

If `gridClientId` is `(not found)`: inspect actual `__doPostBack` call in the HTML and
update the `extractGridClientId` regex in `apegnb-nb-engineers.ts`.

If `parsed=0`: the `rgRow`/`rgAltRow` CSS class names may differ — inspect actual `<tr>`
attributes and update `parseRows` accordingly.
