import { describe, expect, test } from "bun:test";
import {
  annexLines,
  buildCapRecord,
  capSector,
  ficheVersion,
  parseAnnexI,
  parseContextFiches,
  parseImpactContextMap,
  parseResultFiches,
  reflow,
  type CapContext,
} from "../src/adapters/cap.ts";

const ANNEX_XHTML = `<html><body>
<p>See ANNEX I below</p>
<p class="title-annex-1">ANNEX I</p>
<p>IMPACT, RESULT, OUTPUT AND CONTEXT INDICATORS PURSUANT TO ARTICLE 7</p>
<table>
<tr><td>To contribute to climate change mitigation and adaptation, including by reducing greenhouse gas emissions</td></tr>
<tr><td>I.10 Contributing to climate change mitigation: Greenhouse gas emissions from agriculture</td></tr>
<tr><td>R.14PR Carbon storage in soils and biomass: Share of UAA under supported commitments</td></tr>
<tr><td>To enhance market orientation and increase farm competitiveness</td></tr>
<tr><td>R.8 Targeting farms in specific sectors:</td></tr>
<tr><td>Share of farms benefitting from coupled income support</td></tr>
</table>
<p>▼M5</p><p>Monitoring – OUTPUT</p>
<table>
<tr><td>Risk management tools (Article 76)</td></tr>
<tr><td>O.9 Number of units covered by supported CAP risk management tools</td></tr>
<tr><td>Crisis payments for farmers (Article 78a)</td></tr>
<tr><td>O.9a Number of farmers benefitting from crisis payments</td></tr>
</table>
<p>CONTEXT INDICATORS</p>
<table>
<tr><td>Indicator number</td><td>Context indicator</td></tr>
<tr><td>Water</td></tr>
<tr><td>C.39</td><td>Water quality</td></tr>
<tr><td>Gross nutrient balance – nitrogen</td></tr>
<tr><td>Nitrates in ground water</td></tr>
<tr><td>Soil</td></tr>
<tr><td>C.40</td><td>Soil organic carbon in agricultural land</td></tr>
</table>
<p class="title-annex-1">ANNEX II</p><p>R.99 must not be parsed</p>
</body></html>`;

const RESULT_LAYOUT = `Code     Result indicators
R.14PR   Carbon storage in soils and     Share of utilised agricultural area
                                            DISCLAIMER
 The document has no legal binding value and does not bind the European Commission in relation to the
                     approval of the CAP strategic plans and their amendments.
                                                  7
                                        Result indicators
                                     27/12/2024 – Version 21.0
 Indicator name             R.14PR Carbon storage in soils and biomass: Share of utilised
                            agricultural area (UAA) [back to overview]
Definition and aim         To quantify the coverage of commitments to reduce GHG emissions
                           with CAP support.
Types of intervention      The following types of interventions may be concerned:
concerned                   • Schemes for the climate (Article 31)
                            • Management commitments (Article 70)
Unit of measurement        %
Moment of data             Operations with a first payment in the Financial Year.
collection
Methodology                Number of hectares under relevant commitments
                           divided by total UAA
Comments/caveats           Double counting is avoided.
Indicator name             R.15 Renewable energy: Supported investments (in MW)
Definition and aim         To quantify supported capacity.`;

const CONTEXT_RAW = `INDICATOR C.08
Indicator Name
Employment
Definition
This indicator shows employment figures:
1. total employment
2. share by sector
Unit of measurement
1: number of persons (in thousands)
2: %
Data source
1: Tables on EU policy
2 and 4: Eurostat – Labour Force Survey
References / location
of the data
[lfsi_emp_a]
DISCLAIMER
This document has been prepared by the Commission services as guidance to the Member States or to any other
Context and Impact indicators 25/10/2024 – Version 10.0
14
Frequency
Annual
INDICATOR C.16 Indicator I.23 Attracting young farmers:
Indicator Name
New farm managers
Definition
Number of new farm managers.
Data source
Eurostat IFS
INDICATOR C.39
Indicator Name
Gross nutrient balance
Definition
Nitrogen surplus.
INDICATOR C.39
Indicator Name
Nitrates in groundwater
Definition
Nitrate concentration.`;

const IMPACT_LAYOUT = ` Labour market            I.24        C.06          C.05       Employment rate in rural areas
 To support viable farm income and            I.2            C.26      Reducing income disparities
                                             I.10            C.44      Contributing to climate change`;

describe("Annex I", () => {
  const list = parseAnnexI(annexLines(ANNEX_XHTML));
  const by = new Map(list.map((a) => [a.code, a]));

  test("finds every indicator of Annex I only", () => {
    expect(list.map((a) => a.code)).toEqual(["I.10", "R.14", "R.8", "O.9", "O.9a", "C.39", "C.40"]);
  });

  test("impact and result: name, description, objective, PR flag, split lines", () => {
    expect(by.get("R.14")).toMatchObject({ type: "result", pr: true, name: "Carbon storage in soils and biomass" });
    expect(by.get("R.8")).toMatchObject({ name: "Targeting farms in specific sectors", description: "Share of farms benefitting from coupled income support" });
    expect(by.get("I.10")!.group).toContain("climate change mitigation");
    expect(capSector(by.get("R.8")!)).toBe("CAP – Competitiveness");
  });

  test("output: type of intervention, letter suffix codes", () => {
    expect(by.get("O.9a")).toMatchObject({ type: "output", group: "Crisis payments for farmers (Article 78a)" });
    expect(capSector(by.get("O.9")!)).toBe("CAP – Outputs");
  });

  test("context: name on the next line, topic heading, sub-items ignored", () => {
    expect(by.get("C.39")).toMatchObject({ name: "Water quality", group: "Water" });
    expect(by.get("C.40")).toMatchObject({ name: "Soil organic carbon in agricultural land", group: "Soil" });
  });
});

describe("fiches", () => {
  test("result fiches: indented labels, continuations, noise removed", () => {
    const f = parseResultFiches(RESULT_LAYOUT);
    expect([...f.keys()]).toEqual(["R.14", "R.15"]);
    const r14 = f.get("R.14")!.fields;
    expect(r14.definition).toBe("To quantify the coverage of commitments to reduce GHG emissions with CAP support.");
    expect(r14.interventions).toContain("- Schemes for the climate (Article 31)\n- Management commitments (Article 70)");
    expect(r14.moment).toBe("Operations with a first payment in the Financial Year.");
    expect(r14.methodology).toBe("Number of hectares under relevant commitments divided by total UAA");
    expect(JSON.stringify(r14)).not.toMatch(/DISCLAIMER|Version 21|back to overview/);
    expect(r14.interventions!.startsWith("The following types")).toBe(true); // label continuation "concerned" stripped
    expect(r14.moment).not.toContain("collection"); // label continuation "collection" stripped
  });

  test("context fiches: numbered lists, label continuations, impact in header, multi-part merge", () => {
    const f = parseContextFiches(CONTEXT_RAW);
    const c08 = f.get("C.08")!.fields;
    expect(c08.unit).toBe("1: number of persons (in thousands)\n2: %");
    expect(c08.source).toBe("1: Tables on EU policy\n2 and 4: Eurostat – Labour Force Survey");
    expect(c08.references).toBe("[lfsi_emp_a]");
    expect(c08.frequency).toBe("Annual");
    expect(JSON.stringify(c08)).not.toMatch(/DISCLAIMER|Version 10|prepared by the Commission/);
    expect(f.get("C.16")!.impacts).toEqual(["I.23"]);
    expect(f.get("C.39")!.fields.definition).toBe("**Gross nutrient balance:** Nitrogen surplus.\n\n**Nitrates in groundwater:** Nitrate concentration.");
  });

  test("impact → context map and fiche version", () => {
    const m = parseImpactContextMap(IMPACT_LAYOUT);
    expect(m.get("I.24")).toEqual(["C.06"]);
    expect(m.get("I.2")).toEqual(["C.26"]);
    expect(m.get("I.10")).toEqual(["C.44"]);
    expect(ficheVersion("Result indicators\n27/12/2024 – Version 21.0", "Result fiches")).toBe("Result fiches v21.0 (27/12/2024)");
  });

  test("reflow joins wrapped lines and keeps list items", () => {
    expect(reflow(["A sentence that", "continues here.", "• first", "• second"])).toBe("A sentence that continues here.\n\n- first\n- second");
  });
});

describe("records", () => {
  const list = parseAnnexI(annexLines(ANNEX_XHTML));
  const annex = new Map(list.map((a) => [a.code, a]));
  const ctx: CapContext = {
    resultFiches: parseResultFiches(RESULT_LAYOUT),
    contextFiches: parseContextFiches(CONTEXT_RAW),
    impactMap: new Map([["I.10", ["C.40"]]]),
    annex,
    versions: { result: "Commission result indicator fiches v21.0 (27/12/2024)", context: "Commission context and impact indicator fiches v10.0 (25/10/2024)" },
  };

  test("result with fiche", () => {
    const r = buildCapRecord(annex.get("R.14")!, ctx);
    expect(r).toMatchObject({ id: "cap:R.14", source: "cap", title: "Carbon storage in soils and biomass", level: "Outcome", sector: "CAP – Climate change" });
    expect(r.definition).toContain("## Definition and aim");
    expect(r.definition).toContain("**Unit:** %");
    expect(r.definition).toContain("`R.14PR`");
    expect(r.methodology).toContain("## Methodology");
    expect(r.methodology).toContain("result indicator fiches v21.0");
    expect(r.methodology).not.toContain("context and impact indicator fiches");
    expect(r.methodology).toContain("CC BY 4.0");
  });

  test("impact links to its context indicator; output has no fiche", () => {
    const i = buildCapRecord(annex.get("I.10")!, ctx);
    expect(i.level).toBe("Impact");
    expect(i.definition).toContain("**Measured with context indicator(s):** C.40 (Soil organic carbon in agricultural land)");
    const o = buildCapRecord(annex.get("O.9a")!, ctx);
    expect(o).toMatchObject({ level: "Output", title: "Number of farmers benefitting from crisis payments" });
    expect(o.methodology).toContain("Implementing Regulation (EU) 2021/2290");
    const c = buildCapRecord(annex.get("C.39")!, ctx);
    expect(c.level).toBeNull();
    expect(c.sector).toBe("CAP – Context – Water");
  });
});
