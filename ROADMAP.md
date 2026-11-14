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

### ⚠️ EU Global Europe Results Framework (INTPA)

IndiKit already flags these indicators, but the methodology notes are PDFs, which take more work to parse.

### ⚠️ Former USAID standard indicators and the old Humanitarian Indicator Registry

I believe both have been taken offline or retired. Verify before planning anything around them.

## Related features

- **Related indicators across sources.** IndiKit's sector pages flag indicators that match SDG indicators. Store those links (and WDI or WHO matches, for example where the World Bank metadata cites an SDG series code as its original source) as a "related" field, so `get_indicator_details` points to an indicator's counterparts in other repositories.
- **Per-source D1 updates.** `scripts/export-d1.ts` currently replaces the whole D1 catalog. A `--source` option would refresh one repository without touching the others and without the few seconds of downtime.
- **Scheduled refresh.** A periodic job (e.g. monthly) to re-ingest all sources, check the counts, and update D1 and the Docker image.
