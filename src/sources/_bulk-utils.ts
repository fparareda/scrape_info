/**
 * Shared helpers for bulk scrapers (US contractor boards, CA provincial
 * regulators). Kept pure / dependency-free so any individual source can
 * be lifted out into its own worker by inlining these ~80 LOC.
 *
 * Older sources (CSLB, NPI, CCAA) keep their own copies of similar
 * helpers because they were written before this util existed and
 * predate the "self-contained for future extraction" decision; do not
 * retrofit them in this PR — that's a refactor with regression risk.
 */

export function splitCsvLine(line: string, sep = ","): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') inQuotes = false;
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === sep) {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Normalise a CSV header cell to a stable column key:
 *   "LICENSE NUMBER"        → "license_number"
 *   "Business Address-Line1"→ "business_address_line1"
 *   "  raison sociale "     → "raison_sociale"
 *   "BUSINESS CITY, STATE ZIP" → "business_city_state_zip"
 *
 * Fixes a bug observed 2026-05-07: Texas TDLR / Florida DBPR CSVs
 * use space-separated headers, but every scraper's `pick()` candidate
 * list was written with underscores (`license_number`). Without
 * normalisation, exact match fails and the substring fallback in
 * pick() picks wrong columns.
 */
function normaliseHeaderKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  // Auto-detect ; vs , separator on the header line.
  const sep =
    lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const header = splitCsvLine(lines[0], sep).map(normaliseHeaderKey);
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i], sep);
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = (cells[j] ?? "").trim();
    }
    out.push(row);
  }
  return out;
}

/**
 * Pick the first non-empty value from `row` whose header matches one
 * of `candidates`. First tries exact match, then substring. Useful
 * when an open-data CSV reshuffles or renames columns.
 */
export function pick(
  row: Record<string, string>,
  candidates: string[],
): string {
  for (const k of candidates) if (row[k]) return row[k];
  for (const k of Object.keys(row)) {
    for (const c of candidates) {
      if (k.includes(c) && row[k]) return row[k];
    }
  }
  return "";
}

/** US/CA E.164 normaliser. Returns undefined if input doesn't match. */
export function normaliseNorthAmericanPhone(
  raw: string | undefined,
): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map a French postal code (5 digits) to a slug seeded in `cities`.
 *
 * Two-tier lookup:
 *   1. FR_POSTAL_TO_CITY_SLUG — direct 5-digit CP → specific commune
 *      slug, for the ~270 communes seeded in migration 0074.
 *   2. FR_DEPARTMENT_TO_CITY_SLUG — fallback by 2-digit department,
 *      rolling up to that department's largest seeded metro for any
 *      CP not in the direct map (rural communes, smaller towns).
 *
 * This is what makes CNB Avocats, RPPS-FR and Annuaire Santé Ameli
 * upsert meaningful volume without seeding 35,000 individual communes.
 *
 * Returns null when neither tier yields a hit (very rural areas in
 * unseeded departments) — sink filters those rows silently.
 */
// Direct 5-digit CP → seeded city slug. Only includes CPs whose target
// slug is actually present in the cities table (migrations 0067 + 0074).
// CPs not in this map fall through to the 2-digit department lookup.
const FR_POSTAL_TO_CITY_SLUG: Record<string, string> = {
  // Hauts-de-Seine (92)
  "92100": "boulogne-billancourt",
  "92110": "clichy",
  "92120": "montrouge",
  "92130": "issy-les-moulineaux",
  "92140": "clamart",
  "92150": "suresnes",
  "92160": "antony",
  "92220": "bagneux",
  "92230": "gennevilliers",
  "92290": "chatenay-malabry",
  "92300": "levallois-perret",
  "92400": "courbevoie",
  "92500": "rueil-malmaison",
  "92600": "asnieres-sur-seine",
  "92700": "colombes",
  "92800": "puteaux",
  // Seine-Saint-Denis (93)
  "93110": "rosny-sous-bois",
  "93140": "bondy",
  "93150": "le-blanc-mesnil",
  "93160": "noisy-le-grand",
  "93190": "livry-gargan",
  "93200": "saint-denis",
  "93210": "saint-denis",
  "93220": "gagny",
  "93240": "stains",
  "93270": "sevran",
  "93300": "aubervilliers",
  "93390": "clichy-sous-bois",
  "93400": "saint-ouen-sur-seine",
  "93420": "villepinte",
  "93500": "pantin",
  "93600": "aulnay-sous-bois",
  "93700": "drancy",
  "93800": "epinay-sur-seine",
  // Val-de-Marne (94)
  "94100": "saint-maur-des-fosses",
  "94120": "fontenay-sous-bois",
  "94140": "alfortville",
  "94170": "le-perreux-sur-marne",
  "94200": "ivry-sur-seine",
  "94300": "vincennes",
  "94320": "thiais",
  "94400": "vitry-sur-seine",
  "94500": "champigny-sur-marne",
  "94800": "villejuif",
  // Yvelines (78)
  "78000": "versailles",
  "78200": "mantes-la-jolie",
  "78300": "poissy",
  "78370": "plaisir",
  "78400": "chatou",
  "78500": "sartrouville",
  // Essonne (91)
  "91000": "evry-courcouronnes",
  "91100": "corbeil-essonnes",
  "91120": "palaiseau",
  "91170": "viry-chatillon",
  "91200": "athis-mons",
  "91300": "massy",
  "91600": "savigny-sur-orge",
  "91700": "sainte-genevieve-des-bois",
  // Seine-et-Marne (77)
  "77100": "meaux",
  "77120": "coulommiers",
  "77300": "fontainebleau",
  "77380": "combs-la-ville",
  "77500": "chelles",
  "77200": "torcy",
  "77210": "avon",
  // Val-d'Oise (95)
  "95100": "argenteuil",
  "95140": "garges-les-gonesse",
  "95200": "sarcelles",
  "95220": "herblay-sur-seine",
  "95800": "cergy",
  // Bouches-du-Rhône (13) — Marseille arrondissements + main communes
  "13001": "marseille", "13002": "marseille", "13003": "marseille",
  "13004": "marseille", "13005": "marseille", "13006": "marseille",
  "13007": "marseille", "13008": "marseille", "13009": "marseille",
  "13010": "marseille", "13011": "marseille", "13012": "marseille",
  "13013": "marseille", "13014": "marseille", "13015": "marseille",
  "13016": "marseille",
  "13100": "aix-en-provence",
  "13120": "gardanne",
  "13127": "vitrolles",
  "13130": "berre-l-etang",
  "13140": "miramas",
  "13200": "arles",
  "13290": "aix-en-provence",
  "13300": "salon-de-provence",
  "13400": "aubagne",
  "13500": "martigues",
  "13600": "la-ciotat",
  "13700": "marignane",
  "13800": "istres",
  // Vaucluse (84) — Orange disambiguation
  "84100": "orange-fr",
  "84200": "carpentras",
  "84300": "cavaillon",
  "84400": "apt",
  "84700": "sorgues",
  "84000": "avignon",
  // Saône-et-Loire (71) — Mâcon disambiguation
  "71000": "macon-fr",
  "71100": "chalon-sur-saone",
  // Réunion (974) — Saint-Paul disambiguation, plus other 974 communes
  "97400": "saint-denis",
  "97419": "la-possession",
  "97420": "le-port",
  "97428": "saint-leu",
  "97430": "le-tampon",
  "97436": "saint-leu",
  "97438": "sainte-marie",
  "97440": "saint-andre",
  "97450": "saint-louis",
  "97415": "saint-paul-fr",
  "97460": "saint-paul-fr",
  // Mayotte (976)
  "97600": "mamoudzou",
  // Guyane (973)
  "97300": "cayenne",
  "97320": "saint-laurent-du-maroni",
  // Alpes-Maritimes (06) — specific seeded communes vs. nice fallback
  "06110": "le-cannet",
  "06150": "cannes",
  "06160": "antibes",
  "06220": "vallauris",
  "06250": "mougins",
  "06400": "cannes",
  "06500": "menton",
  "06600": "antibes",
  "06700": "saint-laurent-du-var",
  "06800": "cagnes-sur-mer",
  "06130": "grasse",
  "06140": "vence",
  "06210": "mandelieu-la-napoule",
  "06160-2": "antibes",
  // Var (83) — specific seeded communes vs. toulon fallback
  "83300": "draguignan",
  "83400": "hyeres",
  "83600": "frejus",
  // Hérault (34) — Montpellier metro
  "34070": "montpellier",
  "34170": "castelnau-le-lez",
  "34250": "lattes",
  "34290": "agde",
  "34300": "agde",
  "34400": "lunel",
  "34500": "beziers",
  "34600": "ales",
  "34970": "lattes",
  // Gard (30) — Nîmes + Alès
  "30100": "ales",
  "30200": "bagnols-sur-ceze",
  // Haute-Garonne (31) — Toulouse metro
  "31700": "blagnac",
  "31770": "colomiers",
  "31170": "tournefeuille",
  "31600": "muret",
  // Aude (11)
  "11000": "carcassonne",
  "11100": "narbonne",
  // Aveyron (12)
  "12000": "rodez",
  "12100": "millau",
  // Pyrénées-Atlantiques (64) — Pau metro
  "64100": "bayonne",
  "64200": "biarritz",
  "64600": "anglet",
  // Landes (40)
  "40100": "dax",
  "40000": "mont-de-marsan",
  // Gironde (33) — Bordeaux metro
  "33170": "gradignan",
  "33270": "begles",
  "33400": "talence",
  "33500": "libourne",
  "33600": "pessac",
  "33700": "merignac",
  "33110": "le-bouscat",
  "33120": "arcachon",
  "33140": "villenave-d-ornon",
  "33160": "saint-medard-en-jalles",
  // Dordogne (24)
  "24000": "perigueux",
  "24100": "bergerac",
  "24200": "sarlat-la-caneda",
  // Corrèze (19)
  "19100": "brive-la-gaillarde",
  "19000": "tulle",
  // Creuse (23)
  "23000": "gueret",
  // Allier (03)
  "03000": "moulins",
  "03100": "montlucon",
  "03200": "vichy",
  // Cantal (15)
  "15000": "aurillac",
  // Haute-Loire (43)
  "43000": "le-puy-en-velay",
  // Puy-de-Dôme (63) — Clermont-Ferrand metro
  "63100": "clermont-ferrand",
  "63170": "cournon-d-auvergne",
  "63200": "riom",
  "63300": "thiers",
  "63500": "issoire",
  // Rhône (69) — Lyon metro
  "69100": "villeurbanne",
  "69120": "vaulx-en-velin",
  "69140": "rillieux-la-pape",
  "69150": "decines-charpieu",
  "69190": "saint-fons",
  "69200": "venissieux",
  "69230": "saint-genis-laval",
  "69250": "rillieux-la-pape",
  "69260": "ecully",
  "69300": "caluire-et-cuire",
  "69320": "feyzin",
  "69330": "meyzieu",
  "69500": "bron",
  "69600": "oullins",
  "69800": "saint-priest",
  "69160": "tassin-la-demi-lune",
  "69170": "tarare",
  // Ain (01)
  "01000": "bourg-en-bresse",
  "01100": "oyonnax",
  // Isère (38) — Grenoble metro
  "38130": "echirolles",
  "38240": "meylan",
  "38400": "saint-martin-d-heres",
  "38600": "fontaine",
  "38800": "echirolles",
  "38170": "seyssinet-pariset",
  "38500": "voiron",
  // Ardèche (07)
  "07100": "annonay",
  "07200": "aubenas",
  "07000": "privas",
  // Drôme (26)
  "26200": "montelimar",
  "26100": "romans-sur-isere",
  // Alpes-de-Haute-Provence (04)
  "04000": "digne-les-bains",
  "04100": "manosque",
  // Hautes-Alpes (05)
  "05100": "briancon",
  "05000": "gap",
  // Moselle (57) — Metz metro
  "57100": "thionville",
  "57200": "sarreguemines",
  "57500": "saint-avold",
  "57600": "forbach",
  // Bas-Rhin (67) — Strasbourg metro
  "67300": "schiltigheim",
  "67500": "haguenau",
  // Meurthe-et-Moselle (54) — Nancy metro
  "54400": "luneville",
  "54200": "toul",
  "54500": "vandoeuvre-les-nancy",
  // Marne (51) — Reims/Châlons
  "51000": "chalons-en-champagne",
  "51100": "reims",
  "51200": "epernay",
  "51300": "vitry-le-francois",
  // Haute-Marne (52)
  "52000": "chaumont",
  "52100": "saint-dizier",
  // Ardennes (08)
  "08000": "charleville-mezieres",
  // Aube (10)
  "10000": "troyes",
  // Loir-et-Cher (41)
  "41000": "blois",
  "41100": "vendome",
  "41200": "romorantin-lanthenay",
  // Indre-et-Loire (37) — Tours metro
  "37100": "tours",
  "37300": "joue-les-tours",
  // Loiret (45)
  "45000": "orleans",
  "45190": "beaugency",
  // Cher (18)
  "18000": "bourges",
  // Eure-et-Loir (28)
  "28000": "chartres",
  // Vienne (86)
  "86000": "poitiers",
  "86100": "chatellerault",
  // Charente-Maritime (17)
  "17000": "la-rochelle",
  // Deux-Sèvres (79)
  "79000": "niort",
  // Lot-et-Garonne (47)
  "47000": "agen",
  // Gers (32)
  "32000": "auch",
  // Tarn (81)
  "81000": "albi",
  "81100": "castres",
  // Tarn-et-Garonne (82)
  "82000": "montauban",
  // Hautes-Pyrénées (65)
  "65000": "tarbes",
  "65200": "bagneres-de-bigorre",
  // Ariège (09)
  "09000": "foix",
  // Lozère (48)
  "48000": "mende",
  // Pyrénées-Orientales (66) — Perpignan
  // Mayenne (53)
  "53000": "laval",
  // Sarthe (72) — Le Mans
  "72000": "le-mans",
  // Maine-et-Loire (49) — Angers/Cholet
  "49100": "angers",
  "49300": "cholet",
  // Loire-Atlantique (44) — Nantes metro
  "44600": "saint-nazaire",
  "44800": "saint-herblain",
  "44400": "reze",
  // Ille-et-Vilaine (35) — Rennes/Saint-Malo
  "35400": "saint-malo",
  // Côtes-d'Armor (22)
  "22000": "saint-brieuc",
  // Morbihan (56)
  "56000": "vannes",
  "56100": "lorient",
  // Finistère (29) — Brest/Quimper
  "29000": "quimper",
  // Manche (50)
  "50100": "cherbourg-en-cotentin",
  // Calvados (14) — Caen
  // Orne (61)
  "61000": "alencon",
  // Eure (27)
  // Seine-Maritime (76) — Le Havre/Rouen/Dieppe
  "76100": "rouen",
  "76200": "dieppe",
  "76500": "elbeuf",
  // Somme (80) — Amiens
  // Pas-de-Calais (62)
  "62100": "calais",
  "62200": "boulogne-sur-mer",
  "62300": "lens",
  "62000": "arras",
  // Nord (59) — Lille metro
  "59100": "roubaix",
  "59200": "tourcoing",
  "59300": "valenciennes",
  "59400": "cambrai",
  "59140": "dunkerque",
  "59650": "villeneuve-d-ascq",
  "59240": "dunkerque",
  // Côte-d'Or (21) — Dijon
  // Doubs (25) — Besançon
  "25000": "besancon",
  // Jura (39)
  // Haute-Saône (70)
  // Territoire de Belfort (90)
  "90000": "belfort",
  // Yonne (89)
  // Nièvre (58)
  "58000": "nevers",
  // Haute-Savoie (74) — Annecy
  "74100": "annemasse",
  "74200": "thonon-les-bains",
  // Savoie (73) — Chambéry
  "73000": "chambery",
  // Loire (42) — Saint-Étienne
  "42300": "roanne",
  // Vendée (85)
  // Aisne (02)
  "02100": "saint-quentin",
  // Oise (60) — Beauvais/Compiègne
  "60100": "creil",
  "60200": "compiegne",
  // Hérault (34)
  "34000": "montpellier",
  // Drôme (26)
  "26000": "valence",
  // Vaucluse (84)
  "84140": "avignon",
};

const FR_DEPARTMENT_TO_CITY_SLUG: Record<string, string> = {
  // Île-de-France → paris (75) and inner suburbs collapse here
  "75": "paris",
  "77": "paris",
  "78": "paris",
  "91": "paris",
  "92": "boulogne-billancourt",
  "93": "paris",
  "94": "paris",
  "95": "paris",
  // Auvergne-Rhône-Alpes
  "69": "lyon",
  "38": "grenoble",
  "63": "clermont-ferrand",
  "74": "annecy",
  "42": "saint-etienne",
  // Provence-Alpes-Côte d'Azur
  "13": "marseille",
  "06": "nice",
  "83": "toulon",
  // Occitanie
  "31": "toulouse",
  "34": "montpellier",
  "30": "nimes",
  "66": "perpignan",
  "87": "limoges",
  // Nouvelle-Aquitaine
  "33": "bordeaux",
  // Pays de la Loire
  "44": "nantes",
  "49": "angers",
  "72": "le-mans",
  // Bretagne
  "35": "rennes",
  "29": "brest",
  // Grand Est
  "67": "strasbourg",
  "51": "reims",
  // Hauts-de-France
  "59": "lille",
  "80": "amiens",
  // Normandie
  "76": "le-havre",
  // Bourgogne-Franche-Comté
  "21": "dijon",
  // Centre-Val de Loire
  "37": "tours",
};

export function frPostalCodeToCitySlug(postalCode: string | undefined): string | null {
  if (!postalCode) return null;
  const cp = postalCode.replace(/\s+/g, "").trim();
  if (cp.length < 5) return null;
  const cp5 = cp.slice(0, 5);
  // Tier 1: direct CP → specific seeded commune.
  const direct = FR_POSTAL_TO_CITY_SLUG[cp5];
  if (direct) return direct;
  // Tier 2: department-level fallback for the rural long tail.
  const dept = cp5.slice(0, 2);
  // Corsica (2A/2B) is encoded as "20" in postal codes; handle 20xxx → ajaccio.
  if (dept === "20") return cp5.startsWith("201") ? "ajaccio" : null;
  // Île-de-France default: rural CPs in 77/78/91/95 fall back to paris.
  return FR_DEPARTMENT_TO_CITY_SLUG[dept] ?? null;
}

export function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((token) =>
      /\s+|-/.test(token)
        ? token
        : token.charAt(0).toUpperCase() + token.slice(1),
    )
    .join("");
}
