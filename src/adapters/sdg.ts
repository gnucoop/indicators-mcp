/**
 * UN SDG global indicator framework adapter.
 *
 * Sources (verified Nov 2026):
 *  - UN Stats SDG API v5 (no key): Goal/List, Target/List and Indicator/List
 *    give goals, targets, the 251 indicators, their tier and current data series.
 *  - SDG metadata repository: one page per goal lists each indicator's
 *    metadata documents (.docx/.pdf; some indicators have several, e.g.
 *    Metadata-01-01-01a/b). The .docx files follow the harmonized metadata
 *    template, whose section headings end in a stable code such as
 *    "2.a. Definition and concepts (STAT_CONC_DEF)".
 */
import * as cheerio from "cheerio";
import type { UnifiedIndicator } from "../types.ts";
import { blocksToMarkdown, readDocxBlocks, type DocxBlock } from "./docx.ts";
import { tidy } from "./html-to-md.ts";
import { PoliteFetcher } from "./http.ts";
import type { Adapter, AdapterStats, FetchOptions } from "./types.ts";

export const SDG_API = "https://unstats.un.org/sdgs/UNSDGAPIV5/v1/sdg";
export const SDG_METADATA = "https://unstats.un.org/sdgs/metadata";

/** Short goal names, without commas (sector values are comma-separated lists). */
export const GOAL_NAMES: Record<string, string> = {
  "1": "No Poverty",
  "2": "Zero Hunger",
  "3": "Good Health and Well-being",
  "4": "Quality Education",
  "5": "Gender Equality",
  "6": "Clean Water and Sanitation",
  "7": "Affordable and Clean Energy",
  "8": "Decent Work and Economic Growth",
  "9": "Industry / Innovation / Infrastructure",
  "10": "Reduced Inequalities",
  "11": "Sustainable Cities and Communities",
  "12": "Responsible Consumption and Production",
  "13": "Climate Action",
  "14": "Life Below Water",
  "15": "Life on Land",
  "16": "Peace / Justice / Strong Institutions",
  "17": "Partnerships for the Goals",
};

export function goalSector(code: string): string {
  return `SDG ${code} ${GOAL_NAMES[code] ?? ""}`.trim();
}

const TIERS: Record<string, string> = {
  "1": "Tier I — established methodology; data regularly produced by at least 50% of countries",
  "2": "Tier II — established methodology; data not regularly produced by countries",
  "3": "Tier III — no established methodology or standards yet",
};

/** Sections of the harmonized template that go into `definition`. */
const DEFINITION_SECTIONS = ["STAT_CONC_DEF", "UNIT_MEASURE"];
/** Sections that go into `methodology`, in this order. */
const METHODOLOGY_SECTIONS = [
  "RATIONALE",
  "DATA_COMP",
  "REC_USE_LIM",
  "SOURCE_TYPE",
  "COLL_METHOD",
  "COVERAGE",
  "IMPUTATION",
  "DOC_METHOD",
  "COMPARABILITY",
  "OTHER_DOC",
];
const SECTION_MAX_CHARS = 6_000;
const DOC_MAX_CHARS = 36_000;

interface ApiGoal {
  code: string;
  title: string;
}
interface ApiTarget {
  goal: string;
  code: string;
  title: string;
}
interface ApiIndicator {
  goal: string;
  target: string;
  code: string;
  description: string;
  tier: string | null;
  series?: { code: string; description: string }[] | null;
}

export interface MetadataLinks {
  docx: string[];
  pdf: string[];
}

/** Map indicator code → metadata document URLs from a goal's metadata page. */
export function parseMetadataPage(html: string, baseUrl = SDG_METADATA): Map<string, MetadataLinks> {
  const $ = cheerio.load(html);
  const out = new Map<string, MetadataLinks>();
  $("strong").each((_, s) => {
    const m = $(s)
      .text()
      .trim()
      .match(/^Indicator\s+([0-9]+\.[0-9a-z]+\.[0-9]+)\s*:/i);
    if (!m) return;
    const li = $(s).closest("li");
    const links: MetadataLinks = { docx: [], pdf: [] };
    li.find("a[href]").each((_, a) => {
      const href = $(a).attr("href")!;
      const abs = new URL(href, baseUrl).toString();
      if (/\.docx$/i.test(href) && !links.docx.includes(abs)) links.docx.push(abs);
      else if (/\.pdf$/i.test(href) && !links.pdf.includes(abs)) links.pdf.push(abs);
    });
    out.set(m[1]!.toLowerCase(), links);
  });
  return out;
}

export interface MetadataSection {
  number: string;
  title: string;
  code: string;
  markdown: string;
}

const HEADING_RE = /^(\d+(?:\.[a-z])?)\.?\s+(.+?)\s*\(([A-Z][A-Z0-9_]{2,})\)\s*$/;

/** Split harmonized-template blocks into sections keyed by their code. */
export function splitSections(blocks: DocxBlock[]): Map<string, MetadataSection> {
  const sections = new Map<string, MetadataSection>();
  let current: { meta: Omit<MetadataSection, "markdown">; blocks: DocxBlock[] } | null = null;
  const close = () => {
    if (!current) return;
    const markdown = tidy(blocksToMarkdown(current.blocks));
    if (!sections.has(current.meta.code)) sections.set(current.meta.code, { ...current.meta, markdown });
  };
  for (const b of blocks) {
    const m = b.kind === "paragraph" ? b.text.replace(/\s+/g, " ").match(HEADING_RE) : null;
    if (m) {
      close();
      current = { meta: { number: m[1]!, title: m[2]!.trim(), code: m[3]! }, blocks: [] };
    } else if (current) {
      current.blocks.push(b);
    }
  }
  close();
  return sections;
}

export function truncate(text: string, max: number, note = "… [truncated — see the full metadata document]"): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const para = cut.lastIndexOf("\n\n");
  return `${(para > max * 0.6 ? cut.slice(0, para) : cut).trimEnd()}\n\n${note}`;
}

export interface ParsedMetadata {
  sections: Map<string, MetadataSection>;
  /** Whole document as Markdown when it doesn't follow the harmonized template. */
  fallback: string | null;
}

export function parseMetadataDocx(bytes: Uint8Array): ParsedMetadata {
  const blocks = readDocxBlocks(bytes);
  const sections = splitSections(blocks);
  const useful = [...DEFINITION_SECTIONS, ...METHODOLOGY_SECTIONS].some((c) => sections.get(c)?.markdown);
  return { sections, fallback: useful ? null : truncate(tidy(blocksToMarkdown(blocks)), DOC_MAX_CHARS) };
}

function section(meta: ParsedMetadata, code: string, level: string): string | null {
  const s = meta.sections.get(code);
  if (!s?.markdown) return null;
  return `${level} ${s.title}\n\n${truncate(s.markdown, SECTION_MAX_CHARS)}`;
}

function oneLine(meta: ParsedMetadata, code: string): string | null {
  const s = meta.sections.get(code)?.markdown;
  return s ? s.replace(/^- /gm, "").split(/\n+/).filter(Boolean).join("; ") : null;
}

/** Build the canonical record from API data plus zero or more parsed metadata documents. */
export function buildSdgRecord(
  ind: ApiIndicator,
  goal: ApiGoal | undefined,
  target: ApiTarget | undefined,
  docs: { url: string; meta: ParsedMetadata }[],
  url: string,
): UnifiedIndicator {
  const multi = docs.length > 1;
  const label = (i: number) => `Metadata part ${String.fromCharCode(65 + i)}`;

  const header: string[] = [ind.description.trim()];
  if (goal) header.push(`**Goal ${goal.code}:** ${goal.title}`);
  if (target) header.push(`**Target ${target.code}:** ${target.title}`);
  if (ind.tier && TIERS[ind.tier]) header.push(`**Tier:** ${TIERS[ind.tier]}`);
  const custodians = [...new Set(docs.map((d) => oneLine(d.meta, "SDG_CUSTODIAN_AGENCIES")).filter(Boolean))];
  if (custodians.length) header.push(`**Custodian agencies:** ${custodians.join("; ")}`);
  const series = (ind.series ?? []).filter((s, i, a) => a.findIndex((x) => x.code === s.code) === i);
  if (series.length) {
    const shown = series.slice(0, 12).map((s) => `- \`${s.code}\` ${s.description}`);
    if (series.length > 12) shown.push(`- … and ${series.length - 12} more series`);
    header.push(`**Data series:**\n\n${shown.join("\n")}`);
  }

  const definitionParts = [header.join("\n\n")];
  const methodParts: string[] = [];
  docs.forEach((d, i) => {
    const h2 = multi ? "###" : "##";
    if (multi) {
      const seriesNote = oneLine(d.meta, "SDG_SERIES_DESCR");
      const title = `## ${label(i)}${seriesNote ? ` — ${truncate(seriesNote, 300, "…")}` : ""}`;
      definitionParts.push(title);
      methodParts.push(title);
    }
    for (const code of DEFINITION_SECTIONS) {
      const s = section(d.meta, code, h2);
      if (s) definitionParts.push(s);
    }
    const docMethod: string[] = [];
    for (const code of METHODOLOGY_SECTIONS) {
      const s = section(d.meta, code, h2);
      if (s) docMethod.push(s);
    }
    if (!docMethod.length && d.meta.fallback) docMethod.push(`${h2} Metadata\n\n${d.meta.fallback}`);
    methodParts.push(truncate(docMethod.join("\n\n"), Math.floor(DOC_MAX_CHARS / docs.length)));
    const updated = oneLine(d.meta, "META_LAST_UPDATE");
    methodParts.push(`_Metadata document: [${d.url.split("/").pop()}](${d.url})${updated ? `, last updated ${updated}` : ""}_`);
  });
  if (!docs.length) methodParts.push(`_No metadata document could be retrieved. See ${url}_`);

  return {
    id: `sdg:${ind.code}`,
    source: "sdg",
    title: ind.description.trim(),
    sector: goalSector(ind.goal),
    level: null,
    definition: tidy(definitionParts.join("\n\n")),
    methodology: tidy(methodParts.join("\n\n")),
    url,
  };
}

export class SdgAdapter implements Adapter {
  readonly source = "sdg";
  readonly description = "UN SDG global indicator framework (UN Statistics Division), with harmonized metadata";

  async *fetchAll(opts: FetchOptions): AsyncGenerator<UnifiedIndicator, AdapterStats> {
    const fetcher = new PoliteFetcher(opts.delayMs, opts.log);
    const stats: AdapterStats = { ok: 0, failed: 0, total: 0 };

    opts.log("Fetching goals, targets and indicators from the UN SDG API ...");
    const goals = await fetcher.json<ApiGoal[]>(`${SDG_API}/Goal/List?includechildren=false`);
    const targets = await fetcher.json<ApiTarget[]>(`${SDG_API}/Target/List`);
    const indicators = await fetcher.json<ApiIndicator[]>(`${SDG_API}/Indicator/List`);
    if (!goals || !targets || !indicators) throw new Error("Could not fetch the SDG indicator lists");
    const goalByCode = new Map(goals.map((g) => [g.code, g]));
    const targetByCode = new Map(targets.map((t) => [t.code.toLowerCase(), t]));

    let selected = indicators;
    if (opts.sectors?.length) {
      const wanted = opts.sectors.map((s) => s.toLowerCase().replace(/^sdg\s*/, "").trim());
      selected = selected.filter((i) => {
        const name = goalSector(i.goal).toLowerCase();
        return wanted.some((w) => w === i.goal || (w.length > 2 && name.includes(w)));
      });
    }
    if (opts.limit !== undefined) selected = selected.slice(0, opts.limit);
    stats.total = selected.length;
    opts.log(`Found ${indicators.length} indicators; ingesting ${selected.length}.`);
    if (!selected.length) return stats;

    // Metadata document links, one page per goal that is needed.
    const links = new Map<string, MetadataLinks>();
    const goalsNeeded = [...new Set(selected.map((i) => i.goal))];
    for (const [i, g] of goalsNeeded.entries()) {
      const pageUrl = `${SDG_METADATA}/?Text=&Goal=${encodeURIComponent(g)}&Target=`;
      const html = await fetcher.text(pageUrl);
      const found = html ? parseMetadataPage(html) : new Map<string, MetadataLinks>();
      for (const [code, l] of found) links.set(code, l);
      opts.log(`[goal ${i + 1}/${goalsNeeded.length}] SDG ${g}: ${found.size} indicators with metadata links`);
    }

    for (const [i, ind] of selected.entries()) {
      const prefix = `[${i + 1}/${selected.length}]`;
      try {
        const l = links.get(ind.code.toLowerCase()) ?? { docx: [], pdf: [] };
        const docs: { url: string; meta: ParsedMetadata }[] = [];
        for (const docUrl of l.docx) {
          const bytes = await fetcher.bytes(docUrl);
          if (!bytes) continue;
          try {
            docs.push({ url: docUrl.replace(/\.docx$/i, ".pdf"), meta: parseMetadataDocx(bytes) });
          } catch (err) {
            opts.log(`  ! could not parse ${docUrl}: ${(err as Error).message}`);
          }
        }
        const target = targetByCode.get(ind.target.toLowerCase());
        const url =
          l.pdf[0] ??
          `${SDG_METADATA}/?Text=&Goal=${encodeURIComponent(ind.goal)}&Target=${encodeURIComponent(ind.target)}`;
        const record = buildSdgRecord(ind, goalByCode.get(ind.goal), target, docs, url);
        stats.ok++;
        const note = l.docx.length === 0 ? " (no metadata document)" : docs.length < l.docx.length ? " (some metadata missing)" : "";
        opts.log(`${prefix} SDG ${ind.code} ✓${note}`);
        yield record;
      } catch (err) {
        stats.failed++;
        opts.log(`${prefix} ✗ SDG ${ind.code}: ${(err as Error).message}`);
      }
    }
    return stats;
  }
}
