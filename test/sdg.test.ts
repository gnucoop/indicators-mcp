import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { readDocxBlocks } from "../src/adapters/docx.ts";
import {
  buildSdgRecord,
  GOAL_NAMES,
  goalSector,
  parseMetadataDocx,
  parseMetadataPage,
  splitSections,
  truncate,
} from "../src/adapters/sdg.ts";

/** Build a minimal .docx whose body is the given WordprocessingML. */
function makeDocx(bodyXml: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
  return zipSync({ "word/document.xml": strToU8(xml), "[Content_Types].xml": strToU8("<Types/>") });
}

const p = (text: string, style?: string, list = false) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${list ? '<w:numPr><w:ilvl w:val="0"/></w:numPr>' : ""}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const SAMPLE = makeDocx(
  [
    p("SDG indicator metadata"),
    p("0.g. International organisations(s) responsible for global monitoring (SDG_CUSTODIAN_AGENCIES)", "MIndHeader"),
    p("World Health Organization (WHO)", "MGTHeader"),
    p("United Nations Children's Fund (UNICEF)", "MGTHeader"),
    p("0.e. Metadata update (META_LAST_UPDATE)", "MIndHeader"),
    p("2024-09-27"),
    p("2.a. Definition and concepts (STAT_CONC_DEF)", "MHeader2"),
    p("Definition: share of people using safe water, monitored by the JMP (UNICEF) programme."),
    p("2.b. Unit of measure (UNIT_MEASURE)", "MHeader2"),
    p("Percent (%)"),
    p("4.c. Method of computation (DATA_COMP)", "MHeader2"),
    p("Step one", undefined, true),
    p("Step two", undefined, true),
    `<w:tbl><w:tr><w:tc>${p("Service level")}</w:tc><w:tc>${p("Definition")}</w:tc></w:tr><w:tr><w:tc>${p("Basic")}</w:tc><w:tc>${p("Improved source, ≤30 min")}</w:tc></w:tr></w:tbl>`,
    p("4.d. Validation (DATA_VALIDATION)", "MHeader2"),
    p("Country consultation."),
  ].join(""),
);

describe("docx reader", () => {
  test("reads paragraphs, list items and table rows in order", () => {
    const blocks = readDocxBlocks(SAMPLE);
    expect(blocks[0]?.text).toBe("SDG indicator metadata");
    expect(blocks.find((b) => b.text === "Step one")?.list).toBe(true);
    expect(blocks.filter((b) => b.kind === "row").map((b) => b.cells)).toEqual([
      ["Service level", "Definition"],
      ["Basic", "Improved source, ≤30 min"],
    ]);
  });

  test("rejects files that are not .docx", () => {
    expect(() => readDocxBlocks(zipSync({ "foo.txt": strToU8("x") }))).toThrow(/not a .docx/);
  });
});

describe("harmonized metadata", () => {
  test("splits sections by code and ignores inline parentheses", () => {
    const sections = splitSections(readDocxBlocks(SAMPLE));
    expect([...sections.keys()]).toEqual([
      "SDG_CUSTODIAN_AGENCIES",
      "META_LAST_UPDATE",
      "STAT_CONC_DEF",
      "UNIT_MEASURE",
      "DATA_COMP",
      "DATA_VALIDATION",
    ]);
    expect(sections.get("STAT_CONC_DEF")?.title).toBe("Definition and concepts");
    expect(sections.get("STAT_CONC_DEF")?.markdown).toContain("(UNICEF) programme");
    const comp = sections.get("DATA_COMP")!.markdown;
    expect(comp).toContain("- Step one\n- Step two");
    expect(comp).toContain("| Service level | Definition |\n| --- | --- |\n| Basic |");
  });

  test("falls back to the whole document when no template sections are found", () => {
    const meta = parseMetadataDocx(makeDocx(p("Old-style metadata without codes") + p("Some method text.")));
    expect(meta.sections.size).toBe(0);
    expect(meta.fallback).toContain("Some method text.");
  });
});

describe("metadata page", () => {
  test("maps indicator codes to their documents", () => {
    const html = `<ul>
      <li><small><strong>Indicator 1.1.1:</strong> Poverty</small>
        <ul class="list-inline"><li>(1) <a href="/sdgs/metadata/files/Metadata-01-01-01a.pdf">pdf</a>
        <a href="/sdgs/metadata/files/Metadata-01-01-01a.docx">doc</a></li>
        <li>(2) <a href="/sdgs/metadata/files/Metadata-01-01-01b.docx">doc</a></li></ul></li>
      <li><small><strong>Indicator 1.a.2:</strong> Spending</small>
        <ul><li><a href="/sdgs/metadata/files/Metadata-01-0a-02.docx">doc</a></li></ul></li>
      <li><small><strong>Target 1.2:</strong> not an indicator</small></li>
    </ul>`;
    const links = parseMetadataPage(html, "https://unstats.un.org/sdgs/metadata/");
    expect([...links.keys()]).toEqual(["1.1.1", "1.a.2"]);
    expect(links.get("1.1.1")?.docx).toEqual([
      "https://unstats.un.org/sdgs/metadata/files/Metadata-01-01-01a.docx",
      "https://unstats.un.org/sdgs/metadata/files/Metadata-01-01-01b.docx",
    ]);
    expect(links.get("1.1.1")?.pdf).toHaveLength(1);
  });
});

describe("record building", () => {
  const ind = {
    goal: "6",
    target: "6.1",
    code: "6.1.1",
    description: "Proportion of population using safely managed drinking water services",
    tier: "1",
    series: [
      { code: "SH_H2O_SAFE", description: "Safely managed drinking water (%)" },
      { code: "SH_H2O_SAFE", description: "duplicate" },
    ],
  };
  const goal = { code: "6", title: "Ensure availability of water" };
  const target = { goal: "6", code: "6.1", title: "Universal access to drinking water" };
  const url = "https://unstats.un.org/sdgs/metadata/files/Metadata-06-01-01.pdf";

  test("single document", () => {
    const r = buildSdgRecord(ind, goal, target, [{ url, meta: parseMetadataDocx(SAMPLE) }], url);
    expect(r).toMatchObject({ id: "sdg:6.1.1", source: "sdg", sector: "SDG 6 Clean Water and Sanitation", level: null, url });
    expect(r.definition).toContain("**Target 6.1:** Universal access");
    expect(r.definition).toContain("**Custodian agencies:** World Health Organization (WHO); United Nations Children's Fund (UNICEF)");
    expect(r.definition!.match(/SH_H2O_SAFE/g)).toHaveLength(1);
    expect(r.definition).toContain("## Definition and concepts");
    expect(r.methodology).toContain("## Method of computation");
    expect(r.methodology).not.toContain("Validation");
    expect(r.methodology).toContain("last updated 2024-09-27");
  });

  test("several documents are labelled as parts", () => {
    const meta = parseMetadataDocx(SAMPLE);
    const r = buildSdgRecord(ind, goal, target, [
      { url, meta },
      { url, meta },
    ], url);
    expect(r.methodology).toContain("## Metadata part A");
    expect(r.methodology).toContain("## Metadata part B");
    expect(r.methodology).toContain("### Method of computation");
  });

  test("no document still yields a usable record", () => {
    const r = buildSdgRecord(ind, goal, target, [], url);
    expect(r.title).toBe(ind.description);
    expect(r.methodology).toContain("No metadata document could be retrieved");
  });
});

describe("helpers", () => {
  test("goal sector names contain no commas (sector lists are comma-separated)", () => {
    expect(Object.keys(GOAL_NAMES)).toHaveLength(17);
    for (const code of Object.keys(GOAL_NAMES)) expect(goalSector(code)).not.toContain(",");
  });

  test("truncate cuts at a paragraph boundary", () => {
    const text = `${"a".repeat(80)}\n\n${"b".repeat(80)}`;
    const t = truncate(text, 100);
    expect(t.startsWith("a".repeat(80))).toBe(true);
    expect(t).not.toContain("b");
    expect(t).toContain("truncated");
    expect(truncate("short", 100)).toBe("short");
  });
});
