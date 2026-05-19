-- Sprint 0 backfill — re-assign the ~5,500 rows mis-attributed by country.
--
-- Run AFTER sprint-0-migration.sql succeeds.
-- This SETS the correct city_country based on the source's true country, and
-- NULLs the city_slug so Sprint 1 (re-geocode from metadata) can resolve it
-- properly. Honest gap > concentrated lie.

BEGIN;

-- Map each contaminated source to its real country. List built from
-- audit-output/contamination-cross-country.csv.
WITH src_country(source, real_country) AS (
  VALUES
    -- French sources contaminating CA via 'laval', 'paris' etc.
    ('cnb-avocats', 'FR'),
    ('rpps-fr', 'FR'),
    ('annuaire-sante-ans', 'FR'),
    ('annuaire-sante-ameli', 'FR'),
    ('sirene-insee', 'FR'),
    ('ademe-rge', 'FR'),
    ('auto-ecoles-fr', 'FR'),
    ('prix-controle-technique', 'FR'),
    ('cnop-pharmaciens', 'FR'),
    ('finess', 'FR'),
    ('architectes-fr', 'FR'),
    ('oec-fr', 'FR'),
    ('ordre-vet-fr', 'FR'),
    -- Mexican sources contaminating ES via 'guadalajara', 'salvatierra', 'lerma'
    ('denue-mx', 'MX'),
    ('siem', 'MX'),
    ('cofepris-farmacias', 'MX'),
    ('condusef-sipres', 'MX'),
    ('senasica-mx-vet', 'MX'),
    ('padron-notarios-fed-mx', 'MX'),
    ('profeco-sancionados', 'MX'),
    ('reniecyt-mx', 'MX'),
    ('amda-distribuidores', 'MX'),
    -- US sources contaminating CA via 'stephenville', 'richmond'
    ('texas-tdlr', 'US'),
    -- BC (CA) sources contaminating US via 'richmond'
    ('tsbc', 'CA'),
    ('ecra', 'CA'),
    -- Spanish sources contaminating US via 'el-paso', 'laredo', 'santa-barbara'
    -- or MX via 'salvatierra', 'lerma'
    ('ccaa_registry', 'ES'),
    ('dgt-itv-es', 'ES'),
    ('cgn-notariado', 'ES')
)
UPDATE professionals p
SET
  city_country = sc.real_country,
  -- Clear city_slug only when the previous (assumed-wrong) country differs.
  -- Sprint 1 will re-geocode from metadata.raw_city / address.
  city_slug = NULL
FROM src_country sc
WHERE p.source = sc.source
  AND p.city_country IS DISTINCT FROM sc.real_country;

-- Report how many rows were corrected
SELECT
  source,
  COUNT(*) AS rows_reassigned
FROM professionals
WHERE city_slug IS NULL
  AND source IN (
    'cnb-avocats','rpps-fr','annuaire-sante-ans','annuaire-sante-ameli',
    'sirene-insee','ademe-rge','auto-ecoles-fr','prix-controle-technique',
    'cnop-pharmaciens','finess','architectes-fr','oec-fr','ordre-vet-fr',
    'denue-mx','siem','cofepris-farmacias','condusef-sipres','senasica-mx-vet',
    'padron-notarios-fed-mx','profeco-sancionados','reniecyt-mx','amda-distribuidores',
    'texas-tdlr','tsbc','ecra','ccaa_registry','dgt-itv-es','cgn-notariado'
  )
GROUP BY source
ORDER BY rows_reassigned DESC;

-- If the numbers look reasonable, COMMIT. Otherwise ROLLBACK.
COMMIT;
