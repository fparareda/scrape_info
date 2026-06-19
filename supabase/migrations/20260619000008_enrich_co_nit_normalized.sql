-- SECOP NITs arrive dirty (leading ". ", "´", "|"); match on a digits-only
-- normalised NIT instead, with a matching functional index. The scraper now
-- also stores a clean metadata.nit (re-scan heals existing rows).
drop index if exists public.idx_prof_co_nit;
create index if not exists idx_prof_co_nit_norm
  on public.professionals ((regexp_replace(metadata->>'nit', '\D', '', 'g')))
  where city_country = 'CO';

create or replace function public.enrich_co_by_nit(batch integer default 2000)
returns integer language plpgsql as $$
declare n integer;
begin
  with cand as (
    select s.id, r.category_key as cat
    from public.professionals s
    join public.professionals r
      on r.source = 'rues-registro-mercantil-co'
     and r.category_key <> 'empresa'
     and regexp_replace(r.metadata->>'nit','\D','','g') = regexp_replace(s.metadata->>'nit','\D','','g')
    where s.source = 'secop-proveedores-co'
      and s.category_key = 'empresa'
      and s.claim_status = 'unclaimed'
      and length(regexp_replace(s.metadata->>'nit','\D','','g')) >= 5
    limit batch
  ), upd as (
    update public.professionals p set category_key = cand.cat
    from cand where p.id = cand.id returning 1
  )
  select count(*) into n from upd; return n;
end; $$;
