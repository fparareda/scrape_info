-- city_whitelist — display whitelist (decoupled from storage).
--
-- Background (docs/SCRAPING_CO_20260619.md §1b): `public.cities` is the
-- full gazetteer (storage layer, a superset that grows via ensureCity
-- auto-seeding from bulk sources — e.g. CO already holds 1,119 DANE
-- municipios). The web must only render a deliberately curated subset.
-- Until now that subset lived as a static list in code (duplicated between
-- the scraper repo and the web repo) with no DB representation.
--
-- This table makes the whitelist first-class: a city is SHOWN on the web
-- iff a row exists here. Auto-seeded municipalities are NOT inserted here
-- (ensureCity never touches this table) → they are stored-but-hidden by
-- default. Promotion to the whitelist is a deliberate act: manual seed for
-- the initial set, plus an automated job that inserts a row once a city
-- accumulates enough professionals (see run-promote-cities, pending).

create table if not exists public.city_whitelist (
  country    text        not null,
  slug       text        not null,
  added_at   timestamptz not null default now(),
  -- How the city earned its slot: 'seed' (initial curated set),
  -- 'promotion' (auto, crossed the professional-count threshold),
  -- 'manual' (added by hand). Free text; informational.
  reason     text        not null default 'seed',
  primary key (country, slug),
  constraint city_whitelist_city_fk
    foreign key (country, slug)
    references public.cities (country, slug)
    on delete cascade
);

comment on table public.city_whitelist is
  'Display whitelist: a city is shown on the web iff present here. Storage (public.cities) is a superset; auto-seeded cities stay out of this table = hidden until promoted.';

-- Initial seed — Colombia top-30 (the curated set from
-- cities.ts COLOMBIAN_CITIES). Other countries (ES/US/CA/FR/MX) are seeded
-- in a follow-up coordinated with the web cut-over (A3), so we don't risk
-- hiding currently-shown cities by seeding an incomplete set here.
insert into public.city_whitelist (country, slug, reason)
select 'CO', slug, 'seed'
from public.cities
where country = 'CO'
  and slug in (
    'bogota','medellin','cali','barranquilla','cartagena','cucuta','soledad',
    'soacha','bucaramanga','bello','villavicencio','pereira','valledupar',
    'monteria','ibague','pasto','manizales','neiva','palmira','popayan',
    'sincelejo','itagui','floridablanca','envigado','tulua','dosquebradas',
    'barrancabermeja','santa-marta','riohacha','tunja'
  )
on conflict (country, slug) do nothing;
