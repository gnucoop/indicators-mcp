#!/usr/bin/env bun
/**
 * Smoke test any deployed HTTP endpoint with the official MCP client:
 *   bun run scripts/smoke-http.ts http://localhost:3000/mcp
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = Bun.argv[2] ?? "http://localhost:3000/mcp";
const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const meta = JSON.parse(text(await client.callTool({ name: "list_catalog_metadata", arguments: {} })));
console.log(`catalog: ${meta.total} indicators, ${meta.sectors.length} sectors, levels:`, meta.levels);

const search = JSON.parse(text(await client.callTool({ name: "search_indicators", arguments: { query: "drinking water", limit: 3 } })));
console.log(`search (${search.matchMode}):`, search.results.map((r: { id: string }) => r.id));

const first = search.results[0]?.id;
if (first) {
  const details = JSON.parse(text(await client.callTool({ name: "get_indicator_details", arguments: { id: first } })));
  console.log(`details: ${details.title} — methodology ${details.methodology?.length ?? 0} chars, ${details.url}`);
}
const ids = search.results.slice(0, 2).map((r: { id: string }) => r.id);
if (ids.length === 2) {
  const cmp = JSON.parse(text(await client.callTool({ name: "compare_indicators", arguments: { ids } })));
  console.log(`compare: ${cmp.count} records`);
}
await client.close();
console.log("OK");
