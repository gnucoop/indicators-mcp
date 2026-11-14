/**
 * Database schema shared by the Bun (bun:sqlite) and Cloudflare D1 backends.
 * No runtime imports here so it can be used from any environment.
 *
 * The FTS5 table uses the same rowid as `indicators`, and triggers keep it in
 * sync on every INSERT / UPDATE / DELETE. Upserts use
 * `INSERT ... ON CONFLICT(id) DO UPDATE`, which keeps the rowid and fires the
 * UPDATE trigger (unlike `INSERT OR REPLACE`, whose implicit delete does not
 * fire triggers unless recursive_triggers is on).
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS indicators (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    title       TEXT NOT NULL,
    sector      TEXT,
    level       TEXT,
    definition  TEXT,
    methodology TEXT,
    url         TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_indicators_source ON indicators(source)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS indicators_fts USING fts5(
    id UNINDEXED, title, sector, definition, methodology,
    tokenize = 'porter unicode61 remove_diacritics 2'
  )`,
  `CREATE TRIGGER IF NOT EXISTS indicators_ai AFTER INSERT ON indicators BEGIN
    INSERT INTO indicators_fts(rowid, id, title, sector, definition, methodology)
    VALUES (new.rowid, new.id, new.title, new.sector, new.definition, new.methodology);
  END`,
  `CREATE TRIGGER IF NOT EXISTS indicators_ad AFTER DELETE ON indicators BEGIN
    DELETE FROM indicators_fts WHERE rowid = old.rowid;
  END`,
  `CREATE TRIGGER IF NOT EXISTS indicators_au AFTER UPDATE ON indicators BEGIN
    DELETE FROM indicators_fts WHERE rowid = old.rowid;
    INSERT INTO indicators_fts(rowid, id, title, sector, definition, methodology)
    VALUES (new.rowid, new.id, new.title, new.sector, new.definition, new.methodology);
  END`,
];

export const UPSERT_SQL = `INSERT INTO indicators (id, source, title, sector, level, definition, methodology, url)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  source = excluded.source,
  title = excluded.title,
  sector = excluded.sector,
  level = excluded.level,
  definition = excluded.definition,
  methodology = excluded.methodology,
  url = excluded.url`;
