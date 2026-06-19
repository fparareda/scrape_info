-- promote_cities v2: threshold default 5 (matches the "min 5 companies to be
-- shown" rule) and EXCLUDE Colombia — CO is manually curated to its top-50
-- largest cities, not auto-promoted. See docs/SCRAPING_CO_20260619.md §1b.
create or replace function public.promote_cities(min_count integer default 5)
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
      and p.city_country <> 'CO'
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
