/**
 * IndiKit (https://www.indikit.net) adapter.
 *
 * DOM verified against the live site (Nov 2026):
 *  - Home page links every sector as /sector/<id>-<slug>.
 *  - A sector page has <h1> = sector name and groups `div.filter__sector`, each
 *    with `h2.fs-lead` (sub-group) and `li > a[href*="/indicator/"]`. Items
 *    behind "See more" are in the HTML (hidden by CSS), so no pagination.
 *  - An indicator page has `.page__content h1` = title and `div.indicatorBlock`
 *    blocks, each with `.indicatorBlock__title` + `.indicatorBlock__content`.
 *
 * robots.txt asks for Crawl-Delay: 1, so the default delay is 1000 ms.
 */
import * as cheerio from "cheerio";
import type { UnifiedIndicator } from "../types.ts";
import type { Adapter, AdapterStats, FetchOptions } from "./types.ts";
import { htmlToMarkdown, tidy } from "./html-to-md.ts";

export const INDIKIT_BASE = "https://www.indikit.net";
export const USER_AGENT =
  "indicators-mcp/0.1 (open-source M&E indicator index for MCP; respects robots.txt crawl-delay)";

const LEVELS = ["Process", "Output", "Outcome", "Impact"];

export interface SectorLink {
  name: string;
  slug: string;
  url: string;
}

export interface IndicatorLink {
  slug: string;
  url: string;
  sector: string;
  group: string | null;
}

/** Fetch with a minimum gap between requests, retries and a clear User-Agent. */
export class PoliteFetcher {
  private last = 0;
  constructor(
    private delayMs: number,
    private log: (m: string) => void = console.error,
    private retries = 3,
  ) {}

  async text(url: string): Promise<string | null> {
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      const wait = this.last + this.delayMs - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      this.last = Date.now();
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
          redirect: "follow",
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) return await res.text();
        if (res.status === 404 || res.status === 410) {
          this.log(`  ✗ ${res.status} ${url}`);
          return null;
        }
        this.log(`  ! HTTP ${res.status} for ${url} (attempt ${attempt}/${this.retries})`);
      } catch (err) {
        this.log(`  ! ${(err as Error).message} for ${url} (attempt ${attempt}/${this.retries})`);
      }
      await Bun.sleep(this.delayMs * 2 ** attempt);
    }
    this.log(`  ✗ giving up on ${url}`);
    return null;
  }
}

function slugFromUrl(url: string): string {
  const path = new URL(url, INDIKIT_BASE).pathname.replace(/\/+$/, "");
  return decodeURIComponent(path.split("/").pop() ?? path);
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function parseSectorIndex(html: string): SectorLink[] {
  const $ = cheerio.load(html);
  const seen = new Map<string, SectorLink>();
  $('a[href*="/sector/"]').each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    const url = new URL(href, INDIKIT_BASE);
    if (!/^\/sector\/[^/]+\/?$/.test(url.pathname)) return;
    url.hash = "";
    url.search = "";
    const slug = slugFromUrl(url.toString());
    const name = clean($(a).text());
    const existing = seen.get(slug);
    if (!existing) seen.set(slug, { slug, url: url.toString(), name: name || slug });
    else if (!existing.name || existing.name === slug) existing.name = name || slug;
  });
  return [...seen.values()];
}

export function parseSectorPage(html: string, fallbackName: string): { name: string; indicators: IndicatorLink[] } {
  const $ = cheerio.load(html);
  const name = clean($(".page__content h1").first().text() || $("h1").first().text()) || fallbackName;
  const out = new Map<string, IndicatorLink>();

  const add = (href: string | undefined, group: string | null) => {
    if (!href) return;
    const url = new URL(href, INDIKIT_BASE);
    if (!/^\/indicator\/[^/]+\/?$/.test(url.pathname)) return;
    url.hash = "";
    url.search = "";
    const slug = slugFromUrl(url.toString());
    if (!out.has(slug)) out.set(slug, { slug, url: url.toString(), sector: name, group });
  };

  $(".filter__sector").each((_, g) => {
    const group = clean($(g).children("h2").first().text()) || null;
    $(g)
      .find('a[href*="/indicator/"]')
      .each((_, a) => add($(a).attr("href"), group));
  });
  // Fallback in case the grouping markup changes.
  if (out.size === 0) {
    $('main a[href*="/indicator/"], .page__content a[href*="/indicator/"]').each((_, a) => add($(a).attr("href"), null));
  }
  return { name, indicators: [...out.values()] };
}

export interface ParsedIndicator {
  title: string;
  level: string | null;
  definition: string | null;
  methodology: string | null;
}

/** Turn one indicator page into the canonical text fields. */
export function parseIndicatorPage(html: string, url: string, context?: { group?: string | null }): ParsedIndicator | null {
  const $ = cheerio.load(html);
  const title = clean($(".page__content h1").first().text() || $("h1").first().text());
  if (!title) return null;

  const blocks: { title: string; html: string; el: ReturnType<typeof $> }[] = [];
  $(".indicatorBlock").each((_, b) => {
    const el = $(b);
    const t = clean(el.find(".indicatorBlock__title").first().text());
    const contentEl = el.find(".indicatorBlock__content").first();
    blocks.push({ title: t, html: contentEl.length ? (contentEl.html() ?? "") : (el.html() ?? ""), el });
  });

  const find = (re: RegExp) => blocks.find((b) => re.test(b.title));
  const md = (b?: { html: string }) => (b ? htmlToMarkdown(b.html, url) : "");
  const used = new Set<string>();
  const take = (re: RegExp) => {
    const b = find(re);
    if (b) used.add(b.title);
    return b;
  };

  // Level: one <div> per level, normalised to the canonical names.
  const levelBlock = take(/^indicator level/i);
  let level: string | null = null;
  if (levelBlock) {
    const values = levelBlock.el
      .find(".indicatorBlock__content div")
      .map((_, d) => clean($(d).text()))
      .get()
      .filter(Boolean);
    const normalised = values
      .map((v) => LEVELS.find((l) => l.toLowerCase() === v.toLowerCase()) ?? v)
      .filter((v, i, a) => a.indexOf(v) === i);
    level = normalised.length ? normalised.join(", ") : null;
  }

  const wording = md(take(/^indicator wording/i));
  const purpose = md(take(/^indicator purpose/i));
  const definitionParts: string[] = [];
  if (wording) definitionParts.push(wording);
  if (purpose) definitionParts.push(`## Purpose\n\n${purpose}`);

  const sections: [string, RegExp][] = [
    ["How to Collect and Analyse the Required Data", /^how to collect/i],
    ["Disaggregate by", /^disaggregate/i],
    ["Important Comments", /^important comments/i],
  ];
  const methodParts: string[] = [];
  if (context?.group) methodParts.push(`_Category: ${context.group}_`);
  for (const [heading, re] of sections) {
    const body = md(take(re));
    if (body) methodParts.push(`## ${heading}\n\n${body}`);
  }

  // Document lists (Access Additional Guidance, E-Questionnaire): list items as links.
  for (const b of blocks) {
    if (!b.el.hasClass("indicatorBlock--documents")) continue;
    used.add(b.title);
    const items = b.el
      .find("li")
      .map((_, li) => {
        const a = $(li).find("a").first();
        const href = a.attr("href");
        const label = clean(a.text());
        const meta = clean($(li).clone().find("a").remove().end().text());
        if (!href) return null;
        const abs = new URL(href, url).toString();
        return `- [${label || abs}](${abs})${meta ? ` — ${meta}` : ""}`;
      })
      .get()
      .filter(Boolean);
    if (items.length) methodParts.push(`## ${b.title || "Resources"}\n\n${items.join("\n")}`);
  }

  // Any other titled content block we don't know yet: keep it rather than lose it.
  for (const b of blocks) {
    if (!b.title || used.has(b.title) || /propose improvements/i.test(b.title)) continue;
    const body = md(b);
    if (body) methodParts.push(`## ${b.title}\n\n${body}`);
  }

  // Attribution ("This guidance was prepared by ...").
  const credit = clean($(".indicatorBlock--noCols").text());
  const creditMatch = credit.match(/This guidance was prepared by[^©]*©?/i);
  if (creditMatch) methodParts.push(`_${clean(creditMatch[0])}_`);

  return {
    title,
    level,
    definition: definitionParts.length ? tidy(definitionParts.join("\n\n")) : null,
    methodology: methodParts.length ? tidy(methodParts.join("\n\n")) : null,
  };
}

export class IndiKitAdapter implements Adapter {
  readonly source = "indikit";
  readonly description = "IndiKit — guidance on SMART indicators for relief and development projects (People in Need)";

  async *fetchAll(opts: FetchOptions): AsyncGenerator<UnifiedIndicator, AdapterStats> {
    const fetcher = new PoliteFetcher(opts.delayMs, opts.log);
    const stats: AdapterStats = { ok: 0, failed: 0, total: 0 };

    opts.log(`Fetching sector index from ${INDIKIT_BASE} ...`);
    const home = await fetcher.text(`${INDIKIT_BASE}/`);
    if (!home) throw new Error("Could not fetch the IndiKit home page");
    let sectors = parseSectorIndex(home);
    if (opts.sectors?.length) {
      const wanted = opts.sectors.map((s) => s.toLowerCase());
      sectors = sectors.filter((s) => wanted.some((w) => s.slug.toLowerCase().includes(w) || s.name.toLowerCase().includes(w)));
    }
    opts.log(`Found ${sectors.length} sector(s).`);
    if (!sectors.length) return stats;

    // 1) Collect indicator links across sectors, merging multi-sector indicators.
    const bySlug = new Map<string, { url: string; sectors: string[]; group: string | null }>();
    for (const [i, s] of sectors.entries()) {
      const html = await fetcher.text(s.url);
      if (!html) {
        opts.log(`[sector ${i + 1}/${sectors.length}] ${s.name}: failed, skipping`);
        continue;
      }
      const page = parseSectorPage(html, s.name);
      for (const link of page.indicators) {
        const entry = bySlug.get(link.slug);
        if (entry) {
          if (!entry.sectors.includes(page.name)) entry.sectors.push(page.name);
        } else {
          bySlug.set(link.slug, { url: link.url, sectors: [page.name], group: link.group });
        }
      }
      opts.log(`[sector ${i + 1}/${sectors.length}] ${page.name}: ${page.indicators.length} indicators`);
    }

    // 2) Fetch and parse each indicator page.
    let links = [...bySlug.entries()];
    if (opts.limit !== undefined) links = links.slice(0, opts.limit);
    stats.total = links.length;
    opts.log(`Fetching ${links.length} indicator page(s) (${bySlug.size} unique found) ...`);

    for (const [i, [slug, info]] of links.entries()) {
      const prefix = `[${i + 1}/${links.length}]`;
      try {
        const html = await fetcher.text(info.url);
        const parsed = html ? parseIndicatorPage(html, info.url, { group: info.group }) : null;
        if (!parsed) {
          stats.failed++;
          opts.log(`${prefix} ✗ ${slug}`);
          continue;
        }
        stats.ok++;
        opts.log(`${prefix} ${info.sectors[0]} › ${parsed.title} ✓`);
        yield {
          id: `indikit:${slug}`,
          source: this.source,
          title: parsed.title,
          sector: info.sectors.join(", "),
          level: parsed.level,
          definition: parsed.definition,
          methodology: parsed.methodology,
          url: info.url,
        };
      } catch (err) {
        stats.failed++;
        opts.log(`${prefix} ✗ ${slug}: ${(err as Error).message}`);
      }
    }
    return stats;
  }
}
