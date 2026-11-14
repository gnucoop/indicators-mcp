# indicators-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an LLM **search, inspect and compare Monitoring & Evaluation (M&E) indicators** from several repositories at once. It currently covers [IndiKit](https://www.indikit.net), the [UN SDG global indicator framework](https://unstats.un.org/sdgs/indicators/indicators-list/), the [World Bank World Development Indicators](https://datatopics.worldbank.org/world-development-indicators/) and the [DHS Program](https://dhsprogram.com) survey indicators. More sources are planned: see [ROADMAP.md](ROADMAP.md).

- **Fast and offline:** SQLite FTS5 full-text search, with no vector database and no live scraping during a conversation.
- **Two ways to use it:** a local **stdio** server, or a public **HTTP** endpoint (Streamable HTTP) on Docker or Cloudflare Workers.
- **Read-only:** ingestion is a separate CLI step.

| | Local (stdio) | Hosted (HTTP) |
|---|---|---|
| **How** | `bun run start` from your MCP client | Point your client at the hosted endpoint below |
| **Best for** | Unlimited use, offline | Zero setup, sharing with a team |
| **Limits** | None | 30 tool calls per minute per IP (see [Limits](#limits)) |

**Hosted endpoint:** `https://indicators-mcp.gnucoop.workers.dev/mcp` (free, no sign-up, running on Cloudflare Workers)

## Sources

| `source` | Repository | Indicators | What a record contains | Sectors |
|---|---|---|---|---|
| `indikit` | [IndiKit](https://www.indikit.net) (People in Need) | 511 | Project-level indicators: wording, purpose, survey questions, calculation, disaggregation, caveats. Logframe level (Output, Outcome, Impact, Process) | 25 humanitarian/development sectors (WASH, Food Security, Nutrition…) |
| `sdg` | [UN SDG global indicator framework](https://unstats.un.org/sdgs/indicators/indicators-list/) (UN Statistics Division) | 251 | Goal, target, tier, custodian agencies and data series, plus the official [metadata](https://unstats.un.org/sdgs/metadata/): definition, method of computation, rationale, limitations, data sources, disaggregation. No logframe level | The 17 goals, e.g. `SDG 6 Clean Water and Sanitation` |
| `wdi` | [World Bank World Development Indicators](https://datatopics.worldbank.org/world-development-indicators/) | 1,498 | National statistics with World Bank metadata: long definition, unit, periodicity, source, statistical concept and methodology, limitations, development relevance, aggregation method. CC BY 4.0. No logframe level | WDI topics, e.g. `Health`, `Education`, `Gender`, `Environment` |
| `dhs` | [DHS Program](https://dhsprogram.com) indicators (ICF) | 3,237 | Household-survey indicator definitions: label, definition, denominator, measurement type, topic path and tags (SDGs, MICS, IYCF…). Short records with no methodology text; values by country are in the DHS API. No logframe level | 25 survey topics, e.g. `Water and Sanitation`, `Child Nutrition`, `Malaria` |

Ids are namespaced: `indikit:51-access-to-drinking-water`, `sdg:6.1.1`, `wdi:SH.H2O.SMDW.ZS`, `dhs:WS_SRCE_H_IMP`. A typical use is comparing a project indicator with its SDG counterpart, e.g. `compare_indicators` with `["indikit:51-access-to-drinking-water", "sdg:6.1.1"]`.

## Tools

| Tool | Inputs | Returns |
|---|---|---|
| `search_indicators` | `query`, `source?`, `sector?`, `level?`, `limit` (default 10, max 50) | Compact hits: `id`, `source`, `title`, `sector`, `level`, 200-char `snippet`, plus `matchMode` |
| `get_indicator_details` | `id` | Full record: definition, methodology (Markdown), `url` for citation |
| `list_catalog_metadata` | `source?` | Sources, sectors and levels with counts (valid filter values) |
| `compare_indicators` | `ids` (2–5) | Full records side by side, plus any `missing` ids |

Search details:
- **Query cleaning:** the query is cleaned for FTS5 (special characters and `AND`/`OR`/`NOT`/`NEAR` are removed, and each term becomes a prefix match `"term"*`).
- **Matching:** results must contain *all* terms. If nothing matches, the search falls back to *any* term.
- **Ranking:** BM25, with title matches weighted the highest.
- **Mixed sources:** without a `source` filter, no single source fills more than half of the results, so large sources with many short records (DHS) don't crowd out the others. Results keep their rank order, and if other sources have too few matches the remaining places are filled anyway.
- **Filters only:** an empty `query` lists indicators by filters alone.

## Quick start

Requires [Bun](https://bun.com) ≥ 1.2 (`brew install bun`).

```bash
bun install
bun run ingest             # all sources, ~30–50 min in total
bun run start              # stdio server
```

Ingest options:

```bash
bun run ingest --source sdg                          # one source: dhs ~10 s, sdg ~6 min, indikit ~10–15 min, wdi ~10–30 min
bun run ingest --source indikit --sector wash --limit 15   # quick test run
bun run ingest --source sdg --sector 6               # one SDG goal, by number or name ("water")
bun run ingest --source wdi --sector health --limit 10   # a few WDI indicators from one topic
bun run ingest --source dhs --sector nutrition          # DHS indicators from one survey topic
bun run ingest --fresh                               # drop each source's rows before ingesting it
bun run ingest --help
```

If one repository is unreachable, the others are still ingested and the command exits with an error code.

To see which sources exist and how many indicators of each your local database holds:

```bash
bun run source list
```

## Use it in your MCP client

### Local (stdio)

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) or Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "indicators": {
      "command": "/opt/homebrew/bin/bun",
      "args": ["run", "/ABSOLUTE/PATH/TO/indicators-mcp/src/server.ts"],
      "env": { "INDICATORS_DB": "/ABSOLUTE/PATH/TO/indicators-mcp/indicators.db" }
    }
  }
}
```

Use absolute paths, because GUI apps don't inherit your shell `PATH` (`which bun` shows the path to Bun).

Claude Code:

```bash
claude mcp add indicators -- bun run /ABSOLUTE/PATH/TO/indicators-mcp/src/server.ts
```

### Hosted (HTTP)

The public endpoint is `https://indicators-mcp.gnucoop.workers.dev/mcp`. If you deploy your own copy, use your URL instead.

Claude Desktop, Cursor and other clients that read a JSON config:

```json
{ "mcpServers": { "indicators": { "type": "http", "url": "https://indicators-mcp.gnucoop.workers.dev/mcp" } } }
```

Claude Code:

```bash
claude mcp add --transport http indicators https://indicators-mcp.gnucoop.workers.dev/mcp
```

In Claude.ai or ChatGPT, add a custom connector with the URL `https://indicators-mcp.gnucoop.workers.dev/mcp` (no auth).

## Run as an HTTP server

### Bun, locally

```bash
bun run start:http          # http://localhost:3000/mcp  (GET / for info, GET /health)
bun run scripts/smoke-http.ts http://localhost:3000/mcp
```

| Env var | Default | |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `INDICATORS_DB` | `./indicators.db` | |
| `RATE_LIMIT_PER_HOUR` | `120` | Tool calls per client IP per hour (`0` = off) |
| `RATE_LIMIT_PER_DAY` | `1000` | Tool calls per client IP per day (`0` = off) |
| `PUBLIC_URL` | the request's address | Public base URL shown on the home page and in the MCP server info, e.g. `https://indicators-mcp.gnucoop.workers.dev` |
| `TRUST_PROXY` | off (`1` in Docker) | Read the client IP from `CF-Connecting-IP` / `Fly-Client-IP` / `X-Forwarded-For` |

### Docker (any container host)

The image includes the prebuilt `indicators.db`, so run the ingest first:

```bash
bun run ingest
docker build -t indicators-mcp .
docker run -p 3000:3000 indicators-mcp
```

The image deploys as-is to Fly.io, Render, Railway, Koyeb, Cloud Run or a VPS. To refresh the data, see [Updating the data](#updating-the-data). `TRUST_PROXY=1` is the default in the image because these hosts sit behind a proxy. Set it to `0` if you expose the container directly.

### Cloudflare Workers + D1 (free tier)

The tools are the same, served from Cloudflare's edge with the catalog in [D1](https://developers.cloudflare.com/d1/). The free plan gives 100k requests/day per account, and D1 gives 5 GB of storage and 5M rows read/day. The catalog takes a few MB.

```bash
bunx wrangler login
bunx wrangler d1 create indicators-mcp        # note the database_id it prints
cp wrangler.toml wrangler.local.toml          # paste the database_id into the copy
bun run export:d1                             # indicators.db → dist/d1.sql
bun run d1:import                             # loads dist/d1.sql into your remote D1
bun run deploy:worker                         # → https://indicators-mcp.<you>.workers.dev/mcp
```

`wrangler.toml` is the template kept in git, with a placeholder database id. Your real id goes only in `wrangler.local.toml`, which is gitignored; `d1:import` and `deploy:worker` use it. If you change a setting (rate limit, worker name, routes), change it in both files.

To test locally, load the data with `bunx wrangler d1 execute indicators-mcp --local --file dist/d1.sql`, then run `bun run dev:worker`.

To refresh the data, see [Updating the data](#updating-the-data). The export rebuilds the FTS5 index inside D1, because `wrangler d1 export/import` skips virtual tables.

## Updating the data

This section is for refreshing a database you already have. The first time, just run `bun run ingest` ([Quick start](#quick-start)): it creates `indicators.db` for you.

Servers never crawl on their own; every server reads a prebuilt catalog. To pick up changes in the source repositories (new, edited or removed indicators, a new SDG metadata release), rebuild `indicators.db` locally, then push it to wherever the server runs.

### 1. Rebuild the database

Crawl all sources into a new file, so your current database keeps working if the crawl fails partway:

```bash
bun run ingest --db indicators.new.db
```

A full crawl takes about 30–50 minutes: IndiKit 10–15 minutes and UN SDG about 6 (1 request/second, as IndiKit's robots.txt asks; the same pace is used for UN Stats), and World Bank WDI 10–30 (20 bulk metadata pages, each taking 25–90 seconds on the World Bank's side). Check the summary at the end: `0 failed`, and the same number of rows in the indicators table and the FTS index. Then replace the old file:

```bash
mv indicators.new.db indicators.db
```

Starting from an empty file also drops indicators that a repository has removed. A re-run into the existing `indicators.db` updates and adds records, but keeps removed ones. To remove them in place instead, use `bun run ingest --fresh`; it deletes each source's rows before crawling it, so the database stays incomplete until the crawl finishes.

To refresh one source, add `--source indikit`, `--source sdg`, `--source wdi` or `--source dhs`; the other sources' rows stay as they are. To refresh a single sector, add `--sector wash` (or `--sector 6` for an SDG goal). Sector lists already in the database are merged, not overwritten.

### 2. Push it to each deployment

| Where | What to run |
|---|---|
| Local stdio | Nothing to push. Restart your MCP client (or the server) so it reopens the file. |
| Bun HTTP | Restart `bun run start:http`. |
| Docker | `docker build -t indicators-mcp .`, then redeploy the image to your host. The database is baked into the image. |
| Cloudflare Workers | `bun run export:d1`, then `bun run d1:import`. No redeploy needed: the Worker reads D1 directly. The import drops and reloads the whole catalog, so requests may fail during the few seconds it runs. |

### 3. Check it

```bash
bun run scripts/smoke-stdio.ts                                   # local database
bun run scripts/smoke-http.ts https://<host>/mcp                 # a deployed endpoint
```

Both print the catalog size, so you can confirm the new count went live.

## Limits

| | Default |
|---|---|
| Tool output | 50,000 characters. Long methodology texts are shortened fairly across records and flagged with `_truncated` (the record keeps its `url`) |
| `search_indicators` results | 10 (max 50) |
| `compare_indicators` ids | 2–5 |
| HTTP request body | 256 KiB |
| Docker / Bun HTTP | 120 tool calls/hour and 1,000/day per IP (configurable) |
| Cloudflare Workers | 30 tool calls/minute per IP (`[[ratelimits]]` in `wrangler.toml`), plus the account's free-plan quota |

Only `tools/call` requests count toward the limits; `initialize`, `tools/list` and notifications are free. When a client goes over a limit, it gets HTTP 429 with a `Retry-After` header and a JSON-RPC error. The Bun server's limiter is in memory, which suits a single instance. If you run several replicas, put a shared limiter in front.

## Architecture

```text
src/
├── types.ts              Canonical UnifiedIndicator + result types
├── schema.ts             SQLite/D1 schema: indicators + indicators_fts (FTS5) + sync triggers
├── db.ts                 bun:sqlite: open, upsert (ON CONFLICT DO UPDATE), counts
├── adapters/
│   ├── index.ts          Adapter registry: register new repositories here
│   ├── types.ts          Adapter interface
│   ├── http.ts           Polite fetcher shared by adapters (delay, retries, User-Agent)
│   ├── indikit.ts        indikit.net crawler/parser (fetch + cheerio)
│   ├── sdg.ts            UN SDG API + harmonized metadata documents
│   ├── wdi.ts            World Bank WDI list + bulk series metadata
│   ├── dhs.ts            DHS Program indicator definitions, tags and citation
│   ├── docx.ts           Minimal .docx reader (fflate + cheerio) for SDG metadata
│   └── html-to-md.ts     HTML → Markdown for methodology text
├── ingest.ts             CLI: run adapters → indicators.db
├── source.ts             CLI: list sources and their local indicator counts
├── repo/
│   ├── sql.ts            Backend-agnostic queries, FTS sanitiser, ranking
│   ├── bun-sqlite.ts     Repo over bun:sqlite
│   └── d1.ts             Repo over Cloudflare D1
├── tools.ts              The 4 MCP tools + output cap
├── icons.ts              Server icon: HTTP routes + MCP server-info icons
├── icon-data.ts          Generated: icons from assets/ as base64
├── http.ts               Shared stateless Streamable HTTP handler (Web Request/Response)
├── rate-limit.ts         In-memory per-IP limiter (Bun HTTP)
├── server.ts             stdio entrypoint
├── server-http.ts        Bun.serve entrypoint
└── worker.ts             Cloudflare Workers entrypoint
scripts/
├── export-d1.ts          indicators.db → dist/d1.sql
├── embed-icons.ts        assets/ → src/icon-data.ts
└── smoke-http.ts         End-to-end check of any /mcp endpoint with the official MCP client
```

**Canonical record:** `id` (namespaced, e.g. `indikit:51-access-to-drinking-water`), `source`, `title`, `sector`, `level`, `definition`, `methodology`, `url`. An indicator listed under several sectors, or valid at several levels, stores comma-joined values (`"Output, Outcome"`), and the filters match any of them.

**Adding a repository:** implement `Adapter` in `src/adapters/<name>.ts`. It yields `UnifiedIndicator`s with ids `<source>:<local id>`. Register it in `ADAPTERS` in `src/adapters/index.ts`, then run `bun run ingest --source <name>`.

**Icon:** the server declares the Gnucoop logo symbol (`assets/`) in its MCP server info, so clients that support icons show it instead of a default one. The HTTP servers also serve it at `/favicon.ico`, `/icon.png` (512×512) and `/icon-128.png`; the stdio server sends it inline. To change it, replace the files in `assets/` and run `bun run scripts/embed-icons.ts`.

**stdio safety:** the stdio server writes only JSON-RPC to stdout. All logs go to stderr, and `console.log` is redirected to stderr as a safety net.

## Development

```bash
bun test            # FTS sanitiser, search/filters, upsert idempotency, HTTP transport, rate limits
bun run typecheck
```

## Credits and license

- **IndiKit:** the indicator guidance is © [People in Need](https://www.peopleinneed.net) / IndiKit.
- **UN SDG:** indicator lists and metadata come from the [UN Statistics Division](https://unstats.un.org/sdgs/) (SDG Global Database API and SDG Indicators Metadata Repository); the metadata is written by each indicator's custodian agencies.
- **World Bank WDI:** indicator definitions and metadata from the [World Bank API](https://datahelpdesk.worldbank.org/knowledgebase/topics/125589), licensed [CC BY 4.0](https://datacatalog.worldbank.org/public-licenses#cc-by).
- **DHS Program:** indicator definitions from the DHS Program Indicator Data API. Required citation: _The DHS Program Indicator Data API, The Demographic and Health Surveys (DHS) Program. ICF. Originally funded by the United States Agency for International Development (USAID). Available from api.dhsprogram.com._ Each DHS record carries this citation with its access date.

Every record links back to its source page or metadata document. Please cite it. This server only indexes the content to make it searchable.

**Code:** licensed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) or any later version (AGPL-3.0-or-later); see [LICENSE](LICENSE). If you modify the server and make it available to others, including as a network service, you must share your changes under the same licence.
