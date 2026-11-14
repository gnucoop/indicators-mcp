#!/usr/bin/env bun
/**
 * Inspect the indicator sources.
 *
 *   bun run source list [--db ./indicators.db]
 *
 * Lists every registered adapter with its description and how many of its
 * indicators the local database holds.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";
import { ADAPTERS } from "./adapters/index.ts";
import { defaultDbPath } from "./db.ts";

export interface SourceRow {
  source: string;
  /** null when the database is missing or unreadable. */
  count: number | null;
  description: string;
}

/** Registered adapters first (registry order), then any extra sources found in the database. */
export function sourceRows(counts: Map<string, number> | null): SourceRow[] {
  const rows: SourceRow[] = Object.entries(ADAPTERS).map(([source, make]) => ({
    source,
    count: counts ? (counts.get(source) ?? 0) : null,
    description: make().description,
  }));
  for (const [source, count] of counts ?? []) {
    if (!ADAPTERS[source]) rows.push({ source, count, description: "(in the database, but no adapter is registered)" });
  }
  return rows;
}

export function formatSourceTable(rows: SourceRow[]): string {
  const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"));
  const sourceWidth = Math.max("SOURCE".length, ...rows.map((r) => r.source.length));
  const countWidth = Math.max("INDICATORS".length, ...rows.map((r) => fmt(r.count).length));
  const line = (a: string, b: string, c: string) => `${a.padEnd(sourceWidth)}  ${b.padStart(countWidth)}  ${c}`;
  return [line("SOURCE", "INDICATORS", "DESCRIPTION"), ...rows.map((r) => line(r.source, fmt(r.count), r.description))].join("\n");
}

export function readCounts(path: string): Map<string, number> | null {
  if (!existsSync(path)) return null;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query("SELECT source, count(*) AS n FROM indicators GROUP BY source").all() as { source: string; n: number }[];
    return new Map(rows.map((r) => [r.source, r.n]));
  } catch {
    return null; // not created by ingest yet, or locked
  } finally {
    db?.close();
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { db: { type: "string" }, help: { type: "boolean", short: "h", default: false } },
    allowPositionals: true,
  });
  const command = positionals[0] ?? "list";

  if (values.help || command !== "list") {
    console.error(`Usage: bun run source list [--db <path>]

  list   Show every registered source with its description and the number
         of its indicators in the local database.`);
    process.exit(values.help ? 0 : 2);
  }

  const dbPath = values.db ?? defaultDbPath();
  const counts = readCounts(dbPath);
  console.log(formatSourceTable(sourceRows(counts)));
  if (counts) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    console.log(`\n${total.toLocaleString("en-US")} indicators in ${dbPath}`);
  } else {
    console.log(`\nNo readable database at ${dbPath}. Run \`bun run ingest\` to build it.`);
  }
}
