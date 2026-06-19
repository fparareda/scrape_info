-- promote_cities(min_count) — metric-driven promotion to the display whitelist.
--
-- A city stored via bulk ingestion stays hidden (not in city_whitelist) until
-- it accumulates enough professionals to be worth a web page. This function
-- inserts every (country, slug) that has >= min_count professionals and isn't
-- already whitelisted. Idempotent; intended to run on a cron (run-promote-cities).
-- Returns the number of cities newly promoted this call.

create or replace function public.promote_cities(min_count integer default 50)
returns integer
language plpgsql
as $$
declare
  promoted integer;
begin
  with eligible as (
    select p.city_country as country, p.city_slug as slug
    from public.professionals p
    where p.city_slug is not null
    group by p.city_country, p.city_slug
    having count(*) >= min_count
  ), ins as (
    insert into public.city_whitelist (country, slug, reason)
    select e.country, e.slug, 'promotion'
    from eligible e
    on conflict (country, slug) do nothing
    returning 1
  )
  select count(*) into promoted from ins;
  return promoted;
end;
$$;
