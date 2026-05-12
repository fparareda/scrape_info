import type { Category, Locale } from "./prolio-types.js";

/**
 * Deterministic SEO copy generator (B3). Duplicate of
 * apps/web/lib/seo/generate-profile-copy.ts — keep in sync. We duplicate
 * instead of importing because apps/scraper and apps/web are sibling
 * packages and neither depends on the other; lifting into a shared
 * package just for one string builder isn't worth the indirection yet.
 */
export function generateProfileCopy(
  professional: {
    name: string;
    licenseNumber?: string;
    openingHours?: string[];
    rating?: number;
    reviewCount?: number;
  },
  category: Pick<Category, "names" | "pluralNames">,
  city: { name: string },
  locale: Locale,
): string {
  const categoryName = category.names[locale].toLowerCase();
  const hasLicense = Boolean(professional.licenseNumber);
  const hasRating =
    typeof professional.rating === "number" &&
    typeof professional.reviewCount === "number" &&
    professional.reviewCount > 0;
  const hasHours =
    Array.isArray(professional.openingHours) &&
    professional.openingHours.length > 0;

  if (locale === "es") {
    const licencia = hasLicense
      ? `Ejerce con licencia número ${professional.licenseNumber}, dato que cruzamos con registros públicos.`
      : `Figura como profesional activo en la ciudad según los registros públicos que consultamos.`;
    const valoraciones = hasRating
      ? ` Cuenta con ${professional.rating!.toFixed(1)} estrellas sobre ${professional.reviewCount} valoraciones verificadas en Google.`
      : "";
    const horario = hasHours
      ? ` Abajo encontrarás su horario actualizado para esta semana.`
      : "";
    return (
      `${professional.name} es ${categoryName} en ${city.name}. ${licencia}${valoraciones}${horario} ` +
      `En Prolio comprobamos que su ficha esté vigente y refrescamos sus datos cada semana para que la información pública no se quede obsoleta. ` +
      `Puedes contactar directamente desde esta página: nosotros no cobramos comisión, no vendemos el lead y no nos interponemos en la conversación. ` +
      `Si eres ${professional.name} y quieres actualizar tu perfil tú mismo, puedes reclamarlo gratis al final de esta página.`
    );
  }

  if (locale === "en") {
    const license = hasLicense
      ? `Practices under license number ${professional.licenseNumber}, cross-checked against public registries.`
      : `Listed as an active professional in the city per the public records we consult.`;
    const reviews = hasRating
      ? ` Holds ${professional.rating!.toFixed(1)} stars across ${professional.reviewCount} verified Google reviews.`
      : "";
    const hours = hasHours
      ? ` This week's opening hours are shown further down this page.`
      : "";
    return (
      `${professional.name} works as a ${categoryName} in ${city.name}. ${license}${reviews}${hours} ` +
      `Prolio refreshes this listing weekly so the public information stays current and you're not reading a page Google forgot about years ago. ` +
      `You can contact ${professional.name} directly from this page — we don't take a commission, we don't resell the lead, and we don't sit between you and the professional. ` +
      `If you're ${professional.name} and want to edit this profile yourself, you can claim it for free at the bottom of the page.`
    );
  }

  const licence = hasLicense
    ? `Exerce sous le numéro de licence ${professional.licenseNumber}, recoupé avec les registres publics.`
    : `Répertorié comme professionnel en activité dans la ville d'après les registres publics consultés.`;
  const avis = hasRating
    ? ` Cumule ${professional.rating!.toFixed(1)} étoiles sur ${professional.reviewCount} avis vérifiés sur Google.`
    : "";
  const horaires = hasHours
    ? ` Les horaires d'ouverture de la semaine sont affichés plus bas sur cette page.`
    : "";
  return (
    `${professional.name} est ${categoryName} à ${city.name}. ${licence}${avis}${horaires} ` +
    `Prolio actualise cette fiche chaque semaine pour que les informations publiques restent à jour, plutôt que de laisser traîner une page oubliée par Google. ` +
    `Vous pouvez contacter ${professional.name} directement depuis cette page : nous ne prenons pas de commission, ne revendons pas le contact et ne nous plaçons pas entre vous et le professionnel. ` +
    `Si vous êtes ${professional.name} et souhaitez modifier cette fiche vous-même, vous pouvez la réclamer gratuitement en bas de page.`
  );
}
