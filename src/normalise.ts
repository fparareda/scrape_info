import type { ScrapedProfessional } from "./types.js";

/** Collapse repeated whitespace, trim. */
function trimAll(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Normalise Spanish phone numbers to E.164 when possible. */
export function normalisePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return undefined;
  if (digits.startsWith("+")) return digits;
  if (digits.length === 9 && /^[6789]/.test(digits)) return `+34${digits}`;
  return digits;
}

/** Slugify a name for use as a stable URL segment. Idempotent. */
export function slugify(input: string): string {
  return trimAll(input)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/&/g, "-and-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

/** Combine name + city for uniqueness; cap to 80 chars. */
export function buildSlug(name: string, citySlug: string): string {
  const base = slugify(`${name}-${citySlug}`);
  return base.length <= 80 ? base : base.slice(0, 80);
}

export function normalise(
  raw: ScrapedProfessional,
): ScrapedProfessional {
  return {
    ...raw,
    name: trimAll(raw.name),
    address: raw.address ? trimAll(raw.address) : undefined,
    phone: normalisePhone(raw.phone),
    email: raw.email ? raw.email.toLowerCase().trim() : undefined,
    website: raw.website ? raw.website.trim() : undefined,
    headline: raw.headline ? trimAll(raw.headline) : undefined,
    description: raw.description ? trimAll(raw.description) : undefined,
  };
}
