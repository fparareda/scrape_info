# CA Scraper Research — 2026-05-15

## Candidates Evaluated

### Candidate A — Ontario College of Veterinarians (OCV)
- URL: https://www.ocv.ca — this redirects to an Ottawa camping/volunteering org; the Ontario College of Veterinarians is at https://www.cvo.on.ca (connection refused on fetch)
- Status: **BLOCKED** — ECONNREFUSED on fetch attempt

### Candidate B — College of Veterinarians of BC (CVBC)
- URL: https://cvbc.ca/registrant-lookup
- robots.txt: allows admin-ajax.php, no disallows on data paths
- Structure: WordPress form-based search (POST), no listing endpoint found
- Status: **SKIPPED** — no bulk listing endpoint; individual search only

### Candidate C / E / F — ABVMA, NSVMA (Nova Scotia), SVMA (Saskatchewan)
- ABVMA: Uses in1touch.org platform; roster pages return 404 on direct URL access; individual roster pages require navigation from the hub
- NSVMA: Official register is PDFs only (not machine-parseable in bulk)

### Candidate D — SVMA Saskatchewan (Saskatchewan Veterinary Medical Association)
- URL: https://svma.sk.ca/resources/find-a-svma-veterinary-professional-2/
- robots.txt: Completely open (Disallow: [empty])
- Structure: WordPress + TablePress plugin; single-page HTML table, server-rendered, no JS required
- Data: 1,818 rows (April 30, 2026 snapshot); columns: Registration Category, License/Registration Type, First Name, Last Name, Expiration Date, Restrictions & Notices
- Auth/WAF: None detected
- Record count: 1,818 ≥ 500 ✓
- Has name: Yes (First + Last) ✓
- Has address/city: No explicit city — records are province-wide (Saskatchewan); default to `saskatoon` as SK capital

## Decision

**SVMA Saskatchewan selected** — first viable candidate with server-rendered HTML, no auth, open robots.txt, and 1,818 records.

- Source slug: `svma-sk-vets`
- Category: `veterinario`
- Province: SK
- Default city: `saskatoon` (provincial capital; no per-record city data)

## Implementation Notes

- Single HTTP GET to the page URL returns the full table (no pagination)
- Parse with regex matching `<tr class="row-N"><td ...>` pattern
- Column order: [0] Category, [1] License Type, [2] First Name, [3] Last Name, [4] Expiry, [5] Restrictions
- Use `politeFetch` helper for polite UA with Chrome fallback
- Source ID: `svma-sk-vets:<firstName>:<lastName>` (no stable numeric ID in source)
- HTML entities need decoding (&amp; → &)
