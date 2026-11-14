import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, upsertMany } from "../src/db.ts";
import { createHttpHandler } from "../src/http.ts";
import { MemoryRateLimiter } from "../src/rate-limit.ts";
import { bunSqliteRepo } from "../src/repo/bun-sqlite.ts";
import { FIXTURES } from "./db.test.ts";

function makeHandler(maxPerHour = 100) {
  const db = new Database(":memory:");
  initSchema(db);
  upsertMany(db, FIXTURES);
  const limiter = new MemoryRateLimiter([{ name: "hour", seconds: 3600, max: maxPerHour }]);
  return createHttpHandler({ repo: bunSqliteRepo(db), limit: (ip, n) => limiter.check(ip, n) });
}

let nextId = 1;
function rpc(method: string, params: unknown = {}) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

async function call(handle: ReturnType<typeof makeHandler>, name: string, args: unknown, ip = "1.1.1.1") {
  const res = await handle(rpc("tools/call", { name, arguments: args }), ip);
  const body = (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean }; error?: unknown };
  const text = body.result?.content[0]?.text;
  return { res, body, data: text && !body.result?.isError ? JSON.parse(text) : text };
}

describe("HTTP transport", () => {
  test("initialize and tools/list", async () => {
    const handle = makeHandler();
    const init = await handle(
      rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }),
    );
    expect(init.status).toBe(200);
    expect(init.headers.get("access-control-allow-origin")).toBe("*");
    const initBody = (await init.json()) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(initBody.result.serverInfo.name).toBe("indicators-mcp");
    expect(initBody.result.instructions).toContain("search_indicators");

    const list = await handle(rpc("tools/list"));
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools.sort()).toEqual(["compare_indicators", "get_indicator_details", "list_catalog_metadata", "search_indicators"]);
  });

  test("all four tools work over HTTP", async () => {
    const handle = makeHandler();
    const search = await call(handle, "search_indicators", { query: "access drinking water", limit: 2 });
    expect(search.data.results[0].id).toBe("indikit:51-access-to-drinking-water");

    const details = await call(handle, "get_indicator_details", { id: "indikit:51-access-to-drinking-water" });
    expect(details.data.url).toContain("indikit.net");

    const missing = await call(handle, "get_indicator_details", { id: "nope" });
    expect(missing.body.result?.isError).toBe(true);

    const meta = await call(handle, "list_catalog_metadata", {});
    expect(meta.data.total).toBe(4);

    const cmp = await call(handle, "compare_indicators", { ids: ["sdg:6.1.1", "indikit:51-access-to-drinking-water", "x"] });
    expect(cmp.data.count).toBe(2);
    expect(cmp.data.missing).toEqual(["x"]);

    const invalid = await call(handle, "compare_indicators", { ids: ["only-one"] });
    expect(invalid.body.result?.isError).toBe(true);
  });

  test("rate limit counts tool calls per IP only", async () => {
    const handle = makeHandler(2);
    expect((await call(handle, "list_catalog_metadata", {}, "9.9.9.9")).res.status).toBe(200);
    expect((await call(handle, "list_catalog_metadata", {}, "9.9.9.9")).res.status).toBe(200);
    const blocked = await call(handle, "list_catalog_metadata", {}, "9.9.9.9");
    expect(blocked.res.status).toBe(429);
    expect(blocked.res.headers.get("retry-after")).toBeTruthy();
    // tools/list is free, other IPs unaffected
    expect((await handle(rpc("tools/list"), "9.9.9.9")).status).toBe(200);
    expect((await call(handle, "list_catalog_metadata", {}, "8.8.8.8")).res.status).toBe(200);
  });

  test("routing, CORS preflight and errors", async () => {
    const handle = makeHandler();
    expect((await handle(new Request("http://localhost/health"))).status).toBe(200);
    expect((await handle(new Request("http://localhost/mcp", { method: "OPTIONS" }))).status).toBe(204);
    expect((await handle(new Request("http://localhost/mcp"))).status).toBe(405);
    expect((await handle(new Request("http://localhost/nope"))).status).toBe(404);
    const bad = await handle(new Request("http://localhost/mcp", { method: "POST", body: "{not json" }));
    expect(bad.status).toBe(400);
    const root = (await (await handle(new Request("http://localhost/"))).json()) as { mcp_endpoint: string };
    expect(root.mcp_endpoint).toBe("http://localhost/mcp");
  });
});
