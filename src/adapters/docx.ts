/**
 * Minimal .docx reader: unzips word/document.xml and returns its paragraphs
 * and table rows as plain text, in document order.
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { strFromU8, unzipSync } from "fflate";

export interface DocxBlock {
  kind: "paragraph" | "row";
  text: string;
  /** Paragraph style id (e.g. "MHeader2"), if any. */
  style: string | null;
  /** True for list items (numbered or bulleted paragraphs). */
  list: boolean;
  /** For table rows: the cell texts. */
  cells?: string[];
}

export function readDocxBlocks(bytes: Uint8Array): DocxBlock[] {
  const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("not a .docx file (word/document.xml missing)");
  const $ = cheerio.load(strFromU8(xml), { xml: true });
  const body = $("w\\:body").get(0);
  if (!body) return [];

  const blocks: DocxBlock[] = [];
  const paragraphText = (p: Element): string =>
    $(p)
      .find("w\\:t, w\\:tab, w\\:br, w\\:cr, w\\:noBreakHyphen")
      .map((_, el) => {
        switch ((el as Element).name) {
          case "w:t":
            return $(el).text();
          case "w:noBreakHyphen":
            return "-";
          case "w:tab":
            return " ";
          default:
            return "\n";
        }
      })
      .get()
      .join("")
      .replace(/[ \t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();

  const walk = (node: AnyNode) => {
    if (node.type !== "tag") return;
    const el = node as Element;
    if (el.name === "w:p") {
      const text = paragraphText(el);
      if (!text) return;
      const style = $(el).find("w\\:pPr > w\\:pStyle").attr("w:val") ?? null;
      const list = $(el).find("w\\:pPr > w\\:numPr").length > 0 || /list/i.test(style ?? "");
      blocks.push({ kind: "paragraph", text, style, list });
      return;
    }
    if (el.name === "w:tbl") {
      $(el)
        .children("w\\:tr")
        .each((_, tr) => {
          const cells = $(tr)
            .children("w\\:tc")
            .map((_, tc) =>
              $(tc)
                .find("w\\:p")
                .map((_, p) => paragraphText(p as Element))
                .get()
                .filter(Boolean)
                .join(" "),
            )
            .get();
          if (cells.some(Boolean)) blocks.push({ kind: "row", text: cells.join(" | "), style: null, list: false, cells });
        });
      return;
    }
    // Content controls, custom XML, smart tags...: descend.
    el.children.forEach(walk);
  };
  body.children.forEach(walk);
  return blocks;
}

/** Render blocks as Markdown: list items as bullets, consecutive rows as a table. */
export function blocksToMarkdown(blocks: DocxBlock[]): string {
  const out: string[] = [];
  let table: string[][] = [];
  const flushTable = () => {
    if (!table.length) return;
    const width = Math.max(...table.map((r) => r.length));
    const row = (r: string[]) =>
      `| ${[...r, ...new Array<string>(width - r.length).fill("")].map((c) => c.replace(/\|/g, "\\|").replace(/\n+/g, " ")).join(" | ")} |`;
    out.push([row(table[0]!), row(new Array<string>(width).fill("---")), ...table.slice(1).map(row)].join("\n"));
    table = [];
  };
  for (const b of blocks) {
    if (b.kind === "row") {
      table.push(b.cells ?? [b.text]);
      continue;
    }
    flushTable();
    out.push(b.list ? `- ${b.text.replace(/\n/g, " ")}` : b.text.replace(/\n/g, "  \n"));
  }
  flushTable();
  // Keep consecutive bullets together, separate everything else by a blank line.
  return out
    .reduce((acc, line, i) => {
      const prev = out[i - 1];
      const tight = prev !== undefined && prev.startsWith("- ") && line.startsWith("- ");
      return acc + (i === 0 ? "" : tight ? "\n" : "\n\n") + line;
    }, "")
    .trim();
}
