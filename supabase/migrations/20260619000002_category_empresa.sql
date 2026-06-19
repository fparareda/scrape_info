-- Generic "empresa" category — catch-all for bulk company registries.
--
-- Background (docs/SCRAPING_CO_20260619.md §3): professionals.category_key is
-- NOT NULL and FK to public.categories (the 20 profession verticals). Bulk
-- national registries (RUES 9.3M, SECOP 1.6M) contain companies whose CIIU
-- activity does not map to any vertical (retail, agriculture, …). To store
-- ALL businesses (not just classifiable ones), they fall back to this generic
-- category instead of being dropped.
--
-- ⚠️ WEB COORDINATION REQUIRED before this matters in prod: the web (prolio
-- repo) iterates categories to build SEO/listing pages. Inserting this row
-- may surface an 'empresa' category page with no curated copy until the web
-- repo adds labels/UX for it. Apply in lockstep with the web change, NOT
-- ahead of it.

insert into public.categories (
  key,
  slug_es,    slug_en,   slug_fr,
  name_es,    name_en,   name_fr,
  plural_name_es, plural_name_en, plural_name_fr
) values (
  'empresa',
  'empresa',  'company', 'entreprise',
  'Empresa',  'Company', 'Entreprise',
  'Empresas', 'Companies', 'Entreprises'
)
on conflict (key) do nothing;
