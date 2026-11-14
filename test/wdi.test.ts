import { describe, expect, test } from "bun:test";
import { buildWdiRecord, cleanText, mergeWbMetadataPage, parseWbMetadata, wdiSectors, wdiUrl, type WbIndicator } from "../src/adapters/wdi.ts";

/** Shape of GET /v2/sources/2/series/<id>/metadata?format=json (trimmed). */
const METADATA_RESPONSE = {
  page: 1,
  pages: 1,
  per_page: 50,
  total: 1,
  source: [
    {
      id: "2",
      name: "World Development Indicators",
      concept: [
        {
          id: "Series",
          variable: [
            {
              id: "AG.LND.ARBL.HA.PC",
              metatype: [
                { id: "Aggregationmethod", value: "Weighted average" },
                { id: "Developmentrelevance", value: "Agriculture matters.\n\n\n\n\n\n\nStill a major employer." },
                { id: "License_Type", value: "CC BY-4.0" },
                { id: "Limitationsandexceptions", value: "  Not comparable across climates.  \n\n\n\n" },
                { id: "Longdefinition", value: "Arable land includes land under temporary crops." },
                { id: "Othernotes", value: null },
                { id: "Periodicity", value: "Annual" },
                { id: "Referenceperiod", value: "1961-2024" },
                { id: "Source", value: "Food and Agriculture Organization (FAO)" },
                { id: "Statisticalconceptandmethodology", value: "Methodology: fallow land under five years." },
                { id: "Topic", value: "Environment: Land use" },
                { id: "Unitofmeasure", value: "hectares per person" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const INDICATOR: WbIndicator = {
  id: "AG.LND.ARBL.HA.PC",
  name: "Arable land (hectares per person) ",
  unit: "",
  sourceNote: "Short definition from the list.",
  sourceOrganization: "FAO",
  topics: [{ id: "19", value: "Environment " }, { id: "1", value: "Agriculture & Rural Development" }],
};

describe("metadata parsing", () => {
  test("extracts non-empty fields and cleans blank-line runs", () => {
    const meta = parseWbMetadata(METADATA_RESPONSE)!;
    expect(meta.Longdefinition).toBe("Arable land includes land under temporary crops.");
    expect(meta.Developmentrelevance).toBe("Agriculture matters.\n\nStill a major employer.");
    expect(meta.Limitationsandexceptions).toBe("Not comparable across climates.");
    expect(meta).not.toHaveProperty("Othernotes");
  });

  test("returns null for errors and unexpected shapes", () => {
    expect(parseWbMetadata(null)).toBeNull();
    expect(parseWbMetadata({ source: [] })).toBeNull();
    expect(parseWbMetadata([{ message: [{ id: "120", value: "Invalid value" }] }])).toBeNull();
  });

  test("bulk pages merge a series split across pages and skip other concepts", () => {
    const page = (fields: [string, string][], id = "SH.STA.STNT.ZS", concept = "Series") => ({
      pages: 2,
      source: [{ concept: [{ id: concept, variable: [{ id, metatype: fields.map(([f, v]) => ({ id: f, value: v })) }] }] }],
    });
    const merged = mergeWbMetadataPage(page([["Longdefinition", "Stunting is…"]]));
    mergeWbMetadataPage(page([["Unitofmeasure", "%"]]), merged);
    mergeWbMetadataPage(page([["Topic", "x"]], "AFG", "Country"), merged);
    expect([...merged.keys()]).toEqual(["SH.STA.STNT.ZS"]);
    expect(merged.get("SH.STA.STNT.ZS")).toEqual({ Longdefinition: "Stunting is…", Unitofmeasure: "%" });
  });

  test("cleanText handles empty input", () => {
    expect(cleanText(undefined)).toBe("");
    expect(cleanText("a\r\n\r\n\r\n\r\nb")).toBe("a\n\nb");
  });
});

describe("record building", () => {
  test("full metadata", () => {
    const r = buildWdiRecord(INDICATOR, parseWbMetadata(METADATA_RESPONSE));
    expect(r).toMatchObject({
      id: "wdi:AG.LND.ARBL.HA.PC",
      source: "wdi",
      title: "Arable land (hectares per person)",
      sector: "Environment, Agriculture & Rural Development",
      level: null,
      url: "https://data.worldbank.org/indicator/AG.LND.ARBL.HA.PC",
    });
    expect(r.definition!.startsWith("Arable land includes")).toBe(true);
    expect(r.definition).toContain("**Unit of measure:** hectares per person");
    expect(r.definition).toContain("**Periodicity:** Annual · **Reference period:** 1961-2024");
    expect(r.definition).toContain("**Licence:** CC BY 4.0");
    const headings = r.methodology!.match(/^## .+$/gm);
    expect(headings).toEqual([
      "## Statistical concept and methodology",
      "## Limitations and exceptions",
      "## Development relevance",
      "## Aggregation method",
    ]);
  });

  test("without metadata falls back to the list definition", () => {
    const r = buildWdiRecord(INDICATOR, null);
    expect(r.definition).toContain("Short definition from the list.");
    expect(r.definition).toContain("**Source:** FAO");
    expect(r.methodology).toContain("could not be retrieved");
  });

  test("sector falls back to the broad metadata topic", () => {
    const meta = parseWbMetadata(METADATA_RESPONSE);
    expect(wdiSectors({ ...INDICATOR, topics: [] }, meta)).toBe("Environment");
    expect(wdiSectors({ ...INDICATOR, topics: null }, null)).toBeNull();
    expect(wdiSectors({ ...INDICATOR, topics: [{ value: "Trade, Finance" }] }, null)).toBe("Trade / Finance");
  });

  test("url encodes the indicator code", () => {
    expect(wdiUrl("SH.STA.STNT.ZS")).toBe("https://data.worldbank.org/indicator/SH.STA.STNT.ZS");
  });
});
