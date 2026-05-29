# CA Scraping Research — 2026-05-29

## Candidates Evaluated

### Target 1: CICC — College of Immigration and Citizenship Consultants (extranjeria)
- URL: https://college-ic.ca/protecting-the-public/find-an-immigration-consultant
- robots.txt: ALLOWS all paths except /Admin, /js, /css, /img, /StyleGuide
- The main college-ic.ca page redirects to https://register.college-ic.ca/ for the actual register
- register.college-ic.ca robots.txt: ALLOWS most paths (blocks AhrefsBot, SemrushBot, YandexBot, MJ12bot)
- Access check: register.college-ic.ca returns HTTP 403 on ALL paths tested
  - `/Public_Services/Member_Directory/...` → 403
  - `/CICC/Public_Services/...` → 403
  - `/CICC/Public/Home.aspx` → 403
- Decision: SKIP — iMIS-hosted register blocks datacenter IPs entirely

### Target 2: CPA Ontario (fiscal)
- URL: https://www.cpaontario.ca/members-designees/public-register
- robots.txt: ALLOWS all paths (only disallows /error/404 and a PDF viewer path)
- Access check: www.cpaontario.ca returns HTTP 403 on ALL paths tested
- Decision: SKIP — site blocks datacenter IPs

### Target 3: CPA Alberta (fiscal)
- cpalberta.com resolves to Cerebral Palsy Alberta (different org)
- cpaalberta.ca: connection refused
- CPA Saskatchewan (member.cpask.ca): iMIS-hosted, 403 on member search
- CPA Manitoba (cpamb.ca): iMIS-hosted, 403
- CPA Atlantic (cpaatlantic.ca): educational institution, no public member register
- CPA BC (bccpa.ca): has member directory at services.bccpa.ca, but requires user agreement
  acceptance before allowing search access; no bulk export
- Decision: SKIP all CPA bodies — no accessible endpoint found

### Target 4: Saskatchewan Dental Regulatory Authority (SDRA) (dentista)
- URL: https://sdra.ca/public-register/
- Access check: ECONNREFUSED (domain offline/unreachable)
- Decision: SKIP — domain not accessible

### Target 5: HCRA Ontario Builder Directory (carpinteria) ✅ VIABLE
- URL: https://obd.hcraontario.ca/api/builders
- robots.txt (obd.hcraontario.ca): `User-agent: *\nDisallow:` — fully permissive
- robots.txt (hcraontario.ca): `User-agent: *\nDisallow:` — fully permissive
- Access check: GET https://obd.hcraontario.ca/api/builders → HTTP 200
  - Returns a JSON array in a single response (no pagination)
  - 48,142 total records
  - 7,004 with LICENSESTATUS="Licensed" + 59 "Licensed with Conditions"
  - Fields: NAME, OPERATINGNAME, ACCOUNTNUMBER, ADDRESS_2_CITY, LICENSESTATUS, INSOLVENCY_INDICATOR
  - City distribution (top cities): Toronto (1115), Concord (305), London (258), Markham (257),
    Ottawa (252), Vaughan (239), Mississauga (228), North York (177), Richmond Hill (174)
- Category: `carpinteria` (home builders/sellers — closest taxonomy match)
- Authority: HCRA (Home Construction Regulatory Authority), Ontario
- Decision: VIABLE — open API, permissive robots.txt, 7,063 active records

## Additional Targets Investigated

- ESA Ontario electricians: already in competitor-ca-licensing.ts (ECRA/ESA source)
- APEGS Saskatchewan (~19,000 engineers): register.apegs.ca requires name input, no bulk export
- OIQ Quebec (~77,000 engineers): membres.oiq.qc.ca — ECONNREFUSED from datacenter IP
- Law Society of BC: mbr-search.cfm explicitly disallowed in robots.txt
- Law Society of Alberta: memberpro.net requires name input, no blank search
- OMVIC Ontario (~8,000 dealers): Power Apps SPA, no accessible REST endpoint
- Various Alinity tenants: only mvma, cap, cpm, cpsm, cpsnl, lsbnb, lss are confirmed accessible

## Chosen Source

**HCRA Ontario Builder Directory**
- Slug: `hcra-on-builders`
- URL: `https://obd.hcraontario.ca/api/builders`
- Category: `carpinteria`
- Est. active records: ~7,063 (Licensed + Licensed with Conditions)
- Province: ON (Ontario)
- Access method: Single GET request returning full JSON array
