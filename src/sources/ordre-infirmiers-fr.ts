import type { ScrapeSource, ScraperSource } from "../types.js";

/**
 * Ordre National des Infirmiers (ONI) — French national nurses council.
 *
 * **HONEST STUB — wired but disabled by default.**
 *
 * Investigation 2026-05-18:
 *   - `https://www.ordre-infirmiers.fr/annuaire` → 301 redirect to
 *     `/annuaire-de-la-profession`.
 *   - That page contains NO search UI. Its content is a single sentence
 *     pointing users to ANS:
 *       "L'ensemble des professionnels de santé sont répertoriés sur
 *        l'annuaire santé édité par l'Agence du Numérique en Santé (ANS)
 *        : https://annuaire.sante.fr/"
 *   - The Ordre's own register ("tableau de l'Ordre") is fed INTO the
 *     ANS RPPS dataset and is not separately downloadable. The only
 *     structured asset on `/la-demographie-infirmiere` is a PDF analyse
 *     (aggregate stats, no nominative rows).
 *   - data.gouv.fr searches for "infirmiers ordre" / "ordre infirmiers"
 *     return zero datasets (verified via API, 2026-05-18).
 *
 * **Therefore the ~360k French IDE cohort is already harvested by
 * `annuaire-sante-ans` (which maps `libelle_profession` containing
 * "infirmier" → category `enfermeria`).** Last ANS sample landed ~106k
 * nurses; the upstream extract is provisioned monthly and the worker
 * already breaks early on PROLIO_ANNUAIRE_SANTE_ANS_LIMIT so raising the
 * cap there is the right lever for full national coverage — NOT a new
 * scraper.
 *
 * This stub stays so the source slug is reservable for any future
 * release of Ordre-specific data (e.g. should the Ordre eventually
 * publish a CSV of their tableau — e.g. via data.gouv.fr — flipping
 * this source on becomes a one-file change). It is registered in the
 * runner and types union for parity with the rest of the wave.
 *
 * Off by default. `PROLIO_RUN_ORDRE_INFIRMIERS_FR=true` does nothing
 * yet; the runner returns immediately with zero rows.
 */

export const ordreInfirmiersFrSource: ScraperSource = {
  name: "ordre-infirmiers-fr" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_ORDRE_INFIRMIERS_FR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOrdreInfirmiersFr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!ordreInfirmiersFrSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  console.log(
    "[ordre-infirmiers-fr] stub — ONI has no public nominative annuaire; " +
      "FR nurses (~360k) are surfaced via annuaire-sante-ans (RPPS → enfermeria). " +
      "Returning 0.",
  );
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
