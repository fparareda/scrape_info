export const LOCALES = ["es", "en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "es";

export type CategoryKey =
  | "fiscal"
  | "extranjeria"
  | "psicologia"
  | "medicina"
  | "dentista"
  | "fisioterapia"
  | "veterinario"
  | "notario"
  | "arquitecto"
  | "carpinteria"
  | "fontaneria"
  | "electricidad"
  | "hvac"
  | "cerrajero"
  | "mecanica"
  | "itv"
  | "ingenieria";

export type ClaimStatus = "unclaimed" | "claimed" | "verified";
export type Tier = "free" | "featured";

export interface Category {
  key: CategoryKey;
  /** SEO slug per locale (e.g. es: "asesor-fiscal", en: "tax-advisor"). */
  slugs: Record<Locale, string>;
  names: Record<Locale, string>;
  /** Plural label used in listings/headings. */
  pluralNames: Record<Locale, string>;
}

export interface City {
  slug: string;
  name: string;
  country: "ES" | "CA" | "US";
  lat?: number;
  lng?: number;
}

export interface Professional {
  id: string;
  slug: string;
  name: string;
  categoryKey: CategoryKey;
  citySlug: string;
  /** Short tagline used in cards. */
  headline: string;
  /** Long description, optionally AI-generated. Localised later. */
  description: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  lat?: number;
  lng?: number;
  /** Colegio / bar association number when applicable. */
  licenseNumber?: string;
  rating?: number;
  reviewCount?: number;
  /** Google Places place_id when the row was ingested from Google. Used
   *  to deep-link to reviews on search.google.com without storing the
   *  review text (Google TOS). */
  googlePlaceId?: string;
  /** Spanish CIF/NIF when the pro is a registered entity. */
  cif?: string;
  /** Legal form — "SL", "SA", "Autónomo", "Cooperativa", etc. */
  legalForm?: string;
  /** ISO date (YYYY-MM-DD) of incorporation. Drives "desde YYYY" badges. */
  foundedAt?: string;
  photoUrl?: string;
  openingHours?: string[];
  /** Locale-specific SEO copy rendered above the contact card. Generated
   *  deterministically from other row fields at scrape time (see B3 SEO
   *  audit). Empty on legacy rows — callers should fall back to
   *  description or regenerate on the fly. */
  seoCopyEs?: string;
  seoCopyEn?: string;
  seoCopyFr?: string;
  tier: Tier;
  claimStatus: ClaimStatus;
  /** Flexible bag for future fields without schema churn. */
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Lead {
  id: string;
  professionalId: string;
  name: string;
  email: string;
  phone?: string;
  message: string;
  createdAt: string;
}
