/**
 * Madrid neighbourhoods used to fan out Google Places queries. Picked for
 * high commercial density and broad geographical coverage — the goal is
 * that dense central areas return ≤20 results per query, so the 60-result
 * pagination cap stops biting us.
 */
export const MADRID_BARRIOS = [
  "Centro",
  "Chamberí",
  "Salamanca",
  "Retiro",
  "Chamartín",
  "Moncloa",
  "Tetuán",
  "Latina",
  "Hortaleza",
  "Ciudad Lineal",
  "Arganzuela",
  "Carabanchel",
];
