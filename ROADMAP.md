# Roadmap

Planned and candidate indicator sources for indicators-mcp, plus related features. Each source becomes an adapter (`src/adapters/<name>.ts`) that yields `UnifiedIndicator` records with ids `<source>:<local id>`; see [Adding a repository](README.md#architecture).

Status legend: ✅ live · 🔜 next · 🧭 planned · ⚠️ check before planning

Checks were made on 14 Nov 2026. APIs and terms change, so re-verify before building.

## Live

| Source | Indicators | Notes |
|---|---|---|
| ✅ `indikit` — [IndiKit](https://www.indikit.net) | 511 | Project-level indicators with survey questions and calculation guidance. Crawled at 1 request/second (robots.txt). |
| ✅ `sdg` — [UN SDG global indicator framework](https://unstats.un.org/sdgs/indicators/indicators-list/) | 251 | UN Stats SDG API plus the harmonized metadata documents (.docx). |
| ✅ `wdi` — [World Bank World Development Indicators](https://datatopics.worldbank.org/world-development-indicators/) | 1,498 | Indicator list plus full series metadata from the World Bank API (20 bulk pages, ~10–30 min). CC BY 4.0. |
| ✅ `dhs` — [DHS Program](https://dhsprogram.com) indicators | 3,237 | Indicator definitions, denominators, topics and tags from the DHS Program Indicator Data API (~10 s). Citation required (included in every record). The API's robots.txt disallows `/rest/dhs/` for crawlers; the adapter makes ~8 documented API requests per run. DHS also runs its own [MCP server](https://api.dhsprogram.com/#/mcp-overview.html) for survey data values. |
| ✅ `cap` — [EU CAP performance indicators, PMEF 2023–2027](https://agriculture.ec.europa.eu/cap-my-country/performance-agricultural-policy/cap-indicators_en) | 161 | Regulation 2021/2115 Annex I (consolidated, via the EU Publications Office's Cellar service) plus the Commission's result and context/impact fiches (PDFs downloaded by hand into `sources/cap/`, parsed with pdftotext). CC BY 4.0. Output indicator fiches not yet found: output indicators have descriptions only. |

## Overview of reviewed sources

| Source | Status | Why |
|---|---|---|
| CSV / Excel adapter | 🔜 next | Own indicator libraries next to the public ones |
| EU CAP performance indicators (PMEF 2023–2027) | ✅ live as `cap` | 161 indicators; output indicator fiches still to find (would add methodology for the 39 output indicators) |
| EU Global Europe Results Framework (GERF, INTPA) | ⚠️ permission for notes | High value; titles/levels reusable from SWD(2022) 22 (CC BY 4.0); capacity4dev notes forbid remixing |
| WHO Indicator Metadata Registry | ⚠️ on hold | Website terms: substantial reproduction needs written permission |
| Sphere Handbook | ⚠️ permission | All rights reserved; posting online needs written permission |
| Sendai Framework indicators | ⚠️ mostly covered | Targets A–E already in `sdg`; UN document reuse unconfirmed |
| IFAD Core Outcome Indicators | ⚠️ permission | Good agri/rural content; bot wall; restrictive terms |
| PRIMA KPI handbook | ⚠️ permission | Agri-food/water R&I KPIs with methods; PDF only; no licence stated |
| CALP multipurpose cash outcome indicators | ⚠️ permission | Small set, heavy IndiKit overlap; no licence found; Cloudflare |
| UNICEF Strategic Plan Goal Area 3 manual | ⚠️ permission | Outdated (2018–2021); restrictive terms; outcome indicators overlap SDG/MICS |
| DeSIRA global M&E framework | ⚠️ permission | 28 niche agri-research indicators; PDF only; capacity4dev terms |
| Former USAID standard indicators / old Humanitarian Indicator Registry | ⚠️ verify | Believed offline or retired |
| FAO SDG data portal | ✓ already covered | Same SDG indicators and UN metadata as `sdg`; CC BY 4.0 links could be added |
| World Bank data catalogue beyond WDI | ✓ partly covered | `wdi` covers World Development Indicators; other World Bank databases not indexed |
| WHO GHO indicator list | ✓ see WHO above | Names only; metadata is in the registry (on hold) |
| Atlas4Dev (AICS) | ✗ not planned | Statistics atlas without M&E metadata; duplicates WDI/SDG |
| EU CAP context indicators (old CMEF) | ✗ not planned | Legacy set frozen at 2019, replaced by PMEF |
| UNDP "The Indicators We Want" | ✗ not planned | 2015 SDG 16 proposal list, superseded by the official SDG indicators |
| UNESCO TVET indicators (2012, probable identity) | ✗ not planned | Old list-type framework; licence and identity unconfirmed |

## Next

### 🔜 1. CSV / Excel adapter (`csv`)

Load an organisation's own indicator library (project indicators, a donor results framework, a cluster indicator list) next to the public sources.

- **Input:** a CSV or XLSX file with columns mapped onto the canonical fields (`id`, `title`, `sector`, `level`, `definition`, `methodology`, `url`).
- **Source name:** chosen per file, e.g. `--source csv:gnucoop --file indicators.xlsx` gives ids like `gnucoop:<id>`.
- **Validation:** missing ids and titles reported per row; Markdown kept as-is in text columns.
- **Privacy:** private libraries should stay in local or self-hosted deployments, not in the public endpoint's D1.

## Check before planning

### ⚠️ WHO — Indicator Metadata Registry (`who`) — on hold: reuse terms

Health indicators with official WHO metadata. Technically ready to build; **on hold because WHO's terms may require written permission** (decision of 14 Nov 2026).

**The problem.** WHO's [website terms of use](https://www.who.int/about/policies/terms-of-use) say: "Reproduction or translation of substantial portions of the web site, or any use other than for educational or other non-commercial purposes, require explicit, prior authorization in writing." Indexing all ~929 registry pages is arguably a "substantial portion", so the cautious reading is that we need WHO's written permission **even though our use is free and non-commercial**. (WHO publications are CC BY-NC-SA 3.0 IGO, but the registry is website content under the terms of use.) This is a flag, not legal advice.

**To unblock:** ask WHO (the GHO / data team) for written permission to index the registry metadata, with attribution and a link to each page, in a free public MCP server. Alternatives: use the adapter locally only and keep WHO out of the public Cloudflare endpoint (needs an export option to skip a source), or index only short fields (definition, unit, link).

**What we already know (checked 14 Nov 2026):**
- [Indicator Metadata Registry](https://www.who.int/data/gho/indicator-metadata-registry): 929 indicators, one page each (`imr-details/<id>`). No API, but the pages are server-rendered with consistent markup: each field is a `div.metadata-box` with a `div.metadata-title` label.
- Fields: short name, topic, rationale, definition, disaggregation, method of measurement, method of estimation, preferred data sources, unit of measure, dissemination frequency, comments, links, and the associated GHO data indicators.
- Crawl: one index page + 929 detail pages, ~16 min at 1 request/second. robots.txt only blocks a list of named bad bots; no crawl-delay.
- The GHO OData API (`ghoapi.azureedge.net/api/Indicator`) lists 3,092 indicator codes with names only, so the registry is the source worth indexing. The old Athena API has been retired.
- Planned mapping: id `who:<IMR id>`, sector = WHO topic, level = none; definition = short name, definition, unit, disaggregation; methodology = rationale, measurement, estimation, data sources, comments, links.

### ⚠️ Sphere Handbook (`sphere`) — needs written permission

Humanitarian minimum standards with key indicators and guidance notes (WASH, food security and nutrition, shelter, health, protection). **Needs Sphere's prior written permission** (checked 14 Nov 2026).

**The terms.** Sphere's [intellectual property page](https://www.spherestandards.org/intellectual-property/) lists the 2018 Handbook as "© Sphere Association, 2018. All rights reserved." It may be reproduced without a fee for educational purposes (training, research, programme activities) with acknowledgement, but not resold. Other uses, **including posting online**, reuse in other publications, translation and adaptation, need prior written permission from info@spherestandards.org. A public MCP server serving the handbook's indicators counts as posting online. Sphere's general statement that its resources are CC BY 4.0 "unless otherwise stated" does not appear to cover the Handbook, which carries its own all-rights-reserved notice. (Quoted via search results citing that page; Sphere's sites block automated access, so re-check the wording in a browser.)

**Other owners.** The Core Humanitarian Standard chapter is co-owned by the CHS Alliance, Sphere Association and Groupe URD, so permission must cover it too, or it is left out.

**Practical issues.**
- Sphere's sites (spherestandards.org, handbook.spherestandards.org) return HTTP 403 to scripted requests and show a Cloudflare bot check in browsers. Even with permission we'd need an agreed way to get the content (a file from Sphere, or permission to use the published PDF).
- A revision of the 2018 edition was launched in March 2026 (numbering and release date unclear). A permission request could cover the new edition too.

**To unblock:** ask Sphere (info@spherestandards.org) for written permission to index the key indicators and guidance notes, with attribution and a link back, in a free public MCP server; ask whether it can extend to the upcoming edition, and how to obtain the content.

### ⚠️ Sendai Framework indicators (`sendai`) — mostly covered already; reuse terms unclear

The 38 indicators for the 7 global targets of the Sendai Framework for Disaster Risk Reduction (A mortality, B affected people, C economic loss, D critical infrastructure and basic services, E DRR strategies, F international cooperation, G early warning), checked 14 Nov 2026.

**Already covered.** UNDRR is custodian of both frameworks, and 12 SDG records in our `sdg` source already carry the Sendai metadata (definition, computation, data sources): SDG 1.5.1–1.5.4, 11.5.1–11.5.3, 11.b.1–11.b.2 and 13.1.1–13.1.3. Together they cover targets **A–E**. Only **F** (international cooperation) and **G** (early warning) have no SDG counterpart.

**Sources.**
- The official list: report of the expert working group on indicators and terminology, UN document [A/71/644](https://digitallibrary.un.org/record/852089), endorsed by General Assembly resolution [A/RES/71/276](https://digitallibrary.un.org/record/859424) (2 Feb 2017). [PreventionWeb](https://www.preventionweb.net/sendai-framework/sendai-framework-monitor/indicators) republishes it (code, one-line wording, compound flag, a few notes; no definitions).
- Definitions and methods: UNDRR's [Technical Guidance for Monitoring and Reporting on Progress in Achieving the Global Targets of the Sendai Framework](https://www.undrr.org/publication/technical-guidance-monitoring-and-reporting-progress-achieving-global-targets-sendai) (2017, 180 pages, PDF only; no licence stated on the page; the PDF itself not yet checked).

**Terms.**
- UNDRR / PreventionWeb [website terms](https://www.undrr.org/terms-and-conditions-use-undrrorg): personal, non-commercial use only, "without any right to resell or redistribute them or to compile or create derivative works". Indexing the website's text needs permission.
- The indicator list is an official UN document. UN documents with a symbol were historically public domain ([ST/AI/189/Add.9/Rev.2](https://en.wikisource.org/wiki/Administrative_Instruction_ST/AI/189/Add.9/Rev.2)); the current [UN Publications Policy Manual (2020)](https://uncitral.un.org/sites/uncitral.un.org/files/media-documents/uncitral/en/policy_manual_rev_sept_2020.pdf) replaces it, and its treatment of documents is not confirmed. Public reuse of UN publications needs permission from permissions@un.org.

**Access.** PreventionWeb returns a "Security check" (HTTP 403) to scripted requests and asks for a 10-second crawl delay in robots.txt; browsers can view it.

**If we build it:** a small `sendai` source of 38 short records from the A/71/644 text (code, wording, target, compound flag), each linking to the matching SDG records and to the Technical Guidance. No crawling needed (the list is fixed). Before publishing on the public endpoint, confirm the reuse status of A/71/644 (permissions@un.org or UNDRR).

### ⚠️ EU Global Europe Results Framework — GERF (INTPA) (`gerf`) — permission needed for the notes

DG INTPA's results framework for NDICI-funded interventions, introduced by Commission Staff Working Document [SWD(2022) 22 final](https://data.consilium.europa.eu/doc/document/ST-5697-2022-INIT/en/pdf); home page on [capacity4dev](https://capacity4dev.europa.eu/resources/results-indicators_en). IndiKit already flags which of its indicators match.

- **Content:** Level 1 impact indicators (mostly SDG indicators and international indices, e.g. GERF 1.23 = SDG 1.1.1); Level 2 output/outcome indicators "to be used in logframes" (largely unique, close to IndiKit in style); Level 3 for policy mainstreaming. Roughly 70–100 indicators across Levels 1–2 (exact total not verified).
- **Methodology:** one methodological note (PDF) per Level 2 indicator: what it measures, policy relevance, data sources, required and suggested disaggregations, calculation method, examples; some notes "under development". Level 2 also in FR, ES, PT. [Combined Level 2 list](https://capacity4dev.europa.eu/sites/default/files/gerf_-_level_2_en-fr-sp-p_approved_version.pdf).
- **Terms:** capacity4dev [conditions](https://capacity4dev.europa.eu/conditions_en): cite the author and link to the source; per search summaries, not for commercial use and no remixing/transforming. Restructuring the notes into an index counts as transforming. The SWD itself is a Commission document, generally CC BY 4.0 under Decision 2011/833/EU ([legal notice](https://commission.europa.eu/legal-notice_en); the notice on that specific document not confirmed).
- **Access:** capacity4dev answered automated requests with HTTP 403 ("Not authorised", site-wide, even on the terms page) and then HTTP 429.
- **Options:** index Level 1–2 titles and levels from the SWD now (CC BY 4.0, with a link to each note); ask DG INTPA (support@capacity4dev.eu) before copying the notes' text.

### ⚠️ IFAD Core Outcome Indicators (`ifad`) — permission needed

IFAD's Core Indicators framework (reportedly ~45: outreach, output, outcome) and the [COI Measurement Guidelines](https://www.ifad.org/en/coitraining/) (2021) with survey methods for agriculture, market access, resilience, empowerment and nutrition outcomes. Overlaps IndiKit's agriculture/livelihoods indicators only partly.

- **Access:** all www.ifad.org URLs answered with HTTP 403 and an "IFAD | Checking your browser" bot page. robots.txt sets `Content-Signal: search=yes,ai-train=no,use=reference` and disallows AI crawlers.
- **Terms:** per search summaries of [ifad.org/legal](https://www.ifad.org/legal), materials are IFAD property; copying encouraged for non-commercial personal or educational use; no Creative Commons licence found.
- **To unblock:** ask IFAD; ingestion would then be manual from the guideline PDFs.

### ⚠️ PRIMA KPI handbook (`prima`) — permission needed

[KPIs handbook for applicants (2025)](https://prima-med.org/wp-content/uploads/2025/04/KPIs-handbook-for-the-applicants-2025-V1.0.pdf) of the PRIMA Foundation (EU Horizon Europe Art. 185 partnership for research and innovation in the Mediterranean): KPIs by impact area for agri-food and water (Nexus) projects, with descriptions, data collection methods, reporting guidelines and baselines. 74-page PDF (~5 MB); KPI count not verified.

- **Access:** prima-med.org answered normally; robots.txt only disallows `/experts/`.
- **Terms:** no licence or copyright statement found on the site; the PDF's own notice not checked. Ask PRIMA.

### ⚠️ CALP multipurpose cash outcome indicators (`calp`) — permission needed

[Multipurpose Outcome Indicators and Guidance](https://www.calpnetwork.org/publication/multipurpose-outcome-indicators-and-guidance/) (CALP Network / Grand Bargain cash workstream, May 2022; [ReliefWeb copy](https://reliefweb.int/report/world/multipurpose-outcome-indicators-and-guidance), 382 KB): household-level outcome indicators, cross-cutting (basic needs, protection, women's decision-making, coping strategies) and by sector, plus process indicators; EN, FR, ES, AR. Small set (estimated 25–40) with heavy IndiKit overlap.

- **Access:** calpnetwork.org answered automated requests with a Cloudflare challenge (HTTP 403).
- **Terms:** no licence or terms page found; footer "© The CALP Network". Check the PDF's notice or ask CALP.

### ⚠️ UNICEF Strategic Plan Goal Area 3 indicator manual (`unicef`) — permission needed, outdated

[Indicator Manual, Goal Area 3](https://www.unicef.org/documents/unicef-strategic-plan-goal-area-3-indicator-manual) (child protection, Strategic Plan 2018–2021, v1.7, PDF ~3.4 MB): definitions and calculation methods for outcome and output indicators. Superseded by the Strategic Plan 2022–2025 results framework; outcome indicators largely match SDG/MICS/DHS child-protection measures we already have.

- **Terms:** [unicef.org/legal](https://www.unicef.org/legal): "UNICEF reserves all copyrights on material on its Web pages"; personal and educational use; more than a de minimis portion needs prior written permission.

### ⚠️ DeSIRA global M&E framework (`desira`) — permission needed, low priority

[Methodology of the DeSIRA global M&E framework](https://capacity4dev.europa.eu/library/methodology-global-monitoring-and-evaluation-framework-desira_en) (DG INTPA, Nov 2022): 28 global indicators for the EU's agricultural research and innovation programme, partly mapped to EU results framework indicators. PDF only; same capacity4dev terms and access issues as GERF. Consider after GERF.

### ⚠️ Former USAID standard indicators and the old Humanitarian Indicator Registry

I believe both have been taken offline or retired. Verify before planning anything around them.

## Reviewed: already covered or not planned

- **FAO SDG data portal** ([link](https://www.fao.org/sustainable-development-goals-data-portal/data/en)): the 22–23 SDG indicators FAO is custodian of, with the same UN metadata we already index in `sdg`. CC BY 4.0 ([database terms](https://www.fao.org/contact-us/terms/db-terms-of-use/en)), so FAO portal links could be added to the matching SDG records.
- **World Bank data catalogue** ([data.worldbank.org/indicator](https://data.worldbank.org/indicator)): `wdi` covers the World Development Indicators (source 2, 1,498 indicators). The World Bank API has ~70 other databases (e.g. Health Nutrition and Population, Gender, Education) that are not indexed; a future option for `wdi`.
- **WHO GHO indicator list** ([link](https://www.who.int/data/gho/data/indicators)): names only; the metadata is in the Indicator Metadata Registry (on hold, see WHO above).
- **IndiKit** ([link](https://www.indikit.net/)): live as `indikit`.
- **Atlas4Dev** ([link](https://atlas.aics.gov.it/atlas4dev/), AICS): a statistics atlas aggregating international series (World Bank, UN, IMF…), mapped to SDGs; no definitions or methodology fields; GraphQL API behind a firewall; no licence stated. Duplicates WDI/SDG.
- **EU CAP context indicators, old CMEF** ([link](https://agridata.ec.europa.eu/extensions/DataPortal/context_indicators.html)): 45 indicators, data up to 2019, replaced by PMEF; pages are dashboards without definitions.
- **UNDP "The Indicators We Want"** ([link](https://www.undp.org/publications/indicators-we-want)): 2015 SIPRI sourcebook proposing SDG 16 indicators, superseded by the official SDG indicators; UNDP terms forbid redistribution; the site blocked automated access (Akamai 403; robots crawl-delay 10).
- **UNESCO document [pf0000260674](https://unesdoc.unesco.org/ark:/48223/pf0000260674)**: probably "Proposed Indicators for Assessing Technical and Vocational Education and Training" (inter-agency working group, 2012); UNESDOC is behind Cloudflare, so the identity and licence (UNESCO open access is CC BY-SA 3.0 IGO, but co-publications may differ) are unconfirmed. Low priority unless TVET coverage matters.

_The 14 Nov 2026 review of these sources was partly based on search summaries where sites blocked automated reading; each entry says what could not be verified._

## Related features

- **Related indicators across sources.** IndiKit's sector pages flag indicators that match SDG indicators. Store those links (and WDI or WHO matches, for example where the World Bank metadata cites an SDG series code as its original source) as a "related" field, so `get_indicator_details` points to an indicator's counterparts in other repositories.
- **Extra links on SDG records.** Add FAO's portal page to the SDG indicators FAO is custodian of, and GERF Level 1 codes to the SDG indicators they reuse.
- **Per-source D1 updates.** `scripts/export-d1.ts` currently replaces the whole D1 catalog. A `--source` option would refresh one repository without touching the others and without the few seconds of downtime.
- **Scheduled refresh.** A periodic job (e.g. monthly) to re-ingest all sources, check the counts, and update D1 and the Docker image.
