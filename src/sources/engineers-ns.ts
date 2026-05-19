import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import {
  imisLoad,
  imisPostback,
  imisPaginate,
  type ImisRow,
} from "./_imis-utils.js";

/**
 * Engineers Nova Scotia — public member & company directory.
 *
 * iMIS-hosted public register. ~5–10k engineers in NS. We POST a wildcard
 * last-name filter ("a"…"z") to walk the entire roster, then page through
 * each result grid via __doPostBack.
 *
 * Category: ingenieria. Off-by-default; PROLIO_RUN_ENGINEERS_NS=true.
 */

const DEFAULT_URL =
  "https://portal.engineersnovascotia.ca/ENS/ENS/Public-Register/Member-and-Company-Directory.aspx";
const URL_ENV = process.env.PROLIO_ENGINEERS_NS_URL || DEFAULT_URL;
const DEFAULT_LIMIT = 10_000;
const MAX_PAGES_PER_LETTER = 50;

// iMIS control IDs vary by tenant. These are our best guesses based on the
// "Member-and-Company-Directory" page layout; if they don't match at runtime,
// override via env so we don't need a redeploy to fix a regression.
const LASTNAME_FIELD =
  process.env.PROLIO_ENGINEERS_NS_LASTNAME_FIELD ||
  "ctl01$TemplateBody$WebPartManager1$gwpciNewQueryMenuCommon$ciNewQueryMenuCommon$ResultsGrid$Sheet0$Input0$TextBox1";
const SEARCH_TARGET =
  process.env.PROLIO_ENGINEERS_NS_SEARCH_TARGET ||
  "ctl01$TemplateBody$WebPartManager1$gwpciNewQueryMenuCommon$ciNewQueryMenuCommon$ResultsGrid$Sheet0$SubmitButton";
const PAGER_TARGET =
  process.env.PROLIO_ENGINEERS_NS_PAGER_TARGET ||
  "ctl01$TemplateBody$WebPartManager1$gwpciNewQueryMenuCommon$ciNewQueryMenuCommon$ResultsGrid$Grid1";
const TABLE_MARKER =
  process.env.PROLIO_ENGINEERS_NS_TABLE_MARKER || "ResultsGrid";

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

interface RawMember {
  name: string;
  city?: string;
  licenseNumber?: string;
  status?: string;
}

function mapRow(row: ImisRow): RawMember | null {
  const [c0, c1, c2, c3] = row.cells;
  if (!c0) return null;
  // Header rows: cells often include "Name", "City", etc.
  if (/^name$/i.test(c0)) return null;
  const name = (c0 || "").trim();
  if (!name) return null;
  return {
    name,
    licenseNumber: c1?.trim() || undefined,
    city: c2?.trim() || undefined,
    status: c3?.trim() || undefined,
  };
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const letter of LETTERS) {
    if (out.length >= limit) break;
    try {
      const initial = await imisLoad(URL_ENV);
      const submit = await imisPostback(URL_ENV, initial.tokens, {
        url: URL_ENV,
        formFields: { [LASTNAME_FIELD]: letter },
        eventTarget: SEARCH_TARGET,
        cookieJar: initial.cookieJar,
      });
      const rows = await imisPaginate<RawMember>(submit.html, submit.tokens, {
        url: URL_ENV,
        formFields: { [LASTNAME_FIELD]: letter },
        pagerTarget: PAGER_TARGET,
        tableMarker: TABLE_MARKER,
        maxPages: MAX_PAGES_PER_LETTER,
        maxRows: limit - out.length,
        cookieJar: submit.cookieJar,
        mapRow: (r) => mapRow(r),
      });
      let added = 0;
      for (const r of rows) {
        const key = `${r.name}|${r.licenseNumber ?? ""}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          normalise({
            source: "engineers-ns",
            country: "CA",
            sourceId: `engineers-ns:${r.licenseNumber || key}`,
            name: toTitleCase(r.name),
            categoryKey: "ingenieria",
            citySlug: r.city ? toCitySlug(r.city) : "unknown",
            licenseNumber: r.licenseNumber,
            metadata: {
              country: "CA",
              province: "NS",
              authority: "Engineers Nova Scotia",
              verified_by_authority: true,
              status: r.status,
            },
          }),
        );
        added += 1;
        if (out.length >= limit) break;
      }
      console.log(`[engineers-ns] letter=${letter} → +${added} (total=${out.length})`);
    } catch (error) {
      console.error(
        `[engineers-ns] letter=${letter} failed: ${(error as Error).message}`,
      );
    }
  }
  return out;
}

function toCitySlug(city: string): string {
  return city
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const engineersNsSource: ScraperSource = {
  name: "engineers-ns",
  enabled() {
    return process.env.PROLIO_RUN_ENGINEERS_NS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runEngineersNs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!engineersNsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_ENGINEERS_NS_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[engineers-ns] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
