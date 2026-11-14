/**
 * Cloudflare Workers entrypoint: the same MCP tools over Streamable HTTP,
 * backed by a D1 copy of indicators.db (see scripts/export-d1.ts).
 *
 * Limits on the free plan: 100k requests/day per account (Workers), plus an
 * optional per-IP rate limit through the RATE_LIMITER binding in wrangler.toml.
 */
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { createHttpHandler, type LimitDecision } from "./http.ts";
import { d1Repo } from "./repo/d1.ts";

export interface Env {
  DB: D1Database;
  /** Optional Workers Rate Limiting binding (per client IP). */
  RATE_LIMITER?: RateLimit;
  /** Shown on GET / so users know the limits, e.g. "30 tool calls/minute per IP". */
  LIMITS_NOTE?: string;
  /** Public base URL advertised on the home page, e.g. "https://indicators-mcp.gnucoop.workers.dev". */
  PUBLIC_URL?: string;
}

// One handler per isolate: keeps the catalog cache warm across requests.
let cached: { db: D1Database; handle: ReturnType<typeof createHttpHandler> } | undefined;

function getHandler(env: Env) {
  if (cached?.db === env.DB) return cached.handle;
  const handle = createHttpHandler({
    repo: d1Repo(env.DB),
    serverOptions: { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    limitsText: "30 tool calls per minute per IP, within a shared daily quota.",
    publicUrl: env.PUBLIC_URL,
    about: {
      limits: env.LIMITS_NOTE ?? "Shared free-tier quota; initialize / tools/list are not counted.",
      unlimited: "Run the server locally (stdio) for unlimited use.",
    },
    limit: env.RATE_LIMITER
      ? async (ip, units): Promise<LimitDecision> => {
          for (let i = 0; i < units; i++) {
            const { success } = await env.RATE_LIMITER!.limit({ key: ip });
            if (!success) {
              return {
                allowed: false,
                retryAfter: 60,
                message:
                  "Rate limit exceeded on this free public endpoint. Retry in a minute, " +
                  "or run the server locally for unlimited use.",
              };
            }
          }
          return { allowed: true };
        }
      : undefined,
  });
  cached = { db: env.DB, handle };
  return handle;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    return getHandler(env)(request, ip);
  },
} satisfies ExportedHandler<Env>;
