# CA Scraper Pre-flight — 2026-06-08

Research date: 2026-06-08. Investigated four priority CA province+category gaps.

---

## 1. CPSS — College of Physicians and Surgeons of Saskatchewan (medicina, SK)

**URL:** https://www.cps.sk.ca/  
**robots.txt:** `https://www.cps.sk.ca/robots.txt` — blocks ClaudeBot and several AI crawlers explicitly (`Disallow:` for named bots). The policy references EU Directive 2019/790 and lists ClaudeBot in the disallowed agents.  
**Directory:** iMIS-hosted at `https://www.cps.sk.ca/imis/PhysicianSearch`. All attempted fetches to `cps.sk.ca/imis/*` return **HTTP 403 Forbidden** from datacenter IPs.  
**Verdict:** BLOCKED — robots.txt disallows ClaudeBot; server also 403s on datacenter IPs.

---

## 2. Alberta College of Pharmacy (ACP) — (farmacia, AB)

**URL:** https://abpharmacy.ca/  
**robots.txt:** `https://abpharmacy.ca/robots.txt` — permissive (`User-agent: *`), only disallows `/wp-admin/` and one upload directory. No AI-specific restrictions.  
**Directory:** The public pharmacist search is embedded in the "For the public" WordPress page (`https://abpharmacy.ca/for-the-public/`) as inline form widgets. No separate directory URL was discoverable via fetch or search. The myACP portal at `https://webnew-myacp.abpharmacy.ca/` timed out (60s). No JSON API endpoint found.  
**Verdict:** SKIPPED — no scrapeable public register URL identifiable without a residential proxy or Playwright; pharmacy search appears fully embedded in a JS-rendered WordPress widget.

---

## 3. Law Society of Manitoba (LSM) — (abogado, MB)

**URL:** https://lawsociety.mb.ca/  
**robots.txt:** `https://lawsociety.mb.ca/robots.txt` — permissive, only disallows `/wp-admin/` and `/wp-login.php`.  
**Directory:** Lawyer lookup at `https://portal.lawsociety.mb.ca/lookup/`. The portal appears to be a custom PHP application (not iMIS/Alinity). Attempts to GET the lookup with query parameters returned an interface description but no structured HTML table. The `?page=public_lawyerlookup` path requires member portal login. No JSON API endpoint or known URL parameter scheme found via search.  
**Verdict:** SKIPPED — custom portal with unclear scraping path; no JSON API or structured HTML table discoverable without browser automation.

---

## 4. College of Physiotherapists of Alberta (CPTA) — (fisioterapia, AB) ✓ SELECTED

**URL:** https://www.cpta.ab.ca/ → public register at https://cpta.alinityapp.com/client/publicdirectory  
**robots.txt:** `https://www.cpta.ab.ca/robots.txt` — permissive, only disallows `/admin/` and `/django-admin/`. No AI restrictions. The Alinity subdomain `cpta.alinityapp.com` returns 404 for robots.txt (no restrictions).  
**Directory:** Hosted on Alinity SaaS (tenant: `cpta`). Same platform already used by cpm-physio (MB), cap-psychologists (AB), lss-saskatchewan (SK), lsnb-bar (NB), and others. The `_alinity-utils.ts` helper handles prefix enumeration, the 25-row pagination cap, and JSON parsing.  
**Record count:** ~4,000 registered physiotherapists in Alberta (General + Provisional registers). Individual registrant pages confirmed at `cpta.alinityapp.com/Client/PublicDirectory/Registrant/<guid>`.  
**Captcha/WAF:** None observed. `EnableCaptcha: false` is the documented Alinity response field.  
**Verdict:** VIABLE — Alinity-hosted, robots-allowed, no captcha, ~4,000 records, fills fisioterapia AB gap. Implemented as `cpta-ab-physio`.
