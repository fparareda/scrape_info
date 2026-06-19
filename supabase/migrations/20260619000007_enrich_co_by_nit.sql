-- NIT cross-enrichment for Colombia: upgrade SECOP rows (contact, category
-- 'empresa') to the profession vertical that RUES knows for the same NIT.
create index if not exists idx_prof_co_nit
  on public.professionals ((metadata->>'nit'))
  where city_country = 'CO';

create or replace function public.enrich_co_by_nit(batch integer default 2000)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  with cand as (
    select s.id, r.category_key as cat
    from public.professionals s
    join public.professionals r
      on r.source = 'rues-registro-mercantil-co'
     and r.category_key <> 'empresa'
     and r.metadata->>'nit' = s.metadata->>'nit'
    where s.source = 'secop-proveedores-co'
      and s.category_key = 'empresa'
      and s.claim_status = 'unclaimed'
      and s.metadata->>'nit' is not null
    limit batch
  ), upd as (
    update public.professionals p
    set category_key = cand.cat
    from cand
    where p.id = cand.id
    returning 1
  )
  select count(*) into n from upd;
  return n;
end;
$$;
