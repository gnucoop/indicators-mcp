# indicators-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an LLM **search, inspect and compare Monitoring & Evaluation (M&E) indicators**. It starts with [IndiKit](https://www.indikit.net) (about 500 indicators across 25 sectors), and other repositories (UN SDG, WHO, World Bank, Sphere, local CSV/PDF) can be added as adapters.

- **Fast and offline:** SQLite FTS5 full-text search, with no vector database and no live scraping during a conversation.
- **Two ways to use it:** a local **stdio** server, or a public **HTTP** endpoint (Streamable HTTP) on Docker or Cloudflare Workers.
- **Read-only:** ingestion is a separate CLI step.

| | Local (stdio) | Hosted (HTTP) |
|---|---|---|
| **How** | `bun run start` from your MCP client | Point your client at `https://<host>/mcp` |
| **Best for** | Unlimited use, offline | Zero setup, sharing with a team |
| **Limits** | None | Per-IP tool-call quota (see [Limits](#limits)) |

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

```json
{ "mcpServers": { "indicators": { "type": "http", "url": "https://<host>/mcp" } } }
```

```bash
claude mcp add --transport http indicators https://<host>/mcp
```

In Claude.ai or ChatGPT, add a custom connector with the URL `https://<host>/mcp` (no auth).

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

The image deploys as-is to Fly.io, Render, Railway, Koyeb, Cloud Run or a VPS. To update the data, re-run the ingest and rebuild the image. `TRUST_PROXY=1` is the default in the image because these hosts sit behind a proxy. Set it to `0` if you expose the container directly.

### Cloudflare Workers + D1 (free tier)

The tools are the same, served from Cloudflare's edge with the catalog in [D1](https://developers.cloudflare.com/d1/). The free plan gives 100k requests/day per account, and D1 gives 5 GB of storage and 5M rows read/day. The catalog takes a few MB.

```bash
bunx wrangler login
bunx wrangler d1 create indicators-mcp        # copy the database_id into wrangler.toml
bun run export:d1                             # indicators.db → dist/d1.sql
bunx wrangler d1 execute indicators-mcp --remote --file dist/d1.sql
bun run deploy:worker                         # → https://indicators-mcp.<you>.workers.dev/mcp
```

To test locally, load the data with `bunx wrangler d1 execute indicators-mcp --local --file dist/d1.sql`, then run `bun run dev:worker`.

To update the data, run `bun run ingest`, then `bun run export:d1`, then the `d1 execute --remote` command again. The export rebuilds the FTS5 index inside D1, because `wrangler d1 export/import` skips virtual tables.

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
