/**
 * Minimal HTML → Markdown converter for the content blocks of indicator pages
 * (paragraphs, emphasis, lists, links, line breaks, simple tables).
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table",
]);

interface Ctx {
  baseUrl?: string;
  listDepth: number;
}

export function htmlToMarkdown(html: string, baseUrl?: string): string {
  const $ = cheerio.load(`<root>${html}</root>`, null, false);
  const root = $("root").get(0);
  if (!root) return "";
  return tidy(renderChildren(root as Element, { baseUrl, listDepth: 0 }));
}

function renderChildren(el: Element, ctx: Ctx): string {
  return el.children.map((c) => renderNode(c, ctx)).join("");
}

function isTag(n: AnyNode, ...names: string[]): n is Element {
  return n.type === "tag" && (names.length === 0 || names.includes((n as Element).name.toLowerCase()));
}

function renderNode(node: AnyNode, ctx: Ctx): string {
  if (node.type === "text") {
    return (node as unknown as { data: string }).data.replace(/[ \t\r\n ]+/g, " ");
  }
  if (node.type !== "tag") return ""; // comments, scripts, styles, directives
  const el = node as Element;
  const tag = el.name.toLowerCase();
  const inner = () => renderChildren(el, ctx);
  // Invisible text (white-on-white placeholders, display:none) is layout filler.
  const style = (el.attribs.style ?? "").replace(/\s+/g, "").toLowerCase();
  if (/(^|;)color:(rgb\(255,255,255\)|#fff\b|#ffffff\b|white\b)/.test(style) || style.includes("display:none")) return "";

  switch (tag) {
    case "noscript":
    case "img":
    case "svg":
    case "button":
      return "";
    case "br":
      return "  \n";
    case "strong":
    case "b":
      return wrapInline(inner(), "**");
    case "em":
    case "i":
      return wrapInline(inner(), "_");
    case "code":
      return wrapInline(inner(), "`");
    case "a": {
      const text = inner().trim();
      let href = el.attribs.href?.trim();
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return text;
      if (ctx.baseUrl) {
        try {
          href = new URL(href, ctx.baseUrl).toString();
        } catch {
          /* keep as-is */
        }
      }
      return text ? `[${text}](${href})` : `<${href}>`;
    }
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      // Nest below the "## Section" headings the adapter adds.
      const level = Math.min(6, Number(tag[1]) + 2);
      const text = inner().trim();
      return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "";
    }
    case "ul":
    case "ol": {
      const ordered = tag === "ol";
      const items = el.children.filter((c): c is Element => isTag(c, "li"));
      const indent = "  ".repeat(ctx.listDepth);
      const lines = items
        .map((li, i) => {
          const body = tidy(renderChildren(li, { ...ctx, listDepth: ctx.listDepth + 1 }));
          if (!body) return null;
          return `${indent}${ordered ? `${i + 1}.` : "-"} ${body.replace(/\n/g, `\n${indent}  `)}`;
        })
        .filter((l): l is string => l !== null);
      return lines.length ? `\n\n${lines.join("\n")}\n\n` : "";
    }
    case "li":
      return `\n- ${inner().trim()}\n`;
    case "table":
      return renderTable(el, ctx);
    default: {
      const content = inner();
      return BLOCK_TAGS.has(tag) ? `\n\n${content.trim()}\n\n` : content;
    }
  }
}

function wrapInline(text: string, mark: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  // Emphasis around block content (paragraphs, lists) can't be expressed inline.
  if (trimmed.includes("\n\n")) return text;
  const lead = /^\s/.test(text) ? " " : "";
  const trail = /\s$/.test(text) ? " " : "";
  return `${lead}${mark}${trimmed}${mark}${trail}`;
}

function renderTable(table: Element, ctx: Ctx): string {
  const rows: string[][] = [];
  const walk = (n: AnyNode) => {
    if (!isTag(n)) return;
    if (n.name.toLowerCase() === "tr") {
      const cells = n.children
        .filter((c): c is Element => isTag(c, "td", "th"))
        .map((c) => tidy(renderChildren(c, ctx)).replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|"));
      if (cells.length) rows.push(cells);
      return;
    }
    n.children.forEach(walk);
  };
  walk(table);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...new Array<string>(width - r.length).fill("")]);
  const [head, ...body] = norm;
  const line = (r: string[]) => `| ${r.join(" | ")} |`;
  return `\n\n${[line(head!), line(new Array<string>(width).fill("---")), ...body.map(line)].join("\n")}\n\n`;
}

/** Remove whitespace noise: empty emphasis, trailing spaces, runs of blank lines. */
export function tidy(md: string): string {
  return md
    .replace(/ /g, " ")
    // "**a** **b**" → "**a b**", "****" → "" (adjacent or empty bold runs)
    .replace(/\*\*([^\S\n]*)\*\*/g, "$1")
    .replace(/(^|[^_\w])_([^\S\n]*)_(?=[^_\w]|$)/g, "$1$2")
    .split("\n")
    .map((l) => (l.endsWith("  ") && l.trim() ? l.trimEnd() + "  " : l.trimEnd()))
    .join("\n")
    .replace(/[^\S\n]{2,}(?=\S)/g, (m, off: number, s: string) => (off === 0 || s[off - 1] === "\n" ? m : " "))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
