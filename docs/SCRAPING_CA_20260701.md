# CA Scraper Research — 2026-07-01

## Selected source: saa-sk-architects

**Authority:** Saskatchewan Association of Architects (SAA)
**URL (PDF register):** https://saskarchitects.com/wp-content/uploads/2026/06/SAA-Member-Register-June-2026.pdf
**Discovery page:** https://saskarchitects.com/public-resources/member-directory/
**Category:** `arquitecto`
**Province:** SK (primary), plus reciprocal registrants across ON/AB/MB/BC/QC/NS and some US states
**Estimated records:** 536 "Registered Members" rows (Last Name, First Name, Firm, City, Prov)

### Gap context

Existing CA architect coverage before this PR: `maa-architects` (Manitoba Association of
Architects — CA-wide roster, ~700-800 members), `oaa` (Ontario, Sucuri-WAF cookie dance),
`oaq` (Quebec, WP-JSON API). Saskatchewan was not yet covered. Alberta's AAA member
directory (aaa.ab.ca) was investigated first but rejected — see below.

### Candidates investigated

1. **AAA — Alberta Association of Architects** (`aaa.ab.ca/web/Web/Public_Resources/Member_Directory.aspx`)
   — SKIPPED. robots.txt allows the path (Disallow only covers `/AsiCommon/`,
   `/iMisService`, etc. — classic iMIS install). Initial GET succeeds (HTTP 200,
   plain curl UA, Cloudflare present but not challenging). However this is an
   iMIS **ContentManager WebParts** search form (`ciDirectory` webpart), a
   different flavor from the simple ASP.NET grid our `_imis-utils.ts` targets.
   Submitting the empty-search POST (with `__VIEWSTATE`/`__EVENTVALIDATION`/
   `__RequestVerificationToken` copied from the GET) returned an ASP.NET 500
   redirect (`/500.aspx?aspxerrorpath=...`), likely due to anti-forgery token /
   session-cookie mismatch requiring a persistent cookie jar across GET→POST
   that a quick curl test doesn't replicate perfectly. Fixing this reliably
   would require more request/response round-trips than the research budget
   allowed. Not a WAF/CAPTCHA block — just not solved in time. Worth revisiting
   with a dedicated iMIS ContentManager adapter in a future PR.

2. **NSRP — Nova Scotia Regulator of Psychology** (`ns-rp.ca/directory/`)
   — SKIPPED. robots.txt allows it (`Allow: /` for `*`). Page loads fine
   (WordPress, HTTP 200) but Nova Scotia is a small province — the psychologist
   registrant count is well under the 500-record threshold (NS total
   population ~1M, comparable colleges list a few hundred registrants at
   most). Did not pursue further once the AAA and SAA candidates panned out.

3. **SAA — Saskatchewan Association of Architects** — SELECTED (see below).

### robots.txt audit (saskarchitects.com)

```
User-agent: *
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php
```

The PDF lives under `/wp-content/uploads/...` — not disallowed. Single static
file fetch, no crawling/pagination needed.

### Data format

Server-served static PDF (`content-type: application/pdf`, 10 pages, ~216 KB).
Table columns: `LAST NAME | FIRST NAME | FIRM/LICENCE TO PRACTICE | CITY | PROV`.
Two sections: "REGISTERED MEMBERS" (licensed architects — the ones we ingest)
and "SYLLABUS STUDENTS" (excluded — not licensed practitioners). Extracted with
row-level regex text parsing (pdf-parse) since the underlying table has no
embedded structure beyond whitespace-aligned text-extraction order.

### Record count

- Total "REGISTERED MEMBERS" rows (2026-06 snapshot): 536
- Province breakdown: SK 142, ON 126, AB 110, MB 47, BC 41, QC 10, NS 5,
  + assorted US states (TX, WA, MN, OH, MO, AZ, NY, OR, ND, AR, FL, GA, CO, NE)
  reciprocal/non-resident registrants (~64 total)
- After filtering to CA provinces: ~481 records; we ingest all 536 rows and
  let city/geo mapping fall back to a default for non-Canadian entries (they
  are dropped downstream by the sink's country/city validation, consistent
  with how `maa-architects` handles the same "CA-wide + some foreign" shape).

### Viability checklist

| Check | Result |
|---|---|
| robots.txt | Allowed (`/wp-content/uploads/` not disallowed) |
| Login required | No |
| CAPTCHA / Cloudflare / WAF | No (plain nginx + WordPress, no challenge) |
| JS-only SPA | No — static PDF, no JS needed |
| Record count | 536 (>= 500) |
| Maps to CategoryKey | Yes — `arquitecto` |

### Pre-flight notes

- The PDF filename is dated (`SAA-Member-Register-June-2026.pdf`); the SAA
  publishes an updated file periodically (last-modified 2026-06-25 as of this
  writing). The scraper resolves the current file URL at runtime by fetching
  the discovery page (`/public-resources/member-directory/`) and following the
  first link matching `SAA-Member-Register-*.pdf`, so it stays robust across
  monthly re-publications without hardcoding a dated filename.
- Only one PDF file fetch + one HTML discovery fetch per run (2 HTTP requests
  total) — well within polite-crawl budget.
- Schedule: monthly cron (slow-changing professional register).
