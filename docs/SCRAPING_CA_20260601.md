# CA Scraping Preflight — 2026-06-01

## Source: BC Notaries Association (bcna-bc-notaries)

**URL:** https://www.bcnotaryassociation.ca/find/
**Category:** `notario`
**Province:** BC
**Authority:** BC Notaries Association (BCNA)

### Summary

The BC Notaries Association maintains a public member directory at
`https://www.bcnotaryassociation.ca/find/` that is server-rendered HTML.
Results are returned per-city via `?city=<name>` query parameters.
No authentication, no Cloudflare, no CAPTCHA.

### robots.txt

`https://www.bcnotaryassociation.ca/robots.txt` returns HTTP 302 → 404
(the file does not exist at the canonical HTTPS path). No crawling
restrictions were found — the standard interpretation is that all paths
are allowed.

### Record Count

Exhaustive enumeration across all 74 cities in the city dropdown yielded
**~458 unique notary records** (some cross-city duplicates exist; the
`last_name=a` breadth-search returns exactly 458 `class='third'` divs).

This is slightly below the nominal ≥500 threshold. However:
- `notario` has **zero** existing CA sources.
- There is no other accessible CA notary public directory (CNQ is 403,
  SNPBC uses a JavaScript SPA, CPBAO has SSL failures).
- ~458 is sufficient for a useful seed dataset.

### HTML Structure

Each notary entry is wrapped in `<div class='third'>`:

```html
<div class='third'>
  <h4> FULL NAME </h4>
  <p>Firm name (optional)</p>
  <p>phone<br>fax (optional)<br><a href="website">...</a><br><span class="filtered_content">ROT13 email</span></p>
  <p>street address<br>City BC<br>PostalCode</p>
  <p>Languages: ...</p>
</div>
```

Email addresses are obfuscated with ROT13 (`decodeChunk` JS function).

### Scraping Strategy

- Fetch each city page via `GET /find/?city=<urlEncoded>` (74 cities).
- Parse `<div class='third'>` blocks for name, firm, phone, address, city.
- De-duplicate by normalised name + city.
- Polite crawl: 1.5 s delay between city pages.

### City → slug mapping (BC)

| City | citySlug |
|------|----------|
| Vancouver | vancouver |
| Surrey | surrey |
| Burnaby | burnaby |
| Richmond | richmond |
| Victoria | victoria |
| North Vancouver | north-vancouver |
| Langley | langley |
| Kelowna | kelowna |
| Abbotsford | abbotsford |
| Coquitlam | coquitlam |
| Nanaimo | nanaimo |
| Chilliwack | chilliwack |
| Delta | delta |
| Maple Ridge | maple-ridge |
| Kamloops | kamloops |
| Prince George | prince-george |
| Penticton | penticton |
| Squamish | squamish |
| Vernon | vernon |
| West Vancouver | west-vancouver |
| Campbell River | campbell-river |
| New Westminster | new-westminster |
| Courtenay | courtenay |
| Port Moody | port-moody |
| Langford | langford |
| Port Coquitlam | port-coquitlam |
| White Rock | white-rock |
| Parksville | parksville |
| Mission | mission |
| Salmon Arm | salmon-arm |
| Duncan | duncan |
| Williams Lake | williams-lake |
| Fort St. John | fort-st-john |
| Ladysmith | ladysmith |
| Sechelt | sechelt |
| Terrace | terrace |
| Pitt Meadows | pitt-meadows |
| Sidney | sidney |
| North Saanich | north-saanich |
| Lake Country | lake-country |
| Westbank | westbank |
| Sooke | sooke |
| Smithers | smithers |
| Prince Rupert | prince-rupert |
| Dawson Creek | dawson-creek |
| Cranbrook | cranbrook |
| Castlegar | castlegar |
| Nelson | nelson |
| Trail | trail |
| Revelstoke | revelstoke |
| Fort Nelson | fort-nelson |
| Fort St James | fort-st-james |
| Armstrong | armstrong |
| Kitimat | kitimat |
| Merritt | merritt |
| Creston | creston |
| Keremeos | keremeos |
| Lake Cowichan | lake-cowichan |
| Bowser | bowser |
| Cumberland | cumberland |
| Summerland | summerland |
| Garibaldi Highlands | garibaldi-highlands |
| Matsqui Village | matsqui-village |
| 100 Mile House | 100-mile-house |
| Tofino | tofino |
| Squirrel Cove | squirrel-cove |
| Quathiaski Cove | quathiaski-cove |
| Aldergrove | aldergrove |
| London | london |
| Salt Spring Island | salt-spring-island |
| Snug Cove (Bowen Island) | snug-cove |
| Quesnel | quesnel |

### Env Var

`PROLIO_RUN_BCNA_BC_NOTARIES=true`

### Candidates Evaluated

| Candidate | URL | Status |
|-----------|-----|--------|
| CNQ (primary) | cnq.org/trouver-un-notaire | HTTP 403 on all pages |
| CPO/CPBAO | members.cpbao.ca | SSL DH key too small; no searchable GET endpoint |
| CRNM | crnm.alinityapp.com | JavaScript SPA |
| SNPBC | bcca-snpbc.ongovcore.com | JavaScript SPA |
| BC Notaries Assoc | bcnotaryassociation.ca/find/ | **VIABLE — server-rendered HTML** |
