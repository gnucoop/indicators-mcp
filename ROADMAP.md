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

## Next

### 🔜 1. CSV / Excel adapter (`csv`)

Load an organisation's own indicator library (project indicators, a donor results framework, a cluster indicator list) next to the public sources.

- **Input:** a CSV or XLSX file with columns mapped onto the canonical fields (`id`, `title`, `sector`, `level`, `definition`, `methodology`, `url`).
- **Source name:** chosen per file, e.g. `--source csv:gnucoop --file indicators.xlsx` gives ids like `gnucoop:<id>`.
- **Validation:** missing ids and titles reported per row; Markdown kept as-is in text columns.
- **Privacy:** private libraries should stay in local or self-hosted deployments, not in the public endpoint's D1.

## Planned

### 🧭 2. WHO — Global Health Observatory + Indicator Metadata Registry (`who`)

Health indicators with official WHO definitions, method of measurement, numerator/denominator and disaggregation.

- **Verified:** the GHO OData API (`ghoapi.azureedge.net/api/Indicator`) is public and lists 3,092 indicators (code and name). The [Indicator Metadata Registry](https://www.who.int/data/gho/indicator-metadata-registry) is online.
- **Work:** the list only has names; definitions and methods come from the metadata registry pages, which need page parsing (like IndiKit). Matching GHO codes to registry entries needs checking.
- **To check:** WHO terms of use for reusing the metadata text.

### 🧭 3. DHS Program indicators (`dhs`)

Household-survey indicators (fertility, maternal and child health, nutrition, WASH, gender, HIV) with precise definitions, from the same survey world IndiKit draws on.

- **Verified:** the public REST API (`api.dhsprogram.com/rest/dhs/indicators`) returns 4,655 indicators with label, definition, denominator, measurement type and a three-level topic hierarchy. Small requests work without a key.
- **To check:** the DHS API terms (registration or API key for bulk use, attribution) and rate limits.
- **Mapping:** sector = Level1 topic (e.g. Fertility, Nutrition), definition = definition + denominator + measurement type.

## Check before planning

### ⚠️ Sphere Handbook

Valuable humanitarian minimum standards with key indicators, but the content is copyrighted, so we'd need to confirm reuse terms before indexing it.

### ⚠️ EU Global Europe Results Framework (INTPA)

IndiKit already flags these indicators, but the methodology notes are PDFs, which take more work to parse.

### ⚠️ Former USAID standard indicators and the old Humanitarian Indicator Registry

I believe both have been taken offline or retired. Verify before planning anything around them.

## Related features

- **Related indicators across sources.** IndiKit's sector pages flag indicators that match SDG indicators. Store those links (and WDI or WHO matches, for example where the World Bank metadata cites an SDG series code as its original source) as a "related" field, so `get_indicator_details` points to an indicator's counterparts in other repositories.
- **Per-source D1 updates.** `scripts/export-d1.ts` currently replaces the whole D1 catalog. A `--source` option would refresh one repository without touching the others and without the few seconds of downtime.
- **Scheduled refresh.** A periodic job (e.g. monthly) to re-ingest all sources, check the counts, and update D1 and the Docker image.
