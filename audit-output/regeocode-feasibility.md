# Re-geocoding feasibility per source (Sprint 1 input)

Sample-verified from real `metadata` + `address` values. Each Tipo-A source classified into a sub-clase with the concrete recipe for Sprint 1.

## Sub-clase A.2 — `address` column has parseable city

| Source | Rows | has_address | Sample | Recipe |
|---|---:|---:|---|---|
| **datos-gob-es** | 11,148 | 10,977 (98%) | `"C/ Alicante, s/n, Murcia"` | Split by comma, take last non-empty segment → city. Regex friendly. |
| **rcdso** | 1,000 | 1,000 (100%) | `"1140 Burnhamthorpe Rd W #135/136, Mississauga, L5C 0A3"` | Split by comma, take segment N-2 (skip postal). |
| **oaq** | 1,491 | 1,491 (100%) | `"360, rue St-Jacques, bureau 1500, Montréal, Québec, H2Y 1P5"` | Split by comma, take segment N-3 (skip suite, province, postal). |
| **cofepris-farmacias** | 15,707 | 7,711 (49%) | `"Av. Azueta No. 173 21100 Mexicali Baja California"` | MX format. Regex `\d{5}\s+(\w+(?:\s\w+)*)\s+(\w+(?:\s\w+)*)$` → groups = (city, state). |
| **amvic-dealers** | 4,974 | 4,969 (99.9%) | `"2006 22nd St Sw"` | **NO city/postal in address.** Falls back to A.1 (province only). |

## Sub-clase A.2-bis — `metadata.<field>` has real city (no `address` col needed)

| Source | Rows | Field | Sample | Recipe |
|---|---:|---|---|---|
| **apega** | 71,516 | `metadata.raw_city` | Calgary, Edmonton, Red Deer, Sundre, Nanaimo, Burnaby | Direct copy → slugify → resolve. Multi-province (engineers move). |
| **tsask** | 42,488 | `metadata.raw_city` | LAKE LENORE, DELISLE, REGINA, NORTH BATTLEFORD, OUTLOOK, FORT QU'APPELLE, CALGARY | Direct copy → lowercase → slugify. Mostly SK but some out-of-province. |
| **cpsns-ns-physicians** | 6,728 | `metadata.practice_location` | Halifax, Dartmouth, Sydney | Direct copy → slugify. All NS. |

**Total A.2 + A.2-bis = ~138,500 pros recoverable without re-scrape.**

## Sub-clase A.1 — only province/colegial info → must use `city_slug = NULL` + `metadata.province_slug` + `metadata.location_granularity = 'province'`

| Source | Rows | Provincia/Estado | Notas |
|---|---:|---|---|
| guiadentistas-es | 41,996 | `metadata.provincia_id` | Tiene `colegio_provincial` también |
| com_madrid | 40,034 | Madrid (fijo) | colegial scope=Madrid |
| sat-efos-edos | 14,055 | nacional MX | no tiene location; sólo RFC. Considerar deshabilitar para matriz ciudad |
| cnsf-agentes | 10,000 | nacional MX | igual |
| cgcoo-opticos | 8,000 | `metadata.provincia_id` | |
| cpsns-ns-physicians | (parte sin practice_location) | NS | overlaps con A.2-bis |
| com_gipuzkoa | 4,958 | Gipuzkoa (fijo) | |
| amvic-dealers | 4,974 | `metadata.province` (Alberta) | |
| cre-permisionarios | 3,640 | nacional MX | |
| cpsnl | 2,227 | NL | |
| svma-sk-vets | 1,818 | SK | |
| cap-psychologists | 1,602 | AB | |
| lsnb-bar | 1,566 | NB | |
| lss-saskatchewan | 1,504 | SK | |
| cpm-physio | 262 | MB | |

**Total A.1 = ~136,000 pros → NULL city + province_slug.**

## Sub-clase A.3 — real demographic concentration (no fix needed)

FR abogado/arquitecto/cerrajero/electricidad/fontaneria/extranjeria con 30-47% en Paris. Es realidad demográfica francesa (~40-50 % de avocats están en Île-de-France). No tocar.

## Recipe summary

```text
For each row in (apega, tsask, cpsns-ns-physicians):
  raw = metadata->>'raw_city' OR metadata->>'practice_location'
  if raw:
    slug = slugify(lower(raw))
    if exists in cities WHERE country='CA':
      UPDATE city_slug = slug
    else:
      INSERT INTO cities(country='CA', slug, name=raw)
      UPDATE city_slug = slug

For each row in (datos-gob-es, rcdso, oaq, cofepris-farmacias):
  city_name = parse_address(address, source_format)
  similar resolution

For each row in (guiadentistas-es, com_madrid, sat-efos-edos, …):
  UPDATE
    city_slug = NULL,
    metadata = metadata || jsonb_build_object(
      'province_slug', <resolved>,
      'location_granularity', 'province'
    )
```
