/**
 * World Bank — World Development Indicators (WDI) adapter.
 *
 * Sources (verified Nov 2026), World Bank API v2, no key, CC BY 4.0:
 *  - /source/2/indicator lists the ~1,500 WDI indicators with name, unit,
 *    short definition (sourceNote), source organisation and topics.
 *  - /sources/2/series/<id>/metadata gives the full metadata: long
 *    definition, statistical concept and methodology, limitations,
 *    development relevance, aggregation, periodicity, licence.
 *  - /sources/2/series/all/metadata returns the same for every indicator,
 *    paged by number of fields (~20 pages of 1,000 fields, ~90 s each).
 *    Uncached single requests can also take ~80 s, so full runs use the
 *    bulk pages and small test runs use single requests.
 */
import type { UnifiedIndicator } from "../types.ts";
import { tidy } from "./html-to-md.ts";
import { PoliteFetcher } from "./http.ts";
import { truncate } from "./sdg.ts";
import type { Adapter, AdapterStats, FetchOptions } from "./types.ts";

export const WB_API = "https://api.worldbank.org/v2";
export const WDI_SOURCE_ID = "2";

export interface WbIndicator {
  id: string;
  name: string;
  unit?: string | null;
  sourceNote?: string | null;
  sourceOrganization?: string | null;
  topics?: { id?: string; value?: string | null }[] | null;
}

/** Metadata fields, keyed by the API's metatype id (e.g. "Longdefinition"). */
export type WbMetadata = Record<string, string>;

const METHODOLOGY_FIELDS: [string, string][] = [
  ["Statisticalconceptandmethodology", "Statistical concept and methodology"],
  ["Limitationsandexceptions", "Limitations and exceptions"],
  ["Developmentrelevance", "Development relevance"],
  ["Aggregationmethod", "Aggregation method"],
  ["Othernotes", "Other notes"],
];
const SECTION_MAX_CHARS = 8_000;

/** WB texts are plain text with long runs of blank lines. */
export function cleanText(text: string | null | undefined): string {
  if (!text) return "";
  return tidy(
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .join("\n"),
  );
}

interface WbMetadataResponse {
  pages?: number | string;
  source?: {
    concept?: { id?: string; variable?: { id: string; metatype?: { id: string; value: string | null }[] }[] }[];
  }[];
}

/**
 * Merge the Series variables of a metadata response into `into`
 * (`seriesId → { metatypeId: value }`). Bulk pages are cut by number of
 * fields, so one series can be split across two pages: fields are merged.
 */
export function mergeWbMetadataPage(json: unknown, into = new Map<string, WbMetadata>()): Map<string, WbMetadata> {
  const concepts = (json as WbMetadataResponse)?.source?.[0]?.concept ?? [];
  for (const concept of concepts) {
    if (concept.id && concept.id !== "Series") continue;
    for (const variable of concept.variable ?? []) {
      if (!variable?.id) continue;
      const out = into.get(variable.id) ?? {};
      for (const m of variable.metatype ?? []) {
        const value = cleanText(m.value);
        if (m.id && value) out[m.id] = value;
      }
      if (Object.keys(out).length) into.set(variable.id, out);
    }
  }
  return into;
}

/** Extract `{ metatypeId: value }` from a single /series/<id>/metadata response. */
export function parseWbMetadata(json: unknown): WbMetadata | null {
  const merged = mergeWbMetadataPage(json);
  return merged.values().next().value ?? null;
}

/** Below this many indicators, fetch metadata per indicator instead of in bulk. */
const BULK_THRESHOLD = 30;
const BULK_PAGE_FIELDS = 1000;

export function wdiSectors(ind: WbIndicator, meta: WbMetadata | null): string | null {
  const topics = [...new Set((ind.topics ?? []).map((t) => t.value?.trim()).filter((t): t is string => Boolean(t)))];
  if (topics.length) return topics.map((t) => t.replace(/,/g, " /")).join(", ");
  // Fall back to the broad part of the metadata topic ("Environment: Land use").
  const broad = meta?.Topic?.split(":")[0]?.trim();
  return broad ? broad.replace(/,/g, " /") : null;
}

export function wdiUrl(id: string): string {
  return `https://data.worldbank.org/indicator/${encodeURIComponent(id)}`;
}

export function buildWdiRecord(ind: WbIndicator, meta: WbMetadata | null): UnifiedIndicator {
  const definition = meta?.Longdefinition || cleanText(ind.sourceNote);
  const facts: string[] = [];
  const unit = meta?.Unitofmeasure || ind.unit?.trim();
  if (unit) facts.push(`**Unit of measure:** ${unit}`);
  if (meta?.Topic) facts.push(`**Topic:** ${meta.Topic}`);
  const timing = [meta?.Periodicity && `**Periodicity:** ${meta.Periodicity}`, meta?.Referenceperiod && `**Reference period:** ${meta.Referenceperiod}`]
    .filter(Boolean)
    .join(" · ");
  if (timing) facts.push(timing);
  const source = meta?.Source || cleanText(ind.sourceOrganization);
  if (source) facts.push(`**Source:** ${source}`);
  if (meta?.License_Type) facts.push(`**Licence:** ${meta.License_Type.replace(/^CC BY-4\.0$/, "CC BY 4.0")}`);

  const methodParts: string[] = [];
  for (const [field, heading] of METHODOLOGY_FIELDS) {
    const value = meta?.[field];
    if (value) methodParts.push(`## ${heading}\n\n${truncate(value, SECTION_MAX_CHARS, "… [truncated — see the World Bank metadata]")}`);
  }
  if (!meta) methodParts.push(`_Detailed World Bank metadata could not be retrieved. See ${wdiUrl(ind.id)}_`);

  return {
    id: `wdi:${ind.id}`,
    source: "wdi",
    title: ind.name.trim(),
    sector: wdiSectors(ind, meta),
    level: null,
    definition: tidy([definition, facts.join("\n\n")].filter(Boolean).join("\n\n")) || null,
    methodology: methodParts.length ? tidy(methodParts.join("\n\n")) : null,
    url: wdiUrl(ind.id),
  };
}

type WbPage<T> = [{ page: number | string; pages: number | string; total: number | string }, T[] | null];

export class WdiAdapter implements Adapter {
  readonly source = "wdi";
  readonly description = "World Bank — World Development Indicators (CC BY 4.0), with full series metadata";

  async *fetchAll(opts: FetchOptions): AsyncGenerator<UnifiedIndicator, AdapterStats> {
    // Bulk metadata pages take ~90 s each server-side.
    const fetcher = new PoliteFetcher(opts.delayMs, opts.log, 3, 300_000);
    const stats: AdapterStats = { ok: 0, failed: 0, total: 0 };

    opts.log("Fetching the WDI indicator list from the World Bank API ...");
    const indicators: WbIndicator[] = [];
    for (let page = 1, pages = 1; page <= pages; page++) {
      const res = await fetcher.json<WbPage<WbIndicator>>(
        `${WB_API}/source/${WDI_SOURCE_ID}/indicator?format=json&per_page=2000&page=${page}`,
      );
      if (!Array.isArray(res) || !res[1]) throw new Error("Could not fetch the WDI indicator list");
      pages = Number(res[0].pages) || 1;
      indicators.push(...res[1]);
    }

    let selected = indicators;
    if (opts.sectors?.length) {
      const wanted = opts.sectors.map((s) => s.toLowerCase());
      selected = selected.filter((i) =>
        (i.topics ?? []).some((t) => wanted.some((w) => (t.value ?? "").toLowerCase().includes(w))),
      );
    }
    if (opts.limit !== undefined) selected = selected.slice(0, opts.limit);
    stats.total = selected.length;
    const bulk = selected.length > BULK_THRESHOLD;
    opts.log(
      `Found ${indicators.length} indicators; ingesting ${selected.length} ` +
        (bulk ? "(metadata in bulk pages, ~90 s each)." : "(one metadata request each)."),
    );

    // Full metadata for everything, in ~20 bulk pages (pages count fields, not series).
    let allMeta: Map<string, WbMetadata> | null = null;
    if (bulk) {
      allMeta = new Map();
      for (let page = 1, pages = 1; page <= pages; page++) {
        const json = await fetcher.json<WbMetadataResponse>(
          `${WB_API}/sources/${WDI_SOURCE_ID}/series/all/metadata?format=json&per_page=${BULK_PAGE_FIELDS}&page=${page}`,
        );
        if (!json) {
          opts.log(`  ! metadata page ${page} failed; its indicators will use the list definition only`);
          continue;
        }
        pages = Number(json.pages) || pages;
        mergeWbMetadataPage(json, allMeta);
        opts.log(`[metadata page ${page}/${pages}] ${allMeta.size} indicators so far`);
      }
    }

    for (const [i, ind] of selected.entries()) {
      const prefix = `[${i + 1}/${selected.length}]`;
      try {
        let meta: WbMetadata | null;
        if (allMeta) {
          meta = allMeta.get(ind.id) ?? null;
        } else {
          const json = await fetcher.json(`${WB_API}/sources/${WDI_SOURCE_ID}/series/${encodeURIComponent(ind.id)}/metadata?format=json`);
          meta = json ? parseWbMetadata(json) : null;
        }
        const record = buildWdiRecord(ind, meta);
        stats.ok++;
        opts.log(`${prefix} ${ind.id} ✓${meta ? "" : " (list definition only)"}`);
        yield record;
      } catch (err) {
        stats.failed++;
        opts.log(`${prefix} ✗ ${ind.id}: ${(err as Error).message}`);
      }
    }
    return stats;
  }
}
