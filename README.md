# scraper

Scraper de profesionales.

- **Fuentes**: Google Places API (bootstrap) + Playwright para colegios profesionales.
- **Refresco**: cron semanal.
- **Destino**: Supabase (tabla `professionals`, upsert por `source_id`).
- **GDPR**: cualquier registro pre-cargado incluye token de opt-out desde día 1.

Aún no está implementado — este paquete es un stub. Mantener **sin imports de `apps/web`** para poder extraerlo a un repo independiente en el futuro.
