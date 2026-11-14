/**
 * bun:sqlite access for the ingestion side (schema + upserts) and for opening
 * the database read-only from the Bun servers.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SCHEMA_STATEMENTS, UPSERT_SQL } from "./schema.ts";
import type { UnifiedIndicator } from "./types.ts";

/** Default DB location: $INDICATORS_DB, else <project root>/indicators.db. */
export function defaultDbPath(): string {
  return process.env.INDICATORS_DB ?? resolve(import.meta.dir, "..", "indicators.db");
}

export function openDb(path = defaultDbPath(), opts: { readonly?: boolean } = {}): Database {
  if (opts.readonly) {
    if (path !== ":memory:" && !existsSync(path)) {
      throw new Error(`Indicators database not found at ${path}. Run \`bun run ingest\` first.`);
    }
    return new Database(path, { readonly: true });
  }
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  initSchema(db);
  return db;
}

export function initSchema(db: Database): void {
  for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
}

function params(r: UnifiedIndicator) {
  return [r.id, r.source, r.title, r.sector, r.level, r.definition, r.methodology, r.url] as const;
}

export function upsertIndicator(db: Database, record: UnifiedIndicator): void {
  db.prepare(UPSERT_SQL).run(...params(record));
}

export function upsertMany(db: Database, records: UnifiedIndicator[]): void {
  const stmt = db.prepare(UPSERT_SQL);
  db.transaction((rows: UnifiedIndicator[]) => {
    for (const r of rows) stmt.run(...params(r));
  })(records);
}

export function getSector(db: Database, id: string): string | null {
  const row = db.query("SELECT sector FROM indicators WHERE id = ?").get(id) as { sector: string | null } | null;
  return row?.sector ?? null;
}

export function deleteSource(db: Database, source: string): number {
  return db.prepare("DELETE FROM indicators WHERE source = ?").run(source).changes;
}

export function countRows(db: Database): { indicators: number; fts: number } {
  const a = db.query("SELECT count(*) AS n FROM indicators").get() as { n: number };
  const b = db.query("SELECT count(*) AS n FROM indicators_fts").get() as { n: number };
  return { indicators: a.n, fts: b.n };
}
