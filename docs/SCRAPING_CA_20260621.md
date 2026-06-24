# Canada scraper scout — 2026-06-21

## Summary

**Winner**: CPABC Member Directory — Chartered Professional Accountants of BC.
First `fiscal` source for Canada. Implemented as `src/sources/cpabc-bc-cpa.ts`.

## Candidates evaluated

### 1. CPABC Member Directory ✅ WINNER

- **Category**: `fiscal`
- **URL**: https://services.bccpa.ca/Directory/Directory/CPABC_Directory_Search.aspx
- **Records**: ~40,000 CPA members + ~6,000 CPA candidates in BC
- **robots.txt**: `services.bccpa.ca/robots.txt` disallows `/App_Browsers/`,
  `/AsiCommon/`, `/iParts/`, `/Layouts/` etc. The path `/Directory/Directory/`
  is NOT disallowed. ✓
- **Auth**: One-click checkbox user agreement (`BC_User_Agreement.aspx`) — no
  account/registration required. Session cookie from accepting the agreement.
- **WAF**: None detected. ASP.NET WebForms, server-rendered HTML.
- **Enumeration**: POST with last-name prefix A–Z to `CPABC_Directory_Search.aspx`.
  ~50 rows/page; paginate via `__doPostBack` pattern.
- **Implementation**: `src/sources/cpabc-bc-cpa.ts`
- **Workflow**: `.github/workflows/scrape-cpabc-bc-cpa.yml` (monthly, 10th)
- **Flag**: `PROLIO_RUN_CPABC_BC_CPA=true`

### 2. CPA Ontario Member Directory

- **Category**: `fiscal`
- **URL**: https://www.cpaontario.ca/protecting-the-public/directories/member
- **Records**: ~105,000 members
- **Verdict**: ❌ BLOCKED — Cloudflare WAF returns HTTP 403 from all datacenter
  IPs. No bypass path available without residential proxy.

### 3. CPA Alberta Member Verification

- **Category**: `fiscal`
- **URL**: https://services.cpaalberta.ca/VerifyEntity/Members/
- **Records**: ~28,500 members
- **Verdict**: ❌ NO ENUMERATION — form requires exact last-name match with no
  wildcard support. Cannot enumerate all members systematically.

### 4. CPA Manitoba, Saskatchewan, Nova Scotia

- **Verdict**: ❌ HTTP 403 on all fetch attempts from datacenter IP.

### 5. CPAB Participating Audit Firms

- **Category**: `fiscal`
- **URL**: https://www.cpab-ccrc.ca/registration/participating-audit-firms
- **Records**: 223 firms
- **Verdict**: ❌ BELOW THRESHOLD — only 223 records (minimum 500 required).

### 6. Skilled Trades Ontario (fontaneria/plumbing)

- **URL**: https://services.skilledtradesontario.ca/STOportal/app/public-search
- **Verdict**: ❌ HTTP 404 — the public register portal endpoint appears to have
  moved or been removed. Secondary priority to the fiscal gap anyway.

## Rationale

Canada had zero `fiscal` sources before this run. CPABC is the first CPA
directory that satisfies all criteria (≥500 records, no WAF, server-rendered,
no real authentication). With 40k members it is the second-largest provincial
CPA body after Ontario (blocked by Cloudflare).

Other provinces should be revisited periodically as their WAF configurations
may change.
