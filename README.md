# indicators-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an LLM **search, inspect and compare Monitoring & Evaluation (M&E) indicators**. It starts with [IndiKit](https://www.indikit.net) (about 500 indicators across 25 sectors), and other repositories (UN SDG, WHO, World Bank, Sphere, local CSV/PDF) can be added as adapters.

- **Fast and offline:** SQLite FTS5 full-text search, with no vector database and no live scraping during a conversation.
- **Two ways to use it:** a local **stdio** server, or a public **HTTP** endpoint (Streamable HTTP) on Docker or Cloudflare Workers.
- **Read-only:** ingestion is a separate CLI step.

| | Local (stdio) | Hosted (HTTP) |
|---|---|---|
| **How** | `bun run start` from your MCP client | Point your client at the hosted endpoint below |
| **Best for** | Unlimited use, offline | Zero setup, sharing with a team |
| **Limits** | None | 30 tool calls per minute per IP (see [Limits](#limits)) |

**Hosted endpoint:** `https://indicators-mcp.gnucoop.workers.dev/mcp` (free, no sign-up, running on Cloudflare Workers)

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
- **Filters only:** an empty `query` lists indicators by filters alone.

## Quick start

Requires [Bun](https://bun.com) ≥ 1.2 (`brew install bun`).

```bash
bun install
bun run ingest             # full IndiKit crawl, ~10–15 min (1 request/second, per robots.txt)
bun run start              # stdio server
```

Ingest options:

```bash
bun run ingest --sector wash --limit 15     # quick test run
bun run ingest --fresh                      # drop this source's rows first
bun run ingest --help
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

Servers never crawl on their own; every server reads a prebuilt catalog. To pick up changes on IndiKit (new, edited or removed indicators), rebuild `indicators.db` locally, then push it to wherever the server runs.

### 1. Rebuild the database

Crawl into a new file, so your current database keeps working if the crawl fails partway:

```bash
bun run ingest --db indicators.new.db
```

A full crawl takes about 10–15 minutes (1 request/second, as IndiKit's robots.txt asks). Check the summary at the end: `0 failed`, and the same number of rows in the indicators table and the FTS index. Then replace the old file:

```bash
mv indicators.new.db indicators.db
```

Starting from an empty file also drops indicators that IndiKit has removed. A re-run into the existing `indicators.db` updates and adds records, but keeps removed ones. To remove them in place instead, use `bun run ingest --fresh`; it deletes IndiKit's rows before crawling, so the database stays incomplete until the crawl finishes.

To refresh a single sector, run `bun run ingest --sector wash`. Sector lists already in the database are merged, not overwritten.

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
│   ├── types.ts          Adapter interface: add new repositories here
│   ├── indikit.ts        indikit.net crawler/parser (fetch + cheerio)
│   └── html-to-md.ts     HTML → Markdown for methodology text
├── ingest.ts             CLI: run adapters → indicators.db
├── repo/
│   ├── sql.ts            Backend-agnostic queries, FTS sanitiser, ranking
│   ├── bun-sqlite.ts     Repo over bun:sqlite
│   └── d1.ts             Repo over Cloudflare D1
├── tools.ts              The 4 MCP tools + output cap
├── http.ts               Shared stateless Streamable HTTP handler (Web Request/Response)
├── rate-limit.ts         In-memory per-IP limiter (Bun HTTP)
├── server.ts             stdio entrypoint
├── server-http.ts        Bun.serve entrypoint
└── worker.ts             Cloudflare Workers entrypoint
scripts/
├── export-d1.ts          indicators.db → dist/d1.sql
└── smoke-http.ts         End-to-end check of any /mcp endpoint with the official MCP client
```

**Canonical record:** `id` (namespaced, e.g. `indikit:51-access-to-drinking-water`), `source`, `title`, `sector`, `level`, `definition`, `methodology`, `url`. An indicator listed under several sectors, or valid at several levels, stores comma-joined values (`"Output, Outcome"`), and the filters match any of them.

**Adding a repository:** implement `Adapter` in `src/adapters/<name>.ts`. It yields `UnifiedIndicator`s with ids `<source>:<local id>`. Register it in `ADAPTERS` in `src/ingest.ts`, then run `bun run ingest --source <name>`.

**stdio safety:** the stdio server writes only JSON-RPC to stdout. All logs go to stderr, and `console.log` is redirected to stderr as a safety net.

## Development

```bash
bun test            # FTS sanitiser, search/filters, upsert idempotency, HTTP transport, rate limits
bun run typecheck
```

## Credits and license

The indicator guidance is © [People in Need](https://www.peopleinneed.net) / IndiKit, and every record links back to its source page. Please cite it. This server only indexes the content to make it searchable. Code: MIT.
