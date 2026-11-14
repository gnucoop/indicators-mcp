#!/usr/bin/env bun
/**
 * Offline ingestion CLI: runs adapters and upserts into indicators.db.
 *
 *   bun run src/ingest.ts [--source all|indikit|sdg|wdi|dhs] [--sector wash] [--limit 20]
 *                         [--delay 1000] [--db ./indicators.db] [--fresh]
 */
import { parseArgs } from "node:util";
import { countRows, defaultDbPath, deleteSource, getSector, openDb, upsertMany } from "./db.ts";
import { ADAPTERS } from "./adapters/index.ts";
import type { Adapter, AdapterStats } from "./adapters/types.ts";
import type { UnifiedIndicator } from "./types.ts";

const log = (m: string) => console.error(m);

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    source: { type: "string", default: "all" },
    sector: { type: "string", multiple: true },
    limit: { type: "string" },
    delay: { type: "string", default: "1000" },
    db: { type: "string" },
    fresh: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  log(`Usage: bun run src/ingest.ts [options]

  --source <name>   Adapter(s) to run: ${Object.keys(ADAPTERS).join(", ")}, a comma-separated
                    list, or "all" (default all)
  --sector <text>   Only sectors whose name/slug contains <text> (repeatable).
                    For sdg: a goal number ("6") or part of its name ("water");
                    for wdi or dhs: part of a topic name ("health", "nutrition")
  --limit <n>       Stop after n indicators per source (test runs)
  --delay <ms>      Delay between HTTP requests (default 1000, per robots.txt)
  --db <path>       Database file (default $INDICATORS_DB or ./indicators.db)
  --fresh           Delete each source's existing records before ingesting it`);
  process.exit(0);
}

const requested = values.source === "all" ? Object.keys(ADAPTERS) : values.source!.split(",").map((s) => s.trim());
const unknown = requested.filter((s) => !ADAPTERS[s]);
if (!requested.length || unknown.length) {
  log(`Unknown source "${unknown.join(", ") || values.source}". Available: ${Object.keys(ADAPTERS).join(", ")}, all`);
  process.exit(2);
}

const limit = values.limit !== undefined ? Number(values.limit) : undefined;
const delayMs = Number(values.delay);
if ((limit !== undefined && !(limit > 0)) || !(delayMs >= 0)) {
  log("--limit must be a positive number and --delay a non-negative number of ms");
  process.exit(2);
}
if (delayMs < 1000 && requested.includes("indikit")) {
  log(`Warning: indikit.net robots.txt asks for a 1000 ms crawl delay; using ${delayMs} ms.`);
}

const dbPath = values.db ?? defaultDbPath();
const db = openDb(dbPath);
const partial = Boolean(values.sector?.length || limit);
const started = performance.now();
const BATCH = 25;
const totals: AdapterStats = { ok: 0, failed: 0, total: 0 };

async function runAdapter(adapter: Adapter): Promise<AdapterStats> {
  log(`\nIngesting "${adapter.source}" — ${adapter.description}${partial ? " (partial run)" : ""}`);
  if (values.fresh) log(`Removed ${deleteSource(db, adapter.source)} existing "${adapter.source}" records.`);

  let batch: UnifiedIndicator[] = [];
  const flush = () => {
    if (batch.length) upsertMany(db, batch);
    batch = [];
  };
  try {
    const gen = adapter.fetchAll({ limit, sectors: values.sector, delayMs, log });
    while (true) {
      const next = await gen.next();
      if (next.done) {
        flush();
        return next.value;
      }
      const record = next.value;
      // On partial runs keep sectors found by earlier runs (an indicator can
      // belong to sectors that were not crawled this time).
      if (partial) {
        const prev = getSector(db, record.id);
        if (prev) {
          const merged = [...new Set([...prev.split(", "), ...(record.sector?.split(", ") ?? [])])];
          record.sector = merged.join(", ");
        }
      }
      batch.push(record);
      if (batch.length >= BATCH) flush();
    }
  } finally {
    flush();
  }
}

let fatal = false;
for (const name of requested) {
  try {
    const s = await runAdapter(ADAPTERS[name]!());
    log(`"${name}": ${s.ok} ok, ${s.failed} failed, ${s.total} attempted.`);
    totals.ok += s.ok;
    totals.failed += s.failed;
    totals.total += s.total;
  } catch (err) {
    // One repository being down must not block the others.
    fatal = true;
    log(`Fatal error in "${name}": ${(err as Error).message}`);
  }
}

const rows = countRows(db);
// Finishing touches. The data is already committed, so a reader holding the
// file (e.g. an MCP client running the stdio server) must not fail the run.
try {
  db.run("INSERT INTO indicators_fts(indicators_fts) VALUES('optimize')");
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  // Leave a self-contained file: read-only opens of a WAL database still need
  // to create -shm/-wal files, which fails in read-only containers.
  db.run("PRAGMA journal_mode = DELETE");
} catch (err) {
  log(
    `\nWarning: could not finalise ${dbPath} (${(err as Error).message}). The data is saved, but another ` +
      "process has the database open (an MCP client running the stdio server?). Close it and run:\n" +
      `  sqlite3 ${dbPath} "PRAGMA journal_mode=DELETE"\n` +
      "before building the Docker image.",
  );
}
db.close();

const secs = ((performance.now() - started) / 1000).toFixed(1);
log(
  `\nDone in ${secs}s: ${totals.ok} ok, ${totals.failed} failed, ${totals.total} attempted.` +
    `\nDatabase now holds ${rows.indicators} indicators (${rows.fts} in the FTS index).`,
);
if (rows.indicators !== rows.fts) log("Warning: FTS index row count differs from indicators table!");
if (fatal) process.exit(1);
