# CA Scraping Research — 2026-06-24

## Candidates evaluated

### 1. Law Society of Alberta (LSAB) — abogado AB
- URL: https://lsa.memberpro.net/main/body.cfm?menu=directory
- Platform: MemberPro (ColdFusion `.cfm` backend), JavaScript-driven search
- robots.txt: `Disallow: /` for all user-agents — **BLOCKED**
- Decision: **REJECTED** — robots.txt blocks all crawlers.

### 2. College of Physicians and Surgeons of Saskatchewan (CPSS) — medicina SK
- URL: https://www.cps.sk.ca/imis/PhysicianSearch
- Known 403 on datacenter IPs (per prior research 2026-06-13)
- Not re-verified; carried forward as blocked.
- Decision: **SKIPPED** (already known blocked)

### 3. New Brunswick Dental Society (NBDS) — dentista NB ✅ IMPLEMENTED
- URL: https://nbds.alinityapp.com/client/PublicDirectory
- Platform: Alinity (tenant `nbds`)
- robots.txt: Alinity subdomains return 404 on robots.txt (standard). Parent domain
  `nbdent.ca` only disallows `/wp-admin/`. No restrictions on `alinityapp.com` paths.
- Access: Public, no login, no Cloudflare, no CAPTCHA; confirmed 200 response
  from datacenter IP on 2026-06-24.
- Record estimate: ~385 licensed dentists (NB pop. ~810k, ratio ~1:2100 per CIHI).
  Reasonable for a small Atlantic province.
- Category: `dentista` — fills NB gap (no NB dentist source existed).
- Decision: **IMPLEMENTED** as `nbds-nb-dentists` (slug).

### 4. New Brunswick College of Pharmacists (NBCP-OPNB) — farmacia NB
- URL: https://nbcp-opnb.alinityapp.com/client/publicdirectory
- Platform: Alinity (tenant `nbcp-opnb`)
- Access: Public, no login; confirmed accessible.
- Record estimate: ~1,200 pharmacists + technicians.
- Category: `farmacia` — would fill NB gap.
- Decision: **DEFERRED** — NBDS dentists chosen as primary; NBCP-OPNB is a strong
  candidate for the next CA wave.

### 5. Nova Scotia Veterinary Medical Association (NSVMA) — veterinario NS
- URL: https://nsvma.ca/official-register/
- Format: Page links to **PDF files** only (not an inline table or structured API).
  Four PDFs: Active Veterinarians, Registered Vet Technicians, Non-Practicing, Life Members.
  Latest PDF dated June 4, 2026.
- robots.txt: Allows all paths (`Disallow:` with no value).
- Decision: **REJECTED** — PDF-only format requires OCR/PDF parsing; no structured
  data feed available. Implementation complexity too high for a regulatory PDF list.

## Implemented

| slug | province | category | platform | estimated records |
|------|----------|----------|----------|------------------|
| `nbds-nb-dentists` | NB | dentista | Alinity (`nbds`) | ~385 |
