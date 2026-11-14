/**
 * DHS Program indicators adapter.
 *
 * Source (verified Nov 2026): The DHS Program Indicator Data API, public,
 * no key, citation required (https://api.dhsprogram.com/#/terms.cfm).
 *  - /rest/dhs/indicators lists ~4,650 entries in pages of 1,000. Only
 *    IndicatorType "I" entries are indicators; the others are denominators
 *    and sample counts (D, U), totals (T), missing/don't-know rows (S),
 *    confidence bounds and errors (C, E) and counts (N), which are skipped.
 *  - /rest/dhs/tags maps tag ids (SDGs, MICS indicators, IYCF...) to names.
 *  - /rest/dhs/info/citation gives the citation text to show with the data.
 *
 * Note: api.dhsprogram.com/robots.txt disallows /rest/dhs/ for crawlers;
 * this adapter makes ~8 API requests per run, as the documented API intends.
 */
import type { UnifiedIndicator } from "../types.ts";
import { tidy } from "./html-to-md.ts";
import { PoliteFetcher } from "./http.ts";
import type { Adapter, AdapterStats, FetchOptions } from "./types.ts";

export const DHS_API = "https://api.dhsprogram.com/rest/dhs";
export const DHS_GUIDE_URL = "https://www.dhsprogram.com/data/Guide-to-DHS-Statistics/";
export const DHS_CITATION_FALLBACK =
  "The DHS Program Indicator Data API, The Demographic and Health Surveys (DHS) Program. ICF. " +
  "Originally funded by the United States Agency for International Development (USAID). Available from api.dhsprogram.com.";

/** Tags that describe the DHS website, not the indicator. */
const IGNORED_TAGS = new Set(["DHS Mobile"]);

export interface DhsIndicator {
  IndicatorId: string;
  Label: string;
  Definition?: string | null;
  Denominator?: string | null;
  MeasurementType?: string | null;
  IndicatorType?: string | null;
  Level1?: string | null;
  Level2?: string | null;
  Level3?: string | null;
  TagIds?: string | null;
}

interface DhsPage<T> {
  TotalPages?: number | string;
  Data?: T[];
}

export function parseTagIds(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function dhsUrl(id: string): string {
  return `${DHS_API}/indicators?indicatorIds=${encodeURIComponent(id)}&f=json`;
}

/** Labels shared by several indicators get their topic appended, so titles stay distinct. */
export function distinctTitles(indicators: DhsIndicator[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const i of indicators) counts.set(i.Label.trim(), (counts.get(i.Label.trim()) ?? 0) + 1);
  return new Map(
    indicators.map((i) => {
      const label = i.Label.trim();
      if ((counts.get(label) ?? 0) < 2) return [i.IndicatorId, label];
      const context = [i.Level2, i.Level3].map((l) => l?.trim()).filter(Boolean).join(", ");
      return [i.IndicatorId, context ? `${label} (${context})` : label];
    }),
  );
}

export function buildDhsRecord(
  ind: DhsIndicator,
  title: string,
  tagNames: Map<string, string>,
  citation: string,
): UnifiedIndicator {
  const facts: string[] = [];
  if (ind.Denominator?.trim()) facts.push(`**Denominator:** ${ind.Denominator.trim()}`);
  if (ind.MeasurementType?.trim()) facts.push(`**Measurement:** ${ind.MeasurementType.trim()}`);
  const path = [ind.Level1, ind.Level2, ind.Level3].map((l) => l?.trim()).filter(Boolean);
  if (path.length) facts.push(`**Topic:** ${path.join(" › ")}`);
  const tags = parseTagIds(ind.TagIds)
    .map((id) => tagNames.get(id)?.trim())
    .filter((t): t is string => Boolean(t) && !IGNORED_TAGS.has(t!));
  if (tags.length) facts.push(`**Tags:** ${[...new Set(tags)].join(", ")}`);
  facts.push(`**DHS indicator id:** \`${ind.IndicatorId}\``);

  const methodology = [
    "Calculated from Demographic and Health Surveys (DHS) household and individual questionnaires. " +
      `Survey questions, calculation steps and tabulation notes are documented in the [Guide to DHS Statistics](${DHS_GUIDE_URL}).`,
    "Country, survey and year values for this indicator are available from the DHS Program Indicator Data API " +
      "(and STATcompiler), using the indicator id above.",
    `_Citation: ${citation}_`,
  ].join("\n\n");

  return {
    id: `dhs:${ind.IndicatorId}`,
    source: "dhs",
    title,
    sector: ind.Level1?.trim().replace(/,/g, " /") || null,
    level: null,
    definition: tidy([ind.Definition?.trim() ?? "", facts.join("\n\n")].filter(Boolean).join("\n\n")),
    methodology,
    url: dhsUrl(ind.IndicatorId),
  };
}

export class DhsAdapter implements Adapter {
  readonly source = "dhs";
  readonly description = "DHS Program — Demographic and Health Surveys indicator definitions (ICF; citation required)";

  async *fetchAll(opts: FetchOptions): AsyncGenerator<UnifiedIndicator, AdapterStats> {
    const fetcher = new PoliteFetcher(opts.delayMs, opts.log);
    const stats: AdapterStats = { ok: 0, failed: 0, total: 0 };

    opts.log("Fetching DHS indicators, tags and citation from the DHS Program API ...");
    const all: DhsIndicator[] = [];
    for (let page = 1, pages = 1; page <= pages; page++) {
      const res = await fetcher.json<DhsPage<DhsIndicator>>(`${DHS_API}/indicators?f=json&perpage=1000&page=${page}`);
      if (!res?.Data) throw new Error(`Could not fetch DHS indicators page ${page}`);
      pages = Number(res.TotalPages) || 1;
      all.push(...res.Data);
    }
    const tags = await fetcher.json<DhsPage<{ TagID: number | string; TagName: string }>>(`${DHS_API}/tags?f=json`);
    const tagNames = new Map((tags?.Data ?? []).map((t) => [String(t.TagID), t.TagName]));
    const info = await fetcher.json<DhsPage<{ InfoType: string; Value: string }>>(`${DHS_API}/info/citation?f=json`);
    const citation = info?.Data?.[0]?.Value?.trim() || DHS_CITATION_FALLBACK;

    // The API lists a few ids twice with slightly different labels: keep the first.
    const seen = new Set<string>();
    const indicators = all.filter((i) => {
      if (i.IndicatorType !== "I" || !i.IndicatorId || !i.Label?.trim() || seen.has(i.IndicatorId)) return false;
      seen.add(i.IndicatorId);
      return true;
    });
    const duplicates = all.filter((i) => i.IndicatorType === "I").length - indicators.length;
    if (duplicates > 0) opts.log(`Skipped ${duplicates} repeated indicator ids (kept the first label of each).`);
    let selected = indicators;
    if (opts.sectors?.length) {
      const wanted = opts.sectors.map((s) => s.toLowerCase());
      selected = selected.filter((i) => wanted.some((w) => (i.Level1 ?? "").toLowerCase().includes(w)));
    }
    if (opts.limit !== undefined) selected = selected.slice(0, opts.limit);
    stats.total = selected.length;
    opts.log(`Found ${all.length} entries, ${indicators.length} of them indicators; ingesting ${selected.length}.`);

    const titles = distinctTitles(indicators);
    for (const ind of selected) {
      try {
        yield buildDhsRecord(ind, titles.get(ind.IndicatorId) ?? ind.Label.trim(), tagNames, citation);
        stats.ok++;
      } catch (err) {
        stats.failed++;
        opts.log(`  ✗ ${ind.IndicatorId}: ${(err as Error).message}`);
      }
    }
    opts.log(`Built ${stats.ok} DHS records.`);
    return stats;
  }
}
