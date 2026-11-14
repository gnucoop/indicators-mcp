import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, upsertMany } from "../src/db.ts";
import { escapeHtml, GNUCOOP_URL, renderHome, wantsHtml } from "../src/home.ts";
import { createHttpHandler } from "../src/http.ts";
import { PROJECT_URL } from "../src/icons.ts";
import { bunSqliteRepo } from "../src/repo/bun-sqlite.ts";
import { FIXTURES } from "./db.test.ts";

function handler() {
  const db = new Database(":memory:");
  initSchema(db);
  upsertMany(db, FIXTURES);
  return createHttpHandler({ repo: bunSqliteRepo(db), limitsText: "30 tool calls per minute per IP." });
}

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

describe("content negotiation", () => {
  test("browsers get HTML; curl, API clients and missing Accept get JSON", () => {
    expect(wantsHtml(BROWSER_ACCEPT)).toBe(true);
    expect(wantsHtml("*/*")).toBe(false);
    expect(wantsHtml(null)).toBe(false);
    expect(wantsHtml("application/json")).toBe(false);
    expect(wantsHtml("application/json, text/html")).toBe(false);
    expect(wantsHtml("text/html, application/json")).toBe(true);
  });
});

describe("home page", () => {
  test("served to browsers with icons, links, live counts and security headers", async () => {
    const res = await handler()(new Request("https://example.org/", { headers: { Accept: BROWSER_ACCEPT } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("vary")).toBe("Accept");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('<link rel="icon" href="/favicon.ico"');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    expect(html).toContain("https://example.org/mcp");
    expect(html).toContain(`href="${GNUCOOP_URL}"`);
    expect(html).toContain(`href="${PROJECT_URL}"`);
    expect(html).toContain("4 indicators from 2 repositories");
    expect(html).toContain("30 tool calls per minute per IP.");
    expect(html).toMatch(/IndiKit<\/a>.*?<code>indikit<\/code><\/td><td class="num">3<\/td>/s);
  });

  test("API clients still get JSON at /", async () => {
    const res = await handler()(new Request("https://example.org/", { headers: { Accept: "*/*" } }));
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("vary")).toBe("Accept");
    expect(((await res.json()) as { mcp_endpoint: string }).mcp_endpoint).toBe("https://example.org/mcp");
  });

  test("apple-touch-icon is served", async () => {
    const res = await handler()(new Request("https://example.org/apple-touch-icon.png"));
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  test("dynamic values are escaped", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const html = renderHome({ origin: 'https://evil.example/"><script>alert(1)</script>', catalog: null });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("The catalog is not available right now.");
  });
});

describe("public URL", () => {
  test("publicOrigin normalises valid http(s) URLs and ignores anything else", async () => {
    const { publicOrigin } = await import("../src/http.ts");
    expect(publicOrigin("https://indicators-mcp.gnucoop.workers.dev/")).toBe("https://indicators-mcp.gnucoop.workers.dev");
    expect(publicOrigin(" https://example.org/mcp ")).toBe("https://example.org");
    expect(publicOrigin(undefined)).toBeUndefined();
    expect(publicOrigin("")).toBeUndefined();
    expect(publicOrigin("not a url")).toBeUndefined();
    expect(publicOrigin("javascript:alert(1)")).toBeUndefined();
  });

  test("the configured public URL replaces the request origin everywhere", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    upsertMany(db, FIXTURES);
    const handle = createHttpHandler({ repo: bunSqliteRepo(db), publicUrl: "https://indicators-mcp.gnucoop.workers.dev" });
    const html = await (await handle(new Request("http://localhost:3002/", { headers: { Accept: BROWSER_ACCEPT } }))).text();
    expect(html).toContain("https://indicators-mcp.gnucoop.workers.dev/mcp");
    expect(html).not.toContain("localhost");
    const json = (await (await handle(new Request("http://localhost:3002/"))).json()) as { mcp_endpoint: string; icon: string };
    expect(json.mcp_endpoint).toBe("https://indicators-mcp.gnucoop.workers.dev/mcp");
    expect(json.icon).toBe("https://indicators-mcp.gnucoop.workers.dev/icon.png");
    const init = await handle(
      new Request("http://localhost:3002/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
      }),
    );
    const icons = ((await init.json()) as { result: { serverInfo: { icons: { src: string }[] } } }).result.serverInfo.icons;
    expect(icons[0]!.src).toBe("https://indicators-mcp.gnucoop.workers.dev/icon.png");
  });
});
