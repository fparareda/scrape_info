# scraper

Scraper de profesionales.

- **Fuentes**: Google Places API (bootstrap) + Playwright para colegios profesionales.
- **Refresco**: cron semanal.
- **Destino**: Supabase (tabla `professionals`, upsert por `source_id`).
- **GDPR**: cualquier registro pre-cargado incluye token de opt-out desde día 1.

Aún no está implementado — este paquete es un stub. Mantener **sin imports de `apps/web`** para poder extraerlo a un repo independiente en el futuro.

## Añadir un scraper

Mínimo viable:

```ts
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, buildCitySlug } from "../normalise.js";

export const mySource: ScraperSource = {
  name: "my-source",
  enabled: () => true,
  async fetch(target): Promise<ScrapedProfessional[]> {
    const { citySlug } = buildCitySlug(target.country, /* rawCity */ "Madrid");
    return [normalise({
      source: "my-source",
      country: target.country,         // REQUIRED — typescript enforces
      sourceId: "stable-id-from-source",
      name: "Nombre legal del pro",
      categoryKey: target.categoryKey,
      citySlug,                         // "" if only province known
      metadata: {
        // If citySlug is "" (province granularity), populate this:
        // province_slug: "...",
      },
    })];
  },
};
```

Reglas:
- `country` es **obligatorio** y debe coincidir con el país real de la fila. Para sources single-country va hardcoded (`country: "ES"`); para multi-país (google_places, osm, …) usa `target.country`. Ver [audit-output/root-fix-plan.md](audit-output/root-fix-plan.md) para el porqué.
- `citySlug` debe existir en `cities` para el `country` declarado, o ser `""` (granularidad provincia, requiere `metadata.province_slug`).
- El sink valida `(country, slug)` contra `cities` antes de insertar — filas con par no seeded se dropean con log.
- Datos sensibles / contaminación entre países: ver [audit-output/summary.md](audit-output/summary.md).
