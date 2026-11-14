/**
 * Shared Streamable HTTP handler (Web-standard Request → Response), used by
 * both the Bun HTTP server and the Cloudflare Worker.
 *
 * Stateless: every POST /mcp gets a fresh McpServer + transport and a JSON
 * (non-SSE) response, so it scales horizontally and fits serverless runtimes.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { IndicatorRepo } from "./repo/types.ts";
import { renderHome, wantsHtml } from "./home.ts";
import { httpIcons, ICON_FILES, PROJECT_URL } from "./icons.ts";
import { createServer, SERVER_NAME, SERVER_VERSION, type CreateServerOptions } from "./tools.ts";

const MAX_BODY_BYTES = 256 * 1024;

export interface LimitDecision {
  allowed: boolean;
  /** Seconds until the client may retry (when blocked). */
  retryAfter?: number;
  message?: string;
  headers?: Record<string, string>;
}

export interface HttpHandlerOptions {
  repo: IndicatorRepo;
  /**
   * Called for each POST /mcp that contains tool calls (initialize,
   * tools/list etc. are free). Return allowed=false to reject with 429.
   */
  limit?: (ip: string, toolCalls: number) => Promise<LimitDecision> | LimitDecision;
  /** Short text shown on GET / (e.g. deployment limits). */
  about?: Record<string, unknown>;
  serverOptions?: CreateServerOptions;
  /** Human-readable usage limits, shown on the HTML home page. */
  limitsText?: string;
  /**
   * Public base URL to advertise (home page, root JSON, icon URLs), e.g.
   * "https://indicators-mcp.gnucoop.workers.dev". Defaults to the request's origin.
   */
  publicUrl?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version, Retry-After, RateLimit-Policy",
  "Access-Control-Max-Age": "86400",
};

function withHeaders(res: Response, extra: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

function rpcError(status: number, code: number, message: string, extra: Record<string, string> = {}): Response {
  return jsonResponse({ jsonrpc: "2.0", error: { code, message }, id: null }, status, extra);
}

function countToolCalls(body: unknown): number {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.filter((m) => m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call").length;
}

/** Normalise a configured public URL to an origin (no trailing slash); undefined if unset or invalid. */
export function publicOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

export function createHttpHandler(opts: HttpHandlerOptions) {
  return async function handle(req: Request, ip = "unknown"): Promise<Response> {
    const url = new URL(req.url);
    const origin = publicOrigin(opts.publicUrl) ?? url.origin;
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (path === "/health") return jsonResponse({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION });

    const iconFile = ICON_FILES[path];
    if (iconFile && (req.method === "GET" || req.method === "HEAD")) {
      return new Response(req.method === "HEAD" ? null : iconFile.body, {
        headers: { "Content-Type": iconFile.contentType, "Cache-Control": "public, max-age=86400", ...CORS_HEADERS },
      });
    }

    if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
      if (wantsHtml(req.headers.get("accept"))) {
        const catalog = await opts.repo.catalog().catch(() => null);
        const html = renderHome({ origin, catalog, limits: opts.limitsText });
        return new Response(req.method === "HEAD" ? null : html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            Vary: "Accept",
            "Content-Security-Policy":
              "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      return jsonResponse({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        description: "MCP server to search, inspect and compare M&E indicators (IndiKit, UN SDG, World Bank WDI, DHS Program, EU CAP).",
        mcp_endpoint: `${origin}/mcp`,
        icon: `${origin}/icon.png`,
        source_code: PROJECT_URL,
        transport: "streamable-http (stateless, JSON responses)",
        tools: ["search_indicators", "get_indicator_details", "list_catalog_metadata", "compare_indicators"],
        home_page: "Open this URL in a browser for setup instructions.",
        ...opts.about,
      }, 200, { Vary: "Accept" });
    }

    if (path !== "/mcp") return jsonResponse({ error: "Not found. The MCP endpoint is /mcp." }, 404);

    // Stateless server: no standalone SSE stream and no sessions to delete.
    if (req.method !== "POST") {
      return rpcError(405, -32000, "Method not allowed. This stateless server only accepts POST /mcp.", {
        Allow: "POST, OPTIONS",
      });
    }

    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) return rpcError(413, -32600, "Request body too large.");

    let body: unknown;
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return rpcError(413, -32600, "Request body too large.");
      body = JSON.parse(text);
    } catch {
      return rpcError(400, -32700, "Parse error: invalid JSON.");
    }

    let limitHeaders: Record<string, string> = {};
    const toolCalls = countToolCalls(body);
    if (opts.limit && toolCalls > 0) {
      const decision = await opts.limit(ip, toolCalls);
      limitHeaders = decision.headers ?? {};
      if (!decision.allowed) {
        return rpcError(429, -32029, decision.message ?? "Rate limit exceeded.", {
          ...limitHeaders,
          ...(decision.retryAfter !== undefined && { "Retry-After": String(decision.retryAfter) }),
        });
      }
    }

    const server = createServer(opts.repo, { icons: httpIcons(origin), ...opts.serverOptions });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(req, { parsedBody: body });
      return withHeaders(res, { ...CORS_HEADERS, ...limitHeaders });
    } catch (err) {
      console.error(`[${SERVER_NAME}] request failed:`, err);
      return rpcError(500, -32603, "Internal server error.");
    } finally {
      // JSON mode: the response is complete once handleRequest resolves.
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  };
}
