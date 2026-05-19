import { inflateRawSync } from "node:zlib";
import type {
  ScrapeSource,
  ScrapedProfessional,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { frPostalCodeToCitySlug, toTitleCase, splitCsvLine } from "./_bulk-utils.js";

/**
 * Ordre National des Pharmaciens (CNOP) — bulk annuaire export.
 *
 * Verified 2026-05-18. The Ordre publishes a complete public bulk
 * extract of the tableau via a single ZIP behind a generic URL — no
 * captcha, no auth, weekly refresh, declared as `application/zip`.
 *
 *   ZIP: https://www.ordre.pharmacien.fr/download/annuaire_csv.zip
 *   (alternate: /download/annuaire_json.zip — same data, JSON shape)
 *   ~6 MB compressed → ~55 MB across 4 UTF-16LE CSVs:
 *     pharmaciens_<ts>.csv      (75,582 rows; one per RPPS pharmacist)
 *     etablissements_<ts>.csv   (26,849 rows; officines + LBM + industrie)
 *     activites_<ts>.csv        (80,240 rows; pharmacist↔établissement
 *                                join with fonction + section)
 *     diplomes_<ts>.csv         (diploma history per pharmacist)
 *
 * Columns (semicolon-separated, UTF-16LE BOM):
 *   pharmaciens:    n° RPPS;Titre;Nom d'exercice;Prénom;Date première inscription
 *   etablissements: Numéro d'établissement;Type établissement;Dénomination
 *                   commerciale;Raison sociale;Adresse;Code postal;Commune;
 *                   Département;Région;Téléphone;Fax
 *   activites:      n° RPPS pharmacien;Numéro d'établissement;Fonction;
 *                   Date d'inscription;Section;Activité principale
 *
 * Strategy:
 *   1. Download + parse the three CSVs.
 *   2. Index établissements by id, activités by pharmacist.
 *   3. For each pharmacist, pick the primary activity (Activité principale
 *      = "O"), join to the établissement, emit one ScrapedProfessional.
 *   4. Pharmacists with NO activity (retired / not actively practising)
 *      are skipped — Prolio only wants in-tableau active pros.
 *
 * Namespace: `ordre-pharm-fr:<RPPS>` — distinct from `cnop:<FINESS>` used
 * by `cnop-pharmaciens` (which indexes officines via FINESS, not the
 * named pharmacist). The two sources are complementary, not duplicates:
 *   - cnop-pharmaciens     → officine records, license_number=FINESS
 *   - ordre-pharmaciens-fr → individual pharmacist records, license_number=RPPS
 *
 * Category: `farmacia` (new category, see prolio-types.ts).
 *
 * License: open access for non-commercial reuse per CNOP ToS;
 * Prolio's use (matching pros to verified license info, no
 * redistribution of the file itself) is in-scope.
 *
 * Off by default. `PROLIO_RUN_ORDRE_PHARMACIENS_FR=true`. Cap with
 * `PROLIO_ORDRE_PHARMACIENS_FR_LIMIT` (default 80000 = full set).
 * Override URL with `PROLIO_ORDRE_PHARMACIENS_FR_URL`.
 */

const ZIP_URL =
  "https://www.ordre.pharmacien.fr/download/annuaire_csv.zip";
const DEFAULT_LIMIT = 80_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
}

function findEndOfCentralDir(buf: Buffer): number {
  const sig = 0x06054b50;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

function parseCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDir(buf);
  if (eocd < 0) return [];
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let off = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const fnLen = buf.readUInt16LE(off + 28);
    const exLen = buf.readUInt16LE(off + 30);
    const ccLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + fnLen).toString("utf8");
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method,
      localHeaderOffset,
    });
    off += 46 + fnLen + exLen + ccLen;
  }
  return entries;
}

function readZipEntryData(buf: Buffer, entry: ZipEntry): Buffer | null {
  let lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const fnLen = buf.readUInt16LE(lh + 26);
  const exLen = buf.readUInt16LE(lh + 28);
  lh += 30 + fnLen + exLen;
  const slice = buf.slice(lh, lh + entry.compressedSize);
  if (entry.method === 0) return slice;
  if (entry.method === 8) {
    try {
      return inflateRawSync(slice, { maxOutputLength: 256 * 1024 * 1024 });
    } catch (e) {
      console.warn(
        `[ordre-pharmaciens-fr] inflate ${entry.name} failed: ${(e as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

function decodeUtf16Le(buf: Buffer): string {
  // Strip BOM if present.
  let offset = 0;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) offset = 2;
  return buf.toString("utf16le", offset);
}

interface PharmRow {
  rpps: string;
  titre: string;
  nom: string;
  prenom: string;
  dateInscription: string;
}

interface EtabRow {
  id: string;
  type: string;
  denominationCommerciale: string;
  raisonSociale: string;
  adresse: string;
  codePostal: string;
  commune: string;
  departement: string;
  region: string;
  telephone: string;
}

interface ActiviteRow {
  rpps: string;
  etabId: string;
  fonction: string;
  dateInscription: string;
  section: string;
  activitePrincipale: string; // "O" yes / "N" no
}

function parsePharmaciens(text: string): PharmRow[] {
  const lines = text.split(/\r?\n/);
  const out: PharmRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const c = splitCsvLine(line, ";");
    if (c.length < 5) continue;
    const rpps = (c[0] ?? "").trim();
    if (!rpps) continue;
    out.push({
      rpps,
      titre: (c[1] ?? "").trim(),
      nom: (c[2] ?? "").trim(),
      prenom: (c[3] ?? "").trim(),
      dateInscription: (c[4] ?? "").trim(),
    });
  }
  return out;
}

function parseEtablissements(text: string): Map<string, EtabRow> {
  const lines = text.split(/\r?\n/);
  const out = new Map<string, EtabRow>();
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const c = splitCsvLine(line, ";");
    if (c.length < 11) continue;
    const id = (c[0] ?? "").trim();
    if (!id) continue;
    out.set(id, {
      id,
      type: (c[1] ?? "").trim(),
      denominationCommerciale: (c[2] ?? "").trim(),
      raisonSociale: (c[3] ?? "").trim(),
      adresse: (c[4] ?? "").trim(),
      codePostal: (c[5] ?? "").trim(),
      commune: (c[6] ?? "").trim(),
      departement: (c[7] ?? "").trim(),
      region: (c[8] ?? "").trim(),
      telephone: (c[9] ?? "").trim(),
    });
  }
  return out;
}

function parseActivites(text: string): Map<string, ActiviteRow> {
  // Returns: pharmacist RPPS → primary activity (Activité principale = "O");
  // if none flagged "O", picks the first row encountered.
  const lines = text.split(/\r?\n/);
  const primary = new Map<string, ActiviteRow>();
  const fallback = new Map<string, ActiviteRow>();
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const c = splitCsvLine(line, ";");
    if (c.length < 6) continue;
    const rpps = (c[0] ?? "").trim();
    if (!rpps) continue;
    const row: ActiviteRow = {
      rpps,
      etabId: (c[1] ?? "").trim(),
      fonction: (c[2] ?? "").trim(),
      dateInscription: (c[3] ?? "").trim(),
      section: (c[4] ?? "").trim(),
      activitePrincipale: (c[5] ?? "").trim().toUpperCase(),
    };
    if (row.activitePrincipale === "O" && !primary.has(rpps)) {
      primary.set(rpps, row);
    } else if (!fallback.has(rpps)) {
      fallback.set(rpps, row);
    }
  }
  // Merge: primary wins, fallback fills gaps.
  for (const [k, v] of fallback) {
    if (!primary.has(k)) primary.set(k, v);
  }
  return primary;
}

async function downloadZip(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/zip" },
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      console.error(`[ordre-pharmaciens-fr] ${response.status} on ${url}`);
      return null;
    }
    const ab = await response.arrayBuffer();
    return Buffer.from(ab);
  } catch (error) {
    console.error(
      `[ordre-pharmaciens-fr] download failed: ${(error as Error).message}`,
    );
    return null;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_ORDRE_PHARMACIENS_FR_URL || ZIP_URL;
  const zipBuf = await downloadZip(url);
  if (!zipBuf) return [];

  const entries = parseCentralDirectory(zipBuf);
  if (entries.length === 0) {
    console.error("[ordre-pharmaciens-fr] no entries in zip");
    return [];
  }

  const pharmEntry = entries.find((e) => /^pharmaciens_/i.test(e.name));
  const etabEntry = entries.find((e) => /^etablissements_/i.test(e.name));
  const actEntry = entries.find((e) => /^activites_/i.test(e.name));
  if (!pharmEntry || !etabEntry || !actEntry) {
    console.error(
      `[ordre-pharmaciens-fr] missing required CSVs (got: ${entries.map((e) => e.name).join(",")})`,
    );
    return [];
  }

  const pharmBuf = readZipEntryData(zipBuf, pharmEntry);
  const etabBuf = readZipEntryData(zipBuf, etabEntry);
  const actBuf = readZipEntryData(zipBuf, actEntry);
  if (!pharmBuf || !etabBuf || !actBuf) {
    console.error("[ordre-pharmaciens-fr] entry inflate failed");
    return [];
  }

  const pharmaciens = parsePharmaciens(decodeUtf16Le(pharmBuf));
  const etabs = parseEtablissements(decodeUtf16Le(etabBuf));
  const activites = parseActivites(decodeUtf16Le(actBuf));
  console.log(
    `[ordre-pharmaciens-fr] parsed pharmaciens=${pharmaciens.length} etabs=${etabs.size} primary-activities=${activites.size}`,
  );

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let skippedNoActivity = 0;
  let skippedNoCity = 0;

  for (const p of pharmaciens) {
    if (out.length >= limit) break;
    if (seen.has(p.rpps)) continue;
    const act = activites.get(p.rpps);
    if (!act) {
      skippedNoActivity += 1;
      continue;
    }
    const etab = act.etabId ? etabs.get(act.etabId) : undefined;
    const cp = etab?.codePostal ?? "";
    const citySlug = frPostalCodeToCitySlug(cp);
    if (!citySlug) {
      skippedNoCity += 1;
      continue;
    }
    seen.add(p.rpps);

    const displayName = toTitleCase(`${p.prenom} ${p.nom}`.trim());
    const addressParts = [etab?.adresse, etab?.codePostal, etab?.commune]
      .map((s) => (s ?? "").trim())
      .filter(Boolean);

    out.push(
      normalise({
        source: "ordre-pharmaciens-fr" as ScrapeSource,
        country: "FR",
        sourceId: `ordre-pharm-fr:${p.rpps}`,
        name: displayName || `${p.titre} ${p.nom}`.trim(),
        categoryKey: "farmacia",
        citySlug,
        phone: etab?.telephone || undefined,
        address: addressParts.length ? addressParts.join(", ") : undefined,
        licenseNumber: p.rpps,
        metadata: {
          country: "FR",
          authority: "Ordre National des Pharmaciens (CNOP)",
          verified_by_authority: true,
          profession: "pharmacien",
          rpps: p.rpps,
          titre: p.titre || undefined,
          date_premiere_inscription: p.dateInscription || undefined,
          fonction: act.fonction || undefined,
          section: act.section || undefined,
          etablissement_id: act.etabId || undefined,
          etablissement_type: etab?.type || undefined,
          etablissement_nom:
            etab?.denominationCommerciale || etab?.raisonSociale || undefined,
          raw_postal_code: cp || undefined,
          raw_commune: etab?.commune || undefined,
          raw_departement: etab?.departement || undefined,
          raw_region: etab?.region || undefined,
        },
      }),
    );
  }

  console.log(
    `[ordre-pharmaciens-fr] emitted=${out.length} skipped_no_activity=${skippedNoActivity} skipped_no_city=${skippedNoCity}`,
  );
  return out;
}

export const ordrePharmaciensFrSource: ScraperSource = {
  name: "ordre-pharmaciens-fr" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_ORDRE_PHARMACIENS_FR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOrdrePharmaciensFr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!ordrePharmaciensFrSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_ORDRE_PHARMACIENS_FR_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[ordre-pharmaciens-fr] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
