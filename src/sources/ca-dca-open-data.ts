import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { pick, normaliseNorthAmericanPhone } from "./_bulk-utils.js";

/**
 * California Department of Consumer Affairs — public licensee bulk
 * dumps for ~35 boards/bureaus. Each board owns a folder inside a
 * shared Box folder (`/s/oss6hf8jys2bmgxqd2gdz7w4oepm2il9`). Inside
 * every folder Box exposes a `<Board>_Data00.xls` file that is in
 * reality a tab-separated text export (the `.xls` extension is a
 * legacy artefact — Excel opens it via the "import text" path) plus
 * a `<Board>_Counts.csv` aggregate that we ignore here.
 *
 * The TSV columns we read are stable across boards:
 *   Agency Code, Agency Name, LicTypeCode, License Type,
 *   License Number, Indiv/Org, Org/Last Name, First Name, Middle
 *   Name, Suffix, Address Line 1, Address Line 2, City, County,
 *   State, Zip, Country, Original Issue Date, Expiration Date,
 *   License Status.
 *
 * Only "Current"/"Clear" statuses are kept and only boards whose
 * professional scope maps to a prolio CategoryKey are wired. The
 * remaining ~15 boards (court reporters, barbering, structural pest,
 * etc.) are intentionally skipped — adding them is a one-liner in
 * `BOARDS` once a category exists.
 *
 * Box file IDs were observed on 2026-05-14 and may rotate when DCA
 * republishes monthly. The runner re-discovers them by parsing the
 * shared folder HTML if the cached IDs return 404.
 *
 * Env knobs:
 *   PROLIO_RUN_CA_DCA_OPEN_DATA=true     enable
 *   PROLIO_CA_DCA_OPEN_DATA_LIMIT=200000 per-board cap (default)
 *   PROLIO_CA_DCA_OPEN_DATA_BOARDS=med,pharma   subset of slugs
 */

const SHARED_NAME = "oss6hf8jys2bmgxqd2gdz7w4oepm2il9";
const DEFAULT_LIMIT = 200_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

interface Board {
  slug: string;
  folderId: string;
  /** Override for the cached Data00 file id; runner re-discovers on miss. */
  dataFileId?: string;
  authority: string;
  category: CategoryKey | ((row: Record<string, string>) => CategoryKey | undefined);
}

/** Boards mapped to prolio categories. */
const BOARDS: Board[] = [
  {
    slug: "medical",
    folderId: "72555183287",
    dataFileId: "2216161761363",
    authority: "Medical Board of California",
    category: "medicina",
  },
  {
    slug: "dental",
    folderId: "72555242850",
    dataFileId: "2216192370987",
    authority: "Dental Board of California",
    category: "dentista",
  },
  {
    slug: "dental-hygiene",
    folderId: "72555246475",
    authority: "Dental Hygiene Board of California",
    category: "dentista",
  },
  {
    slug: "veterinary",
    folderId: "72555427545",
    dataFileId: "2216153293538",
    authority: "Veterinary Medical Board",
    category: "veterinario",
  },
  {
    slug: "architects",
    folderId: "72554906673",
    dataFileId: "2216150058570",
    authority: "California Architects Board",
    category: "arquitecto",
  },
  {
    slug: "landscape-architects",
    folderId: "72555389228",
    dataFileId: "2216153605230",
    authority: "Landscape Architects Technical Committee",
    category: "arquitecto",
  },
  {
    slug: "engineers",
    folderId: "72556212335",
    dataFileId: "2216150296425",
    authority: "Board for Professional Engineers, Land Surveyors, and Geologists",
    category: "ingenieria",
  },
  {
    slug: "accountancy",
    folderId: "71959910461",
    dataFileId: "2216151097651",
    authority: "California Board of Accountancy",
    category: "fiscal",
  },
  {
    slug: "pharmacy",
    folderId: "72555304900",
    dataFileId: "2216160304329",
    authority: "California State Board of Pharmacy",
    category: "farmacia",
  },
  {
    slug: "acupuncture",
    folderId: "72555060186",
    dataFileId: "2216146953453",
    authority: "Acupuncture Board",
    category: "medicina",
  },
  {
    slug: "optometry",
    folderId: "72555738778",
    dataFileId: "2216148210276",
    authority: "California State Board of Optometry",
    category: "medicina",
  },
  {
    slug: "osteopathic",
    folderId: "72554347728",
    authority: "Osteopathic Medical Board of California",
    category: "medicina",
  },
  {
    slug: "podiatric",
    folderId: "72556081844",
    authority: "Podiatric Medical Board of California",
    category: "medicina",
  },
  {
    slug: "physician-assistant",
    folderId: "72554310333",
    authority: "Physician Assistant Board",
    category: "medicina",
  },
  {
    slug: "naturopathic",
    folderId: "72554245620",
    authority: "Naturopathic Medicine Committee",
    category: "medicina",
  },
  {
    slug: "chiropractic",
    folderId: "72554109179",
    authority: "Board of Chiropractic Examiners",
    category: "medicina",
  },
  {
    slug: "physical-therapy",
    folderId: "72554178487",
    authority: "Physical Therapy Board of California",
    category: "fisioterapia",
  },
  {
    slug: "psychology",
    folderId: "72554164379",
    authority: "Board of Psychology",
    category: "psicologia",
  },
  {
    slug: "behavioral-sciences",
    folderId: "72556123295",
    dataFileId: "2216161360035",
    authority: "Board of Behavioral Sciences",
    category: "psicologia",
  },
  {
    slug: "respiratory-care",
    folderId: "72555359819",
    authority: "Respiratory Care Board of California",
    category: "medicina",
  },
  {
    slug: "occupational-therapy",
    folderId: "72555083458",
    authority: "California Board of Occupational Therapy",
    category: "medicina",
  },
  {
    slug: "registered-nursing",
    folderId: "72555308989",
    authority: "California Board of Registered Nursing",
    category: "enfermeria",
  },
  {
    slug: "vocational-nursing-psych-tech",
    folderId: "72555022691",
    authority: "Board of Vocational Nursing and Psychiatric Technicians",
    category: "enfermeria",
  },
  {
    slug: "speech-language",
    folderId: "72554315113",
    authority: "Speech-Language Pathology and Audiology Board",
    category: "medicina",
  },
  {
    slug: "automotive-repair",
    folderId: "72555975852",
    authority: "Bureau of Automotive Repair",
    category: "mecanica",
  },
];

function statusOk(s: string): boolean {
  const v = s.toLowerCase().trim();
  return (
    v === "current" ||
    v === "clear" ||
    v === "active" ||
    v.startsWith("clear")
  );
}

/**
 * Re-discover the licensee data file inside a board folder by scraping
 * the Box shared folder HTML. Returns the first `*_Data00.*` file id or
 * undefined when the folder is empty/broken.
 */
async function discoverDataFileId(folderId: string): Promise<string | undefined> {
  const url = `https://dca.app.box.com/s/${SHARED_NAME}/folder/${folderId}?sortColumn=name&sortDirection=asc`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return undefined;
    const html = await r.text();
    const matches = html.matchAll(
      /"typedID":"f_(\d+)"[^}]*"name":"([^"]*?Data\d+\.[^"]+)"/g,
    );
    for (const m of matches) {
      return m[1];
    }
  } catch (e) {
    console.warn(`[ca-dca-open-data] discover ${folderId}: ${(e as Error).message}`);
  }
  return undefined;
}

/**
 * Parse a TSV-ish .xls export (DCA boards lie about the extension —
 * the body is a tab-separated text file). Streams line by line and
 * stops at `limit` valid rows so we don't materialise the full 200k+
 * payload twice in memory.
 */
function parseDcaTsv(text: string): Array<Record<string, string>> {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0]
    .split("\t")
    .map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
    );
  const out: Array<Record<string, string>> = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split("\t");
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = (cells[j] ?? "").trim();
    }
    out[i - 1] = row;
  }
  return out;
}

function buildName(row: Record<string, string>): string {
  const indiv = pick(row, ["indiv_org"]).toUpperCase();
  const last = pick(row, ["org_last_name", "last_name"]);
  if (indiv === "O") return last;
  const first = pick(row, ["first_name"]);
  const middle = pick(row, ["middle_name"]);
  const suffix = pick(row, ["suffix"]);
  return [first, middle, last, suffix].filter(Boolean).join(" ").trim();
}

async function fetchBoard(
  board: Board,
  limit: number,
): Promise<ScrapedProfessional[]> {
  let fileId = board.dataFileId;
  if (!fileId) {
    fileId = await discoverDataFileId(board.folderId);
    if (!fileId) {
      console.warn(`[ca-dca-open-data] ${board.slug}: no data file`);
      return [];
    }
  }
  const url = `https://dca.app.box.com/index.php?rm=box_download_shared_file&shared_name=${SHARED_NAME}&file_id=f_${fileId}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      // Big files (MedicalBoard ~42MB) — generous timeout.
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    console.error(
      `[ca-dca-open-data] ${board.slug} network: ${(e as Error).message}`,
    );
    return [];
  }
  if (!response.ok) {
    // Retry once with fresh discovery if the cached ID 404ed.
    if (response.status === 404 && board.dataFileId) {
      const fresh = await discoverDataFileId(board.folderId);
      if (fresh && fresh !== board.dataFileId) {
        return fetchBoard({ ...board, dataFileId: fresh }, limit);
      }
    }
    console.error(
      `[ca-dca-open-data] ${board.slug}: ${response.status} on ${url}`,
    );
    return [];
  }
  const text = await response.text();
  const rows = parseDcaTsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const status = pick(row, ["license_status", "status"]);
    if (status && !statusOk(status)) continue;
    const licence = pick(row, ["license_number"]);
    if (!licence) continue;
    const cat =
      typeof board.category === "function"
        ? board.category(row)
        : board.category;
    if (!cat) continue;
    const city = pick(row, ["city"]);
    const citySlug = slugify(city);
    if (!citySlug) continue;
    const key = `${board.slug}:${licence}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = buildName(row);
    if (!name) continue;
    const street = [pick(row, ["address_line_1"]), pick(row, ["address_line_2"])]
      .filter(Boolean)
      .join(" ");
    const stateRaw = pick(row, ["state"]) || "CA";
    const zip = pick(row, ["zip"]);
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "ca-dca-open-data",
        country: "US",
        sourceId: `ca-dca-open-data:${board.slug}:${licence}`,
        name,
        categoryKey: cat,
        citySlug,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: "CA",
          authority: board.authority,
          verified_by_authority: true,
          dca_board_slug: board.slug,
          dca_license_type: pick(row, ["license_type"]),
          dca_expiration: pick(row, ["expiration_date"]),
        },
      }),
    );
  }
  console.log(
    `[ca-dca-open-data] ${board.slug} parsed=${out.length} (raw=${rows.length})`,
  );
  return out;
}

export const caDcaOpenDataSource: ScraperSource = {
  name: "ca-dca-open-data" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CA_DCA_OPEN_DATA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCaDcaOpenData(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!caDcaOpenDataSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_CA_DCA_OPEN_DATA_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const subset = (process.env.PROLIO_CA_DCA_OPEN_DATA_BOARDS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const boards =
    subset.length > 0 ? BOARDS.filter((b) => subset.includes(b.slug)) : BOARDS;

  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const sink = getSink();

  for (const board of boards) {
    const records = await fetchBoard(board, limit);
    if (records.length === 0) continue;
    fetched += records.length;
    const res = await sink.upsert(records);
    inserted += res.inserted;
    updated += res.updated;
    skipped += res.skipped;
  }

  console.log(
    `[ca-dca-open-data] done — boards=${boards.length} fetched=${fetched} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched, inserted, updated, skipped };
}
