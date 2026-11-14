#!/usr/bin/env bun
/**
 * Offline ingestion CLI: runs adapters and upserts into indicators.db.
 *
 *   bun run src/ingest.ts [--source indikit] [--sector wash] [--limit 20]
 *                         [--delay 1000] [--db ./indicators.db] [--fresh]
 */
import { parseArgs } from "node:util";
import { countRows, defaultDbPath, deleteSource, getSector, openDb, upsertMany } from "./db.ts";
import { IndiKitAdapter } from "./adapters/indikit.ts";
import type { Adapter, AdapterStats } from "./adapters/types.ts";
import type { UnifiedIndicator } from "./types.ts";

const ADAPTERS: Record<string, () => Adapter> = {
  indikit: () => new IndiKitAdapter(),
};

const log = (m: string) => console.error(m);

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    source: { type: "string", default: "indikit" },
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

  --source <name>   Adapter to run: ${Object.keys(ADAPTERS).join(", ")} (default indikit)
  --sector <text>   Only sectors whose name/slug contains <text> (repeatable)
  --limit <n>       Stop after n indicators (test runs)
  --delay <ms>      Delay between HTTP requests (default 1000, per robots.txt)
  --db <path>       Database file (default $INDICATORS_DB or ./indicators.db)
  --fresh           Delete this source's existing records before ingesting`);
  process.exit(0);
}

const factory = ADAPTERS[values.source!];
if (!factory) {
  log(`Unknown source "${values.source}". Available: ${Object.keys(ADAPTERS).join(", ")}`);
  process.exit(2);
}

const limit = values.limit !== undefined ? Number(values.limit) : undefined;
const delayMs = Number(values.delay);
if ((limit !== undefined && !(limit > 0)) || !(delayMs >= 0)) {
  log("--limit must be a positive number and --delay a non-negative number of ms");
  process.exit(2);
}
if (delayMs < 1000 && values.source === "indikit") {
  log(`Warning: indikit.net robots.txt asks for a 1000 ms crawl delay; using ${delayMs} ms.`);
}

const dbPath = values.db ?? defaultDbPath();
const db = openDb(dbPath);
const adapter = factory();
const partial = Boolean(values.sector?.length || limit);

log(`Ingesting "${adapter.source}" into ${dbPath}${partial ? " (partial run)" : ""}`);
if (values.fresh) log(`Removed ${deleteSource(db, adapter.source)} existing "${adapter.source}" records.`);

const started = performance.now();
const BATCH = 25;
let batch: UnifiedIndicator[] = [];
const flush = () => {
  if (batch.length) upsertMany(db, batch);
  batch = [];
};

let stats: AdapterStats = { ok: 0, failed: 0, total: 0 };
try {
  const gen = adapter.fetchAll({ limit, sectors: values.sector, delayMs, log });
  while (true) {
    const next = await gen.next();
    if (next.done) {
      stats = next.value;
      break;
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
  flush();
} catch (err) {
  flush();
  log(`Fatal: ${(err as Error).message}`);
  db.close();
  process.exit(1);
}

const rows = countRows(db);
db.run("INSERT INTO indicators_fts(indicators_fts) VALUES('optimize')");
db.run("PRAGMA wal_checkpoint(TRUNCATE)");
// Leave a self-contained file: read-only opens of a WAL database still need to
// create -shm/-wal files, which fails in read-only containers.
db.run("PRAGMA journal_mode = DELETE");
db.close();

const secs = ((performance.now() - started) / 1000).toFixed(1);
log(
  `\nDone in ${secs}s: ${stats.ok} ok, ${stats.failed} failed, ${stats.total} attempted.` +
    `\nDatabase now holds ${rows.indicators} indicators (${rows.fts} in the FTS index).`,
);
if (rows.indicators !== rows.fts) log("Warning: FTS index row count differs from indicators table!");
