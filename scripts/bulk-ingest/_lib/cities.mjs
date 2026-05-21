// Cache the cities table per country from Supabase via REST.
// Returns { slugs: Set<string>, byName: Record<string, slug>, geo: [{slug, lat, lng}] }.
import { requireSupabase } from "./env.mjs";

function slugify(s) {
  if (!s) return null;
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

/**
 * Fetch all cities for a country (or multiple). Uses pagination because the
 * Supabase REST default cap is 1000 rows.
 *
 * @param {string|string[]} countries - e.g. "MX" or ["MX","ES","US","CA","FR"]
 * @returns {Promise<Record<string, {slugs: Set<string>, byName: Record<string,string>, geo: Array<{slug:string,lat:number,lng:number,name:string}>}>>}
 */
export async function loadCities(countries) {
  const { SUPABASE_URL, SERVICE_KEY } = requireSupabase();
  const list = Array.isArray(countries) ? countries : [countries];
  const result = {};
  for (const cc of list) {
    const rows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const url = `${SUPABASE_URL}/rest/v1/cities?select=slug,name,lat,lng&country=eq.${cc}&order=slug.asc&limit=${PAGE}&offset=${offset}`;
      const r = await fetch(url, {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
      });
      if (!r.ok) throw new Error(`cities fetch ${cc} HTTP ${r.status}`);
      const page = await r.json();
      rows.push(...page);
      if (page.length < PAGE) break;
      offset += PAGE;
    }
    const slugs = new Set(rows.map(c => c.slug));
    const byName = {};
    const geo = [];
    for (const c of rows) {
      if (c.name) byName[c.name.toLowerCase().trim()] = c.slug;
      if (typeof c.lat === "number" && typeof c.lng === "number") {
        geo.push({ slug: c.slug, lat: c.lat, lng: c.lng, name: c.name });
      }
    }
    result[cc] = { slugs, byName, geo };
  }
  return result;
}

/**
 * Resolve a free-text city name to a canonical slug for a given country index.
 * Order: exact name match → slugify match → strip leading articles → null.
 */
export function resolveCity(index, name) {
  if (!index || !name) return null;
  const { slugs, byName } = index;
  const lc = name.toLowerCase().trim();
  if (byName[lc]) return byName[lc];
  const s = slugify(name);
  if (s && slugs.has(s)) return s;
  const stripped = lc.replace(/^(l'|el |la |le |les |de |de la |del |the )/i, "").trim();
  if (byName[stripped]) return byName[stripped];
  const ss = slugify(stripped);
  if (ss && slugs.has(ss)) return ss;
  return null;
}

/**
 * Find the nearest city slug within ~55km using a bounding-box prune.
 * Returns null if no city is within range. Useful as a fallback when the
 * source row only has lat/lng (e.g. OSM points without addr:city).
 */
export function nearestCity(geo, lat, lng) {
  if (!Array.isArray(geo) || geo.length === 0) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null, bestDsq = Infinity;
  for (const c of geo) {
    const dLat = c.lat - lat;
    const dLng = c.lng - lng;
    if (Math.abs(dLat) > 0.5 || Math.abs(dLng) > 0.7) continue;
    const dsq = dLat * dLat + dLng * dLng * 0.7;
    if (dsq < bestDsq) { bestDsq = dsq; best = c; }
  }
  return best && bestDsq < 0.25 ? best.slug : null;
}

export { slugify };
