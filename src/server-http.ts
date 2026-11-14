#!/usr/bin/env bun
/**
 * Public HTTP MCP server on Bun (for Docker / any container host).
 *
 * Env:
 *   PORT                   default 3000
 *   HOST                   default 0.0.0.0
 *   INDICATORS_DB          default ./indicators.db
 *   RATE_LIMIT_PER_HOUR    tool calls per client IP per hour (default 120, 0 = off)
 *   RATE_LIMIT_PER_DAY     tool calls per client IP per day  (default 1000, 0 = off)
 *   TRUST_PROXY            "1" to take the client IP from CF-Connecting-IP /
 *                          Fly-Client-IP / X-Forwarded-For (set it only behind a proxy)
 */
import { defaultDbPath, openDb } from "./db.ts";
import { createHttpHandler } from "./http.ts";
import { MemoryRateLimiter } from "./rate-limit.ts";
import { bunSqliteRepo } from "./repo/bun-sqlite.ts";
import { SERVER_NAME, SERVER_VERSION } from "./tools.ts";

console.log = console.error;

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";
const perHour = Number(process.env.RATE_LIMIT_PER_HOUR ?? 120);
const perDay = Number(process.env.RATE_LIMIT_PER_DAY ?? 1000);
const trustProxy = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";

const dbPath = defaultDbPath();
let db;
try {
  db = openDb(dbPath, { readonly: true });
} catch (err) {
  console.error(`[${SERVER_NAME}] ${(err as Error).message}`);
  process.exit(1);
}

const limiter = new MemoryRateLimiter(
  [
    { name: "hour", seconds: 3600, max: perHour },
    { name: "day", seconds: 86_400, max: perDay },
  ],
  "For unlimited use, run the server locally (bun run start).",
);

const handle = createHttpHandler({
  repo: bunSqliteRepo(db),
  limit: (ip, units) => limiter.check(ip, units),
  about: {
    limits: {
      tool_calls_per_hour_per_ip: perHour || "unlimited",
      tool_calls_per_day_per_ip: perDay || "unlimited",
      note: "initialize / tools/list are not counted",
    },
  },
});

function clientIp(req: Request, server: Bun.Server<undefined>): string {
  if (trustProxy) {
    const h = req.headers;
    const fwd =
      h.get("cf-connecting-ip") ?? h.get("fly-client-ip") ?? h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0];
    if (fwd?.trim()) return fwd.trim();
  }
  return server.requestIP(req)?.address ?? "unknown";
}

const server = Bun.serve({
  port,
  hostname,
  async fetch(req, srv) {
    return handle(req, clientIp(req, srv));
  },
  error(err) {
    console.error(`[${SERVER_NAME}] unhandled:`, err);
    return new Response("Internal server error", { status: 500 });
  },
});

console.error(
  `[${SERVER_NAME} ${SERVER_VERSION}] HTTP server on http://${server.hostname}:${server.port}/mcp ` +
    `(db: ${dbPath}, limits: ${perHour}/h, ${perDay}/day per IP, trust proxy: ${trustProxy})`,
);

const shutdown = () => {
  server.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
