import { describe, expect, test } from "bun:test";
import { buildDhsRecord, dhsUrl, distinctTitles, parseTagIds, type DhsIndicator } from "../src/adapters/dhs.ts";

const WATER: DhsIndicator = {
  IndicatorId: "WS_SRCE_H_IMP",
  Label: "Households using an improved water source",
  Definition: "Percentage of households whose main source of drinking water is an improved source",
  Denominator: "Households",
  MeasurementType: "Percent",
  IndicatorType: "I",
  Level1: "Water and Sanitation",
  Level2: "Source of drinking water",
  Level3: "Households",
  TagIds: "80, 77, 7",
};

const TAGS = new Map([
  ["7", "MICS indicators"],
  ["77", "DHS Mobile"],
  ["80", "SDGs"],
]);

const CITATION = "The DHS Program Indicator Data API, ICF. [Accessed 11-14-2026]";

describe("DHS records", () => {
  test("maps fields, resolves tags and adds the citation", () => {
    const r = buildDhsRecord(WATER, WATER.Label, TAGS, CITATION);
    expect(r).toMatchObject({
      id: "dhs:WS_SRCE_H_IMP",
      source: "dhs",
      title: "Households using an improved water source",
      sector: "Water and Sanitation",
      level: null,
      url: "https://api.dhsprogram.com/rest/dhs/indicators?indicatorIds=WS_SRCE_H_IMP&f=json",
    });
    expect(r.definition!.startsWith("Percentage of households")).toBe(true);
    expect(r.definition).toContain("**Denominator:** Households");
    expect(r.definition).toContain("**Topic:** Water and Sanitation › Source of drinking water › Households");
    expect(r.definition).toContain("**Tags:** SDGs, MICS indicators");
    expect(r.definition).not.toContain("DHS Mobile");
    expect(r.methodology).toContain("Guide to DHS Statistics");
    expect(r.methodology).toContain(`_Citation: ${CITATION}_`);
  });

  test("tolerates missing optional fields", () => {
    const r = buildDhsRecord({ IndicatorId: "X_1", Label: "Something" }, "Something", new Map(), CITATION);
    expect(r.sector).toBeNull();
    expect(r.definition).toContain("**DHS indicator id:** `X_1`");
    expect(r.definition).not.toContain("**Tags:**");
  });

  test("duplicate labels get their topic appended", () => {
    const titles = distinctTitles([
      { IndicatorId: "FE_FRTR_W_GFR", Label: "General fertility rate", Level2: "Fertility rates", Level3: "Women" },
      { IndicatorId: "MM_MMRO_W_GFR", Label: "General fertility rate ", Level2: "Maternal mortality ratio", Level3: "Women" },
      WATER,
    ]);
    expect(titles.get("FE_FRTR_W_GFR")).toBe("General fertility rate (Fertility rates, Women)");
    expect(titles.get("MM_MMRO_W_GFR")).toBe("General fertility rate (Maternal mortality ratio, Women)");
    expect(titles.get("WS_SRCE_H_IMP")).toBe(WATER.Label);
  });

  test("helpers", () => {
    expect(parseTagIds("74, 1, 7")).toEqual(["74", "1", "7"]);
    expect(parseTagIds("")).toEqual([]);
    expect(parseTagIds(null)).toEqual([]);
    expect(dhsUrl("A B")).toContain("indicatorIds=A%20B");
  });
});
