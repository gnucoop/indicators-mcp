#!/usr/bin/env bun
/**
 * stdio MCP server. stdout carries JSON-RPC only: every log goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultDbPath, openDb } from "./db.ts";
import { bunSqliteRepo } from "./repo/bun-sqlite.ts";
import { inlineIcons } from "./icons.ts";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./tools.ts";

// Safety net: anything that calls console.log must not corrupt the JSON-RPC stream.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const dbPath = defaultDbPath();
let db;
try {
  db = openDb(dbPath, { readonly: true });
} catch (err) {
  console.error(`[${SERVER_NAME}] ${(err as Error).message}`);
  process.exit(1);
}

const server = createServer(bunSqliteRepo(db), { icons: inlineIcons() });
await server.connect(new StdioServerTransport());
console.error(`[${SERVER_NAME} ${SERVER_VERSION}] stdio server ready (db: ${dbPath})`);

const shutdown = async () => {
  await server.close().catch(() => {});
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
