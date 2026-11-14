import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_NAMES } from "../src/adapters/index.ts";
import { initSchema, upsertMany } from "../src/db.ts";
import { formatSourceTable, readCounts, sourceRows } from "../src/source.ts";
import { FIXTURES } from "./db.test.ts";

describe("source list", () => {
  test("rows follow the registry and add unregistered sources from the database", () => {
    const rows = sourceRows(new Map([["sdg", 251], ["legacy", 3]]));
    expect(rows.map((r) => r.source)).toEqual([...SOURCE_NAMES, "legacy"]);
    expect(rows.find((r) => r.source === "sdg")?.count).toBe(251);
    expect(rows.find((r) => r.source === "indikit")?.count).toBe(0);
    expect(rows.find((r) => r.source === "legacy")?.description).toContain("no adapter");
  });

  test("missing database shows a dash", () => {
    const table = formatSourceTable(sourceRows(null));
    expect(table.split("\n")[0]).toMatch(/^SOURCE\s+INDICATORS\s+DESCRIPTION$/);
    expect(table).toMatch(/indikit\s+—\s+IndiKit/);
  });

  test("counts are right-aligned and thousands-separated", () => {
    const table = formatSourceTable([
      { source: "wdi", count: 1498, description: "World Bank" },
      { source: "sdg", count: 251, description: "UN" },
    ]);
    const [, wdi, sdg] = table.split("\n");
    expect(wdi).toContain("1,498");
    expect(wdi!.indexOf("World Bank")).toBe(sdg!.indexOf("UN"));
  });

  test("readCounts reads a database file and returns null when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "indicators-source-"));
    try {
      const path = join(dir, "test.db");
      expect(readCounts(path)).toBeNull();
      const db = new Database(path, { create: true });
      initSchema(db);
      upsertMany(db, FIXTURES);
      db.close();
      expect(readCounts(path)).toEqual(new Map([["indikit", 3], ["sdg", 1]]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
