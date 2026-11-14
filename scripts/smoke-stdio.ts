#!/usr/bin/env bun
/**
 * End-to-end check of the stdio server: spawns it, speaks raw JSON-RPC and
 * verifies that every stdout line is valid JSON-RPC (no stray logs).
 *   bun run scripts/smoke-stdio.ts
 */
import { resolve } from "node:path";

const server = resolve(import.meta.dir, "..", "src", "server.ts");
const proc = Bun.spawn(["bun", "run", server], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });

const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_catalog_metadata", arguments: {} } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_indicators", arguments: { query: "hand washing", level: "Outcome", limit: 3 } } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_indicator_details", arguments: { id: "indikit:51-access-to-drinking-water" } } },
  { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "compare_indicators", arguments: { ids: ["indikit:51-access-to-drinking-water", "indikit:52-access-to-drinking-water-at-institutions"] } } },
  { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_indicators", arguments: { query: '"((AND OR NOT*' } } },
];
for (const r of requests) proc.stdin.write(`${JSON.stringify(r)}\n`);
await proc.stdin.flush();

const responses = new Map<number, any>();
const decoder = new TextDecoder();
let buffer = "";
let bad = 0;
const reader = proc.stdout.getReader();
const deadline = Date.now() + 10_000;
while (responses.size < 7 && Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.jsonrpc !== "2.0") throw new Error("not JSON-RPC");
      if (typeof msg.id === "number") responses.set(msg.id, msg);
    } catch {
      bad++;
      console.error("NON-JSON-RPC stdout line:", line.slice(0, 120));
    }
  }
}
proc.kill();

const parse = (id: number) => JSON.parse(responses.get(id)?.result?.content?.[0]?.text ?? "null");
console.log("server:", responses.get(1)?.result?.serverInfo);
console.log("tools:", responses.get(2)?.result?.tools?.map((t: { name: string }) => t.name).join(", "));
const meta = parse(3);
console.log(`catalog: ${meta?.total} indicators, ${meta?.sectors?.length} sectors`);
console.log("search 'hand washing' (Outcome):", parse(4)?.results?.map((r: { title: string }) => r.title));
const d = parse(5);
console.log(`details: ${d?.title} [${d?.level}] ${d?.url}`);
console.log(`compare: ${parse(6)?.count} records`);
console.log(`hostile query handled: ${responses.get(7)?.result ? "yes" : "NO"}`);

const ok = bad === 0 && responses.size === 7 && !responses.get(7)?.error;
console.log(ok ? "OK — stdout carried only JSON-RPC" : `FAILED (bad lines: ${bad}, responses: ${responses.size}/7)`);
process.exit(ok ? 0 : 1);
