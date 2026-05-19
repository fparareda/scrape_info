# TYPE_C — Missing provincial / state sources

> Compilación de conocimiento de dominio (los agentes externos no llegaron a entregar). Cada URL debe pasar preflight check antes de implementar.

## 🇨🇦 Canadá — Provincial colleges faltantes

### Dentistas (11 ciudades → debería ser 200+)

Ya tenemos: ODQ (Québec), RCDSO (Ontario, 1k).

| Provincia | Source | URL | ~rows | Platform | Template |
|---|---|---|---|---|---|
| BC | College of Dental Surgeons of BC | cdsbc.org / oralhealthbc.ca | 4.5k | Thentia | `_thentia-utils.ts` |
| Alberta | Alberta Dental Association + College | dentalhealthalberta.ca | 2.8k | custom HTML | new |
| Manitoba | MDA — Manitoba Dental Association | manitobadentist.ca | 800 | HTML find-a-dentist | new |
| Saskatchewan | College of Dental Surgeons of SK | saskdentists.com | 700 | HTML | new |
| NS | NS Dental Association | nsdental.org | 850 | HTML | new |
| NB | NB Dental Society | nbdental.com | 500 | HTML | new |
| PEI | DAPEI | dentalassocationpei.com | 100 | HTML | new |
| NL | NLDA / Newfoundland Dental Board | nldb.ca | 350 | HTML | new |

### Otras categorías CA con cobertura parcial

| Categoría | Provincias faltantes principales | Source |
|---|---|---|
| extranjeria | Ontario (mayor), BC, Alberta, Québec | LSO, LSBC, LSA, Barreau du Québec, LSM, NSBS |
| fiscal | Todas las CPA provinciales | cpaontario.ca, cpabc.ca, cpaalberta.ca, cpaquebec.ca |
| fontaneria | ON, AB, QC trade boards | Skilled Trades Ontario, Alberta App. & Industry Training |
| psicologia | Ontario, BC, Québec | CPO Ontario, CPBC, OPQ Québec |

Patrones: usar `_imis-utils.ts` (muchos provinciales corren iMIS), `_in1touch-utils.ts`, `_alinity-utils.ts`. **Antes de implementar, hacer un probe estilo `probe-colegios-medicos.mjs` para clasificar 30 URLs y atacar primero las easy.**

## 🇪🇸 España

| Categoría | Hueco | Source |
|---|---|---|
| veterinario | 27 ciudades → 200+ | Consejo General Colegios Veterinarios + 50 provinciales. vucolvet ya cubre la mayoría; faltan algunos colegios autonómicos (Cataluña, Galicia, País Vasco usan portales propios). |

## 🇲🇽 México

| Categoría | Hueco | Source primario |
|---|---|---|
| dentista | 31 ciudades → 200+ | **SEP RNP cédula Cirujano Dentista** (cubre todos) |
| fisioterapia | 17 → 200+ | **SEP RNP cédula Fisioterapia** |
| psicologia | 15 → 200+ | **SEP RNP cédula Psicología** |

Todos resueltos por la misma fuente: SEP-RNP. Un único scraper big-bang.

## 🇺🇸 Estados Unidos — state boards faltantes

Los TYPE_C de US son sólo por falta de cobertura geográfica de google_places/yelp. Plan: añadir state contractor / professional boards.

### Carpintería / Fontanería / HVAC / Electricidad

Ya tenemos: florida-dbpr, georgia-plb, illinois-idfpr, louisiana-lslbc, maryland-dllr, massachusetts-dpl, michigan-lara, minnesota-dli, missouri-dpr, nevada-nscb, new-jersey-dca, new-york-dos, north-carolina-lbc, oh-elicense/ohio-elicense, oregon-ccb, pa-pals, pennsylvania-bpoa, tennessee-tdci, texas-tdlr, virginia-dpor, washington-li, wisconsin-dsps, arizona-roc, colorado-dora, ny-sed-professions, nyc-dob.

**Estados grandes faltantes**: California (CSLB ya existe en `competitor-us-cslb.ts` — promover a source oficial), Indiana, Kentucky, Alabama, South Carolina, Iowa, Connecticut, Oklahoma, Arkansas, Mississippi, Kansas, Utah, Nevada (PCB), New Mexico.

| Estado | Source | URL |
|---|---|---|
| CA | CSLB Contractor Search | cslb.ca.gov | promover existing competitor scraper |
| IN | Indiana PLA | in.gov/pla | new |
| KY | KY Board of Licensure / Plumbing | dhbc.ky.gov | new |
| AL | Alabama LCB | hbclb.alabama.gov | new |
| SC | SC LLR | llr.sc.gov | new |
| IA | Iowa Plumbing | idph.iowa.gov | new |
| CT | CT eLicense | elicense.ct.gov | new |

### Fiscal (CPA)

| Estado | Source |
|---|---|
| federal | NASBA CPAverify (50-state lookup unified) | cpaverify.org | API JSON | 600k | new — alto ROI federal |

### Extranjería (state bars — overlaps con TYPE_B abogado US)

Mismo trabajo, no duplicar.

## Recomendación de orden (TYPE_C)

1. **SEP RNP MX** (resuelve dentista + fisio + psico + parte de TYPE_B) — máximo ROI.
2. **NASBA CPAverify US** — 1 endpoint, 50 estados de un golpe.
3. **CSLB CA + 7-10 state contractor boards** US — cierra carpintería/electric./HVAC/fontanería.
4. **Provinciales CA dentistas** (8 colleges) — clonar patrón `odq.ts` × 8.
5. **CPA provinciales CA + Bar provinciales** — overlap con TYPE_B.

## Overture/OSM como backfill final

Para ciudades pequeñas donde ningún registro oficial llega: **Overture Maps** (descarga bulk gratis, 60M+ POIs globales). Ya tenemos `overture.ts`. Filtros por categoría → lat/lng → reverse-geocode a `cities.slug`.

Limitaciones: Overture/OSM no traen `license_number`, ni `email` profesional. Cubren la celda "existencia" pero no la calidad. Marcar `metadata.source_quality = 'osm_backfill'` para distinguirlos.
