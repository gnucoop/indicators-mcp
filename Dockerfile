# Public HTTP MCP server (Bun). Build after running `bun run ingest`:
#   docker build -t indicators-mcp .
#   docker run -p 3000:3000 indicators-mcp
FROM oven/bun:1.4-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY src ./src
# The prebuilt, read-only indicator database (run `bun run ingest` first).
COPY --chown=bun:bun indicators.db ./indicators.db

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    INDICATORS_DB=/app/indicators.db \
    RATE_LIMIT_PER_HOUR=120 \
    RATE_LIMIT_PER_DAY=1000 \
    # Container hosts (Fly, Render, Railway, Cloud Run...) sit behind a proxy:
    # take the client IP from its forwarding headers. Set to 0 if you expose
    # the container directly to the internet.
    TRUST_PROXY=1

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/server-http.ts"]
