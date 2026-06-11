# ES scraper scout — 2026-06-11

## Summary

No viable new source found. Every evaluated candidate either:
(a) is already implemented in main or an open PR,
(b) has a robots.txt that blocks the paginated/download URL,
(c) falls below the 500-record threshold, or
(d) requires JavaScript/CAPTCHA.

## Candidates evaluated

### Aragón instaladores open data — electricidad/fontaneria — BLOCKED

- robots.txt: `Disallow: /GA_OD_Core/download*` — blocks all paginated CSV downloads.

### JCYL instaladores (Castilla y León XML) — electricidad — SKIP

- Already in open PR `feat/jcyl-instaladoras-es`.

### RASIC Catalunya instaladores — electricidad/fontaneria/hvac — SKIP

- Already in open PR `feat/es-rasic-instaladores-cat`.

### AEDAF asesores fiscales — fiscal — SKIP

- Already in open PR `feat/es-aedaf-asesores-fiscales`.

### registro.consejogestores.org (Gestores Administrativos) — extranjeria — BLOCKED

- robots.txt: `Disallow: /*?*` — blocks ALL paginated search result URLs (pagination uses query
  parameters exclusively).

### APECS cerrajeros — cerrajero — BELOW THRESHOLD

- ~90 members. Below 500-record minimum.

### UCES cerrajeros — cerrajero — BLOCKED

- JavaScript-driven dynamic loading, no static HTML fallback.

### Ministerio del Interior empresas de seguridad — cerrajero — BLOCKED

- HTTP 403 from datacenter IPs.

### Cataluña empreses de seguretat privada — cerrajero — BELOW THRESHOLD

- 196 records. Below 500-record minimum. Also maps to surveillance, not locksmiths.

### gescol.org médicos (10+ provincial colegios) — medicina — BLOCKED

- All 11 provincial colegios using this platform have reCAPTCHA on the buscador form.

### CGCOM médicos nacional — medicina — BLOCKED

- Returns HTTP 403 Forbidden from datacenter IPs.

### Provincial gestores colegios (Sevilla, Alicante, Málaga) — extranjeria — SKIP

- All redirect to `registro.consejogestores.org` (robots-blocked) or JS-rendered.

### COMAST Asturias médicos — medicina — BELOW THRESHOLD

- Only 7 public records (opt-in only directory).

## Verdict

SKIP — no viable candidate within existing taxonomy. The most underserved uncovered category is
`extranjeria` (gestores administrativos), but the only national public registry is robots-blocked.
To unlock ES extranjeria, the web-app taxonomy team would need to first add a new tax-advisor
or gestor category, or find a provincial open-data CSV that bypasses the national registry.
