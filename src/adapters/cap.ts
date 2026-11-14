/**
 * EU Common Agricultural Policy — Performance Monitoring and Evaluation
 * Framework (PMEF 2023–2027) adapter.
 *
 * Sources (verified Nov 2026):
 *  - Names, descriptions, objectives: Regulation (EU) 2021/2115, Annex I,
 *    consolidated text, fetched from the EU Publications Office's Cellar
 *    service (EUR-Lex itself sits behind a bot check). 161 indicators:
 *    impact I.*, result R.* ("PR" = used for performance review), output O.*
 *    (incl. O.9a, O.27a) and context C.*.
 *  - Methodology: the Commission's indicator fiches (PDF), which the site
 *    does not serve to scripts. Download them by hand into sources/cap/:
 *      pmef-result-indicators_en.pdf          (result fiches)
 *      pmef-context-impact-indicators_en.pdf  (context + impact fiches)
 *    and keep `pdftotext` (poppler) installed. Without them the adapter still
 *    ingests every indicator from Annex I, without methodology.
 *
 * Licence: Commission content is CC BY 4.0 (Decision 2011/833/EU); EU legal
 * acts are freely reusable. Records note that the fiche text is reformatted.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { UnifiedIndicator } from "../types.ts";
import { tidy } from "./html-to-md.ts";
import { PoliteFetcher } from "./http.ts";
import { truncate } from "./sdg.ts";
import type { Adapter, AdapterStats, FetchOptions } from "./types.ts";

/** Consolidated version of Regulation 2021/2115 to use (override with CAP_CELEX). */
export const CAP_CELEX = process.env.CAP_CELEX ?? "02021R2115-20260101";
export const CAP_LEGAL_URL = "https://eur-lex.europa.eu/eli/reg/2021/2115/oj/eng";
export const CAP_FICHES_URL =
  "https://agriculture.ec.europa.eu/cap-my-country/performance-agricultural-policy/cap-indicators_en";
export const CAP_FICHES_DIR = process.env.CAP_FICHES_DIR ?? resolve(import.meta.dir, "..", "..", "sources", "cap");

export type CapType = "impact" | "result" | "output" | "context";

export interface AnnexIndicator {
  code: string; // "R.14", "O.9a", "C.01"
  type: CapType;
  pr: boolean; // result indicator used for performance review
  name: string | null; // short name (impact/result/context)
  description: string; // official wording
  group: string; // objective (I/R), type of intervention (O), topic (C)
}

const TYPE_BY_PREFIX: Record<string, CapType> = { I: "impact", R: "result", O: "output", C: "context" };
const CODE_RE = /^(I|R|O|C)\.(\d+[a-z]?)(PR)?\b\s*(.*)$/;

/** Short sector names for the ten CAP objectives (no commas: sectors are comma-joined lists). */
const OBJECTIVES: [RegExp, string][] = [
  [/^Modernising agriculture/i, "Knowledge and innovation"],
  [/viable farm income/i, "Farm income and resilience"],
  [/market orientation/i, "Competitiveness"],
  [/position in the (food|value) chain/i, "Value chain"],
  [/climate change mitigation/i, "Climate change"],
  [/natural resources/i, "Natural resources"],
  [/biodiversity/i, "Biodiversity and landscapes"],
  [/young farmers/i, "Generational renewal"],
  [/employment, growth/i, "Rural areas"],
  [/food and health/i, "Food / health / animal welfare"],
];

export function objectiveName(text: string): string {
  return OBJECTIVES.find(([re]) => re.test(text))?.[1] ?? text.slice(0, 60);
}

export function capSector(ind: Pick<AnnexIndicator, "type" | "group">): string {
  switch (ind.type) {
    case "impact":
    case "result":
      return `CAP – ${objectiveName(ind.group)}`;
    case "output":
      return "CAP – Outputs";
    case "context":
      return `CAP – Context – ${ind.group.replace(/,/g, " /")}`;
  }
}

/** Annex I of the consolidated regulation (XHTML) → plain text lines. */
export function annexLines(xhtml: string): string[] {
  const start = xhtml.search(/>\s*ANNEX I\s*</);
  if (start < 0) throw new Error("Annex I not found in the regulation text");
  let seg = xhtml.slice(start + 1);
  const end = seg.search(/>\s*ANNEX II\s*</);
  if (end > 0) seg = seg.slice(0, end);
  const text = seg
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&rsquo;/g, "’");
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !/^▼/.test(l));
}

/** Parse the indicators of Annex I. */
export function parseAnnexI(lines: string[]): AnnexIndicator[] {
  const out: AnnexIndicator[] = [];
  let section: "ir" | "output" | "context" = "ir";
  let objective = "";
  let intervention = "";
  let topic = "";
  let pendingLines: string[] = []; // non-code lines since the last indicator (context headings)

  const push = (code: string, prefix: string, pr: boolean, rest: string, follow: string[]) => {
    const type = TYPE_BY_PREFIX[prefix]!;
    let name: string | null = null;
    let description = rest;
    if (type === "context") {
      name = (rest || follow[0] || "").trim();
      description = name;
    } else if (type === "impact" || type === "result") {
      const full = (rest.endsWith(":") || !rest ? [rest, ...follow.slice(0, 1)] : [rest]).join(" ").trim();
      const i = full.indexOf(":");
      name = i > 0 ? full.slice(0, i).trim() : null;
      description = i > 0 ? full.slice(i + 1).trim() : full;
    }
    const group = type === "output" ? intervention : type === "context" ? topic : objective;
    out.push({ code, type, pr, name, description, group });
  };

  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    if (/^Monitoring\s*[–-]\s*OUTPUT/i.test(line) || /^Output indicators$/i.test(line)) section = "output";
    if (/^CONTEXT INDICATORS$/.test(line)) section = "context";

    const m = line.match(CODE_RE);
    if (!m) {
      pendingLines.push(line);
      if (section === "ir" && /^(To |Modernising )/.test(line) && line.length > 20) objective = line;
      if (section === "output" && /\((Articles? [^)]*)\)$|^Horizontal indicator$/.test(line)) intervention = line;
      continue;
    }
    const [, prefix, num, pr, rest] = m;
    const code = `${prefix}.${num}`;
    if (prefix === "C") {
      // The heading for this context indicator is the last short, non-item line before it.
      const candidates = pendingLines.filter((l) => l.length < 40 && !l.includes("–") && !/^(Indicator number|Context indicator)$/.test(l));
      if (candidates.length) topic = candidates[candidates.length - 1]!;
    }
    // Continuation lines (until the next code) for split entries.
    const follow: string[] = [];
    for (let j = k + 1; j < lines.length && !CODE_RE.test(lines[j]!) && follow.length < 1; j++) follow.push(lines[j]!);
    push(code, prefix!, Boolean(pr), rest!.trim(), follow);
    pendingLines = [];
    if (prefix === "C" && !rest!.trim()) k++; // the name line was consumed
    if ((prefix === "I" || prefix === "R") && (rest!.trim().endsWith(":") || !rest!.trim())) k++;
  }
  return out;
}

// ---------------------------------------------------------------- fiches

export interface Fiche {
  code: string;
  title?: string;
  /** Impact indicators this (context) fiche also documents, from its header. */
  impacts?: string[];
  fields: Record<string, string>; // canonical field key → Markdown
}

/** Join wrapped PDF lines into paragraphs and bullet lists. */
export function reflow(lines: string[]): string {
  const paras: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) paras.push(cur.trim());
    cur = "";
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) {
      flush();
      continue;
    }
    const bullet = line.match(/^(?:[•▪◦·]|-|–|o)\s+(.*)$/);
    const numbered = line.match(/^(\d{1,2}[.)]|\(?[a-z]\)|\d{1,2}(?:\s*(?:,|and|-|–)\s*\d{1,2})*\s*:)\s*(.*)$/);
    if (bullet) {
      flush();
      cur = `- ${bullet[1]}`;
    } else if (numbered) {
      flush();
      cur = `${numbered[1]} ${numbered[2]}`;
    } else {
      cur = cur ? `${cur.replace(/-$/, "-")} ${line}` : line;
    }
  }
  flush();
  return paras
    .map((p, i) => (i > 0 && (p.startsWith("- ") || /^\d|^\(?[a-z]\)/.test(p)) && (paras[i - 1]!.startsWith("- ") || /^\d|^\(?[a-z]\)/.test(paras[i - 1]!)) ? `\n${p}` : `\n\n${p}`))
    .join("")
    .trim();
}

const RESULT_LABELS: [RegExp, string][] = [
  [/^Indicator name\b/i, "name"],
  [/^Definition and aim\b/i, "definition"],
  [/^Types of interventions?\b/i, "interventions"],
  [/^Unit of measurement\b/i, "unit"],
  [/^Moment of data\b/i, "moment"],
  [/^Methodology\b/i, "methodology"],
  [/^Comments\s*\/\s*caveats\b/i, "comments"],
  [/^Geographical level\b/i, "geo"],
];
const RESULT_CONTINUATIONS = /^(concerned|collection)\b/i;
const RESULT_NOISE = [
  /^\s*DISCLAIMER\s*$/,
  /The document has no legal binding value/,
  /approval of the CAP strategic plans and their amendments/,
  /^\s*Result indicators\s*$/,
  /\d{2}\/\d{2}\/\d{4}\s*[–-]\s*Version/,
  /^\s*\d{1,3}\s*$/,
];

/** Result fiches, from `pdftotext -layout` output (labels in a left column). */
export function parseResultFiches(layoutText: string): Map<string, Fiche> {
  const fiches = new Map<string, Fiche>();
  let current: { code: string; fields: Record<string, string[]> } | null = null;
  let field = "";
  const close = () => {
    if (!current) return;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(current.fields)) {
      const md = reflow(v).replace(/\s*\[back to overview\]/gi, "").trim();
      if (md) fields[k] = md;
    }
    fiches.set(current.code, { code: current.code, fields });
  };
  for (const raw of layoutText.split("\n")) {
    if (RESULT_NOISE.some((re) => re.test(raw))) continue;
    const trimmed = raw.trimStart();
    const label = RESULT_LABELS.find(([re]) => re.test(trimmed));
    let content = raw;
    if (label) {
      const m = trimmed.match(label[0])!;
      content = trimmed.slice(m.index! + m[0].length);
      field = label[1];
      if (field === "name") {
        close();
        const code = content.trim().match(/^R\.(\d+)/);
        current = code ? { code: `R.${code[1]}`, fields: {} } : null;
      }
    } else if (RESULT_CONTINUATIONS.test(trimmed)) {
      content = trimmed.replace(RESULT_CONTINUATIONS, "");
    }
    if (!current || !field) continue;
    (current.fields[field] ??= []).push(content);
  }
  close();
  return fiches;
}

const CONTEXT_LABELS: [RegExp, string][] = [
  [/^Indicator Name\b/i, "name"],
  [/^Definition\b/, "definition"],
  [/^Unit of measurement\b/i, "unit"],
  [/^Data source\b/i, "source"],
  [/^References\s*\/\s*location\b/i, "references"],
  [/^Data collection\s*\//i, "level"],
  [/^Frequency\b/, "frequency"],
  [/^Timeliness\b/, "timeliness"],
  [/^Comments\s*\/\s*caveats\b/i, "comments"],
];
const CONTEXT_CONTINUATIONS = /^(of the data|of|the data|dissemination level)\b\s*-?\s*/i;
const CONTEXT_NOISE = [
  /^\s*DISCLAIMER\s*$/,
  /This document has been prepared by the Commission services/,
  /^parties \(e\.g\. for the purpose of drafting/,
  /The document does not bind the European Commission/,
  /Strategic Plans of Member States\. It was prepared by Commission services/,
  /^\s*Commission\.\s*$/,
  /Context and Impact indicators \d{2}\/\d{2}\/\d{4}/,
  /^\s*\d{1,3}\s*$/,
];

/** Context (and the few impact) fiches, from `pdftotext -raw` output (labels on their own lines). */
export function parseContextFiches(rawText: string): Map<string, Fiche> {
  const fiches = new Map<string, Fiche>();
  type Part = { title: string; fields: Record<string, string[]>; impact?: string };
  let code = "";
  let part: Part | null = null;
  let field = "";
  const parts = new Map<string, Part[]>();
  for (const raw of rawText.split("\n")) {
    if (CONTEXT_NOISE.some((re) => re.test(raw))) continue;
    const header = raw.match(/^\s*INDICATOR ([CI])\.(\d+)\b(.*)$/);
    if (header) {
      code = `${header[1]}.${header[1] === "C" ? header[2]!.padStart(2, "0") : header[2]}`;
      const alsoImpact = header[3]!.match(/\bIndicator I\.(\d+)\b/);
      part = { title: "", fields: {}, impact: alsoImpact ? `I.${alsoImpact[1]}` : undefined };
      parts.set(code, [...(parts.get(code) ?? []), part]);
      field = "";
      continue;
    }
    if (!part) continue;
    const line = raw.trim();
    const label = CONTEXT_LABELS.find(([re]) => re.test(line));
    let content = line;
    if (label) {
      field = label[1];
      content = line.replace(label[0], "").replace(CONTEXT_CONTINUATIONS, "").replace(/^\s*-\s*$/, "").trim();
    } else if (field && CONTEXT_CONTINUATIONS.test(line) && !(part.fields[field] ?? []).some((l) => l.trim())) {
      content = line.replace(CONTEXT_CONTINUATIONS, "");
    }
    if (!field) continue;
    (part.fields[field] ??= []).push(content);
  }
  for (const [c, ps] of parts) {
    const merged: Record<string, string> = {};
    const multi = ps.length > 1;
    for (const p of ps) {
      const title = reflow(p.fields.name ?? []).replace(/\n+/g, " ").trim();
      for (const [k, v] of Object.entries(p.fields)) {
        if (k === "name") continue;
        const md = reflow(v);
        if (!md) continue;
        merged[k] = merged[k] ? `${merged[k]}\n\n${multi && title ? `**${title}:** ` : ""}${md}` : `${multi && title ? `**${title}:** ` : ""}${md}`;
      }
    }
    const title = reflow(ps[0]!.fields.name ?? []).replace(/\n+/g, " ").trim();
    const impacts = [...new Set(ps.map((p) => p.impact).filter((i): i is string => Boolean(i) && i !== c))];
    fiches.set(c, { code: c, title, fields: merged, ...(impacts.length && { impacts }) });
  }
  return fiches;
}

/** Impact → context indicator(s) that measure it, from the overview tables of the context/impact fiches. */
export function parseImpactContextMap(layoutText: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of layoutText.split("\n")) {
    for (const m of line.matchAll(/\bI\.(\d+)\s+C\.(\d+)\b/g)) {
      const i = `I.${m[1]}`;
      const c = `C.${m[2]!.padStart(2, "0")}`;
      const list = map.get(i) ?? [];
      if (!list.includes(c)) list.push(c);
      map.set(i, list);
    }
  }
  return map;
}

export function ficheVersion(text: string, label: string): string | null {
  const m = text.match(/(\d{2}\/\d{2}\/\d{4})\s*[–-]\s*Version\s*([\d.]+)/);
  return m ? `${label} v${m[2]} (${m[1]})` : null;
}

// ---------------------------------------------------------------- records

const TYPE_LABEL: Record<CapType, string> = {
  impact: "Impact indicator",
  result: "Result indicator",
  output: "Output indicator",
  context: "Context indicator",
};
const LEVEL: Record<CapType, string | null> = { impact: "Impact", result: "Outcome", output: "Output", context: null };
const SECTION_MAX = 6_000;

const RESULT_SECTIONS: [string, string][] = [
  ["interventions", "Types of intervention concerned"],
  ["moment", "Moment of data collection"],
  ["methodology", "Methodology"],
  ["comments", "Comments and caveats"],
];
const CONTEXT_SECTIONS: [string, string][] = [
  ["source", "Data source"],
  ["references", "References / location of the data"],
  ["level", "Data collection / dissemination level"],
  ["frequency", "Frequency"],
  ["timeliness", "Timeliness"],
  ["comments", "Comments and caveats"],
];

export interface CapContext {
  resultFiches: Map<string, Fiche>;
  contextFiches: Map<string, Fiche>;
  impactMap: Map<string, string[]>;
  annex: Map<string, AnnexIndicator>;
  versions: { result?: string; context?: string }; // e.g. "Commission result indicator fiches v21.0 (27/12/2024)"
}

function sections(fiche: Fiche | undefined, spec: [string, string][], level = "##"): string[] {
  if (!fiche) return [];
  return spec
    .filter(([k]) => fiche.fields[k])
    .map(([k, h]) => `${level} ${h}\n\n${truncate(fiche.fields[k]!, SECTION_MAX, "… [truncated — see the Commission fiche]")}`);
}

export function buildCapRecord(ind: AnnexIndicator, ctx: CapContext): UnifiedIndicator {
  const title = ind.name ?? (ind.description.length > 140 ? `${ind.description.slice(0, 137)}…` : ind.description);
  const facts: string[] = [`**Type:** ${TYPE_LABEL[ind.type]} (CAP PMEF 2023–2027)${ind.pr ? " · used for the performance review" : ""}`];
  if (ind.type === "impact" || ind.type === "result") facts.push(`**CAP objective:** ${ind.group}`);
  if (ind.type === "output") facts.push(`**Type of intervention:** ${ind.group}`);
  if (ind.type === "context") facts.push(`**Context topic:** ${ind.group}`);
  facts.push(`**Code:** \`${ind.code}${ind.pr ? "PR" : ""}\``);

  const def: string[] = [ind.name && ind.description !== ind.name ? ind.description : ind.description];
  const meth: string[] = [];
  let usedFiche: "result" | "context" | null = null;

  if (ind.type === "result") {
    const f = ctx.resultFiches.get(ind.code);
    if (f) {
      usedFiche = "result";
      if (f.fields.unit) facts.push(`**Unit:** ${f.fields.unit.replace(/\n+/g, " ")}`);
      if (f.fields.definition) def.push(`## Definition and aim\n\n${f.fields.definition}`);
      meth.push(...sections(f, RESULT_SECTIONS));
    }
  } else if (ind.type === "context") {
    const f = ctx.contextFiches.get(ind.code);
    if (f) {
      usedFiche = "context";
      if (f.fields.unit) facts.push(`**Unit:** ${f.fields.unit.replace(/\n+/g, " ")}`);
      if (f.fields.definition) def.push(`## Definition\n\n${f.fields.definition}`);
      meth.push(...sections(f, CONTEXT_SECTIONS));
    }
    const measures = [...ctx.impactMap.entries()].filter(([, cs]) => cs.includes(ind.code)).map(([i]) => i);
    if (measures.length) facts.push(`**Measures impact indicator(s):** ${measures.join(", ")}`);
  } else if (ind.type === "impact") {
    const own = ctx.contextFiches.get(ind.code);
    const contexts = ctx.impactMap.get(ind.code) ?? [];
    if (contexts.length) {
      const names = contexts.map((c) => `${c}${ctx.annex.get(c)?.name ? ` (${ctx.annex.get(c)!.name})` : ""}`);
      facts.push(`**Measured with context indicator(s):** ${names.join("; ")}`);
    }
    if (own) {
      usedFiche = "context";
      if (own.fields.unit) facts.push(`**Unit:** ${own.fields.unit.replace(/\n+/g, " ")}`);
      if (own.fields.definition) def.push(`## Definition\n\n${own.fields.definition}`);
      meth.push(...sections(own, CONTEXT_SECTIONS));
    } else {
      for (const c of contexts) {
        const f = ctx.contextFiches.get(c);
        if (!f) continue;
        usedFiche = "context";
        meth.push(`## Data (from context indicator ${c})`, ...sections(f, CONTEXT_SECTIONS.slice(0, 5), "###"));
      }
    }
  }

  if (!usedFiche) {
    meth.push(
      ind.type === "output"
        ? `Output indicators are reported annually by Member States for their notified expenditure. Definitions and calculation rules are in Commission Implementing Regulation (EU) 2021/2290 and the Commission's output indicator fiches ([CAP indicators](${CAP_FICHES_URL})).`
        : `No Commission fiche was available for this indicator. See the [CAP indicators](${CAP_FICHES_URL}) page.`,
    );
  }
  const versions = [`Regulation (EU) 2021/2115, Annex I (consolidated text ${CAP_CELEX.replace(/^0(\d{4})R(\d{4})-(\d{4})(\d{2})(\d{2})$/, "of $5/$4/$3")})`];
  const ficheVersion = usedFiche ? ctx.versions[usedFiche] : undefined;
  if (ficheVersion) versions.push(ficheVersion);
  meth.push(
    `_Sources: ${versions.join("; ")}. Fiche text adapted (reformatted) from European Commission documents, licensed CC BY 4.0. Fiches: [CAP indicators](${CAP_FICHES_URL})._`,
  );

  return {
    id: `cap:${ind.code}`,
    source: "cap",
    title,
    sector: capSector(ind),
    level: LEVEL[ind.type],
    definition: tidy([def.join("\n\n"), facts.join("\n\n")].join("\n\n")),
    methodology: tidy(meth.join("\n\n")),
    url: CAP_LEGAL_URL,
  };
}

// ---------------------------------------------------------------- adapter

/** Run pdftotext; null if the tool or file is unavailable. */
export function pdfToText(file: string, mode: "-layout" | "-raw"): string | null {
  try {
    const p = Bun.spawnSync(["pdftotext", mode, "-enc", "UTF-8", file, "-"], { stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString() : null;
  } catch {
    return null;
  }
}

export function findFiche(dir: string, kind: "result" | "context"): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  const hit = files.find((f) => (kind === "result" ? /result/i.test(f) : /context|impact/i.test(f)));
  return hit ? join(dir, hit) : null;
}

export class CapAdapter implements Adapter {
  readonly source = "cap";
  readonly description = "EU CAP performance indicators (PMEF 2023–2027): Regulation 2021/2115 Annex I + Commission fiches (CC BY 4.0)";

  async *fetchAll(opts: FetchOptions): AsyncGenerator<UnifiedIndicator, AdapterStats> {
    const stats: AdapterStats = { ok: 0, failed: 0, total: 0 };
    const fetcher = new PoliteFetcher(opts.delayMs, opts.log, 3, 180_000);

    const url = `https://publications.europa.eu/resource/celex/${CAP_CELEX}`;
    opts.log(`Fetching Regulation 2021/2115 (${CAP_CELEX}) from the EU Publications Office (Cellar) ...`);
    const xhtml = await fetcher.text(url, "application/xhtml+xml", { "Accept-Language": "eng" });
    if (!xhtml) throw new Error(`Could not fetch ${url}`);
    const annexList = parseAnnexI(annexLines(xhtml));
    const annex = new Map(annexList.map((a) => [a.code, a]));
    opts.log(
      `Annex I: ${annexList.length} indicators (` +
        (["impact", "result", "output", "context"] as CapType[]).map((t) => `${annexList.filter((a) => a.type === t).length} ${t}`).join(", ") +
        ").",
    );

    const ctx: CapContext = { resultFiches: new Map(), contextFiches: new Map(), impactMap: new Map(), annex, versions: {} };
    const resultPdf = findFiche(CAP_FICHES_DIR, "result");
    const contextPdf = findFiche(CAP_FICHES_DIR, "context");
    if (resultPdf) {
      const layout = pdfToText(resultPdf, "-layout");
      if (layout) {
        ctx.resultFiches = parseResultFiches(layout);
        ctx.versions.result = ficheVersion(layout, "Commission result indicator fiches") ?? undefined;
      } else opts.log("  ! pdftotext is not available: result fiches skipped (brew install poppler)");
    }
    if (contextPdf) {
      const raw = pdfToText(contextPdf, "-raw");
      const layout = pdfToText(contextPdf, "-layout");
      if (raw && layout) {
        ctx.contextFiches = parseContextFiches(raw);
        ctx.impactMap = parseImpactContextMap(layout);
        for (const f of ctx.contextFiches.values()) {
          for (const i of f.impacts ?? []) {
            const list = ctx.impactMap.get(i) ?? [];
            if (!list.includes(f.code)) ctx.impactMap.set(i, [...list, f.code]);
          }
        }
        ctx.versions.context = ficheVersion(layout, "Commission context and impact indicator fiches") ?? undefined;
      } else opts.log("  ! pdftotext is not available: context/impact fiches skipped (brew install poppler)");
    }
    if (!resultPdf || !contextPdf) {
      opts.log(`  ! Fiche PDFs not found in ${CAP_FICHES_DIR}: ingesting Annex I descriptions without methodology for the missing ones.`);
    }
    opts.log(
      `Fiches: ${ctx.resultFiches.size} result, ${ctx.contextFiches.size} context/impact; impact→context links for ${ctx.impactMap.size} impact indicators.`,
    );

    let selected = annexList;
    if (opts.sectors?.length) {
      const wanted = opts.sectors.map((s) => s.toLowerCase());
      selected = selected.filter((a) => wanted.some((w) => capSector(a).toLowerCase().includes(w) || a.type === w));
    }
    if (opts.limit !== undefined) selected = selected.slice(0, opts.limit);
    stats.total = selected.length;

    for (const ind of selected) {
      try {
        yield buildCapRecord(ind, ctx);
        stats.ok++;
      } catch (err) {
        stats.failed++;
        opts.log(`  ✗ ${ind.code}: ${(err as Error).message}`);
      }
    }
    opts.log(`Built ${stats.ok} CAP records.`);
    return stats;
  }
}
