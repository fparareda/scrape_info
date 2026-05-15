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
 * PEGNL — Professional Engineers and Geoscientists of Newfoundland & Labrador.
 *
 * iMIS-hosted public register (company search variant). ~3k engineers in NL.
 * Walked via wildcard name letters. Category: ingenieria.
 * Off-by-default; PROLIO_RUN_PEGNL_NL=true.
 */

const DEFAULT_URL =
  "https://members.pegnl.ca/PEGNL/Shared_Content/PublicRegister/CompanySearch.aspx";
const URL_ENV = process.env.PROLIO_PEGNL_NL_URL || DEFAULT_URL;
const DEFAULT_LIMIT = 5_000;
const MAX_PAGES_PER_LETTER = 50;

const NAME_FIELD =
  process.env.PROLIO_PEGNL_NL_NAME_FIELD ||
  "ctl01$TemplateBody$WebPartManager1$gwpciNewQueryMenuCommon$ciNewQueryMenuCommon$ResultsGrid$Sheet0$Input0$TextBox1";
const SEARCH_TARGET =
  process.env.PROLIO_PEGNL_NL_SEARCH_TARGET ||
  "ctl01$TemplateBody$WebPartManager1$gwpciNewQueryMenuCommon$ciNewQueryMenuCommon$ResultsGrid$Sheet0$SubmitButton";
const PAGER_TARGET =
  process.env.PROLIO_PEGNL_NL_PAGER_TARGET ||
  "ctl01$TemplateBody$WebPartManager1$gwpciNewQueryMenuCommon$ciNewQueryMenuCommon$ResultsGrid$Grid1";
const TABLE_MARKER = process.env.PROLIO_PEGNL_NL_TABLE_MARKER || "ResultsGrid";

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

interface RawEntry {
  name: string;
  city?: string;
  licenseNumber?: string;
  status?: string;
}

function mapRow(row: ImisRow): RawEntry | null {
  const [c0, c1, c2, c3] = row.cells;
  if (!c0) return null;
  if (/^(name|company)$/i.test(c0)) return null;
  const name = c0.trim();
  if (!name) return null;
  return {
    name,
    licenseNumber: c1?.trim() || undefined,
    city: c2?.trim() || undefined,
    status: c3?.trim() || undefined,
  };
}

function toCitySlug(city: string): string {
  return city
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
        formFields: { [NAME_FIELD]: letter },
        eventTarget: SEARCH_TARGET,
        cookieJar: initial.cookieJar,
      });
      const rows = await imisPaginate<RawEntry>(submit.html, submit.tokens, {
        url: URL_ENV,
        formFields: { [NAME_FIELD]: letter },
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
            source: "pegnl-nl",
            sourceId: `pegnl-nl:${r.licenseNumber || key}`,
            name: toTitleCase(r.name),
            categoryKey: "ingenieria",
            citySlug: r.city ? toCitySlug(r.city) : "unknown",
            licenseNumber: r.licenseNumber,
            metadata: {
              country: "CA",
              province: "NL",
              authority:
                "Professional Engineers and Geoscientists of Newfoundland & Labrador",
              verified_by_authority: true,
              status: r.status,
            },
          }),
        );
        added += 1;
        if (out.length >= limit) break;
      }
      console.log(`[pegnl-nl] letter=${letter} → +${added} (total=${out.length})`);
    } catch (error) {
      console.error(
        `[pegnl-nl] letter=${letter} failed: ${(error as Error).message}`,
      );
    }
  }
  return out;
}

export const pegnlNlSource: ScraperSource = {
  name: "pegnl-nl",
  enabled() {
    return process.env.PROLIO_RUN_PEGNL_NL === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runPegnlNl(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!pegnlNlSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_PEGNL_NL_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[pegnl-nl] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
