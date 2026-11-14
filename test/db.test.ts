import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { countRows, initSchema, upsertMany } from "../src/db.ts";
import { bunSqliteRepo } from "../src/repo/bun-sqlite.ts";
import { makeSnippet, sanitizeFtsQuery } from "../src/repo/sql.ts";
import { capRecords } from "../src/tools.ts";
import type { UnifiedIndicator } from "../src/types.ts";

export const FIXTURES: UnifiedIndicator[] = [
  {
    id: "indikit:51-access-to-drinking-water",
    source: "indikit",
    title: "Access to Drinking Water",
    sector: "WASH",
    level: "Output, Outcome",
    definition: "% of the target households using **basic** drinking water services",
    methodology: "## How to Collect\n\nInterview household members responsible for water collection.",
    url: "https://www.indikit.net/indicator/51-access-to-drinking-water",
  },
  {
    id: "indikit:67-hand-washing-knowledge",
    source: "indikit",
    title: "Hand Washing Knowledge",
    sector: "WASH, Nutrition",
    level: "Outcome",
    definition: "% of target population who know at least three critical times for hand washing",
    methodology: "Ask respondents when it is important to wash hands.",
    url: "https://www.indikit.net/indicator/67-hand-washing-knowledge",
  },
  {
    id: "indikit:1-food-consumption-score",
    source: "indikit",
    title: "Food Consumption Score",
    sector: "Food Security",
    level: "Outcome",
    definition: "% of households with acceptable Food Consumption Score",
    methodology: "Seven-day recall of food groups consumed by the household.",
    url: "https://www.indikit.net/indicator/1-food-consumption-score",
  },
  {
    id: "sdg:6.1.1",
    source: "sdg",
    title: "Proportion of population using safely managed drinking water services",
    sector: "WASH",
    level: "Impact",
    definition: "Population using an improved drinking water source located on premises",
    methodology: null,
    url: "https://unstats.un.org/sdgs/metadata/",
  },
];

function freshDb() {
  const db = new Database(":memory:");
  initSchema(db);
  upsertMany(db, FIXTURES);
  return db;
}

describe("sanitizeFtsQuery", () => {
  test("quotes terms and adds prefix matching", () => {
    expect(sanitizeFtsQuery("drinking water")).toBe('"drinking"* "water"*');
    expect(sanitizeFtsQuery("drinking water", "or")).toBe('"drinking"* OR "water"*');
  });
  test("strips FTS syntax and operators", () => {
    expect(sanitizeFtsQuery('water "quality" AND (NOT')).toBe('"water"* "quality"*');
    expect(sanitizeFtsQuery("title:water* NEAR(a b) -x ^y")).toBe('"title"* "water"* "a"* "b"* "x"* "y"*');
  });
  test("keeps unicode letters, returns null for nothing searchable", () => {
    expect(sanitizeFtsQuery("nutrición niños")).toBe('"nutrición"* "niños"*');
    expect(sanitizeFtsQuery("%%% ()")).toBeNull();
    expect(sanitizeFtsQuery("")).toBeNull();
  });
});

describe("repository", () => {
  test("FTS index stays in sync on idempotent upserts", () => {
    const db = freshDb();
    upsertMany(db, FIXTURES); // second run: no duplicates
    expect(countRows(db)).toEqual({ indicators: 4, fts: 4 });
  });

  test("updates are reflected in search", async () => {
    const db = freshDb();
    upsertMany(db, [{ ...FIXTURES[2]!, title: "Food Consumption Score (FCS) zanzibar" }]);
    const repo = bunSqliteRepo(db);
    expect((await repo.search({ query: "zanzibar" })).results.map((r) => r.id)).toEqual(["indikit:1-food-consumption-score"]);
    expect(countRows(db).fts).toBe(4);
  });

  test("search ranks title matches and returns compact hits", async () => {
    const repo = bunSqliteRepo(freshDb());
    const { results, matchMode } = await repo.search({ query: "access drinking water" });
    expect(matchMode).toBe("all_terms");
    expect(results[0]?.id).toBe("indikit:51-access-to-drinking-water");
    expect(Object.keys(results[0]!).sort()).toEqual(["id", "level", "sector", "snippet", "source", "title"]);
    expect(results[0]!.snippet).not.toContain("**");
  });

  test("prefix matching and porter stemming", async () => {
    const repo = bunSqliteRepo(freshDb());
    expect((await repo.search({ query: "wash hand" })).results[0]?.id).toBe("indikit:67-hand-washing-knowledge");
    expect((await repo.search({ query: "consum" })).results[0]?.id).toBe("indikit:1-food-consumption-score");
  });

  test("falls back to any-term matching", async () => {
    const repo = bunSqliteRepo(freshDb());
    const r = await repo.search({ query: "drinking unicorn" });
    expect(r.matchMode).toBe("any_term");
    expect(r.results.length).toBeGreaterThan(0);
  });

  test("filters by source, sector (multi-valued) and level", async () => {
    const repo = bunSqliteRepo(freshDb());
    expect((await repo.search({ query: "water", source: "sdg" })).results.map((r) => r.id)).toEqual(["sdg:6.1.1"]);
    expect((await repo.search({ query: "", sector: "nutrition" })).results.map((r) => r.id)).toEqual([
      "indikit:67-hand-washing-knowledge",
    ]);
    const outcome = await repo.search({ query: "", level: "Outcome" });
    expect(outcome.matchMode).toBe("filters_only");
    expect(outcome.results).toHaveLength(3);
    expect((await repo.search({ query: "water", level: "100%_" })).results).toHaveLength(0);
  });

  test("malicious-looking queries never throw", async () => {
    const repo = bunSqliteRepo(freshDb());
    for (const q of ['"', "*", "AND OR NOT", "a\" OR 1=1 --", "(((", "NEAR(", "'; DROP TABLE indicators; --"]) {
      expect(await repo.search({ query: q })).toBeDefined();
    }
  });

  test("limit is clamped", async () => {
    const repo = bunSqliteRepo(freshDb());
    expect((await repo.search({ query: "", limit: 1 })).results).toHaveLength(1);
    expect((await repo.search({ query: "", limit: 999 })).results).toHaveLength(4);
  });

  test("get / getMany preserve order and skip missing ids", async () => {
    const repo = bunSqliteRepo(freshDb());
    expect((await repo.get("sdg:6.1.1"))?.title).toContain("safely managed");
    expect(await repo.get("nope")).toBeNull();
    const many = await repo.getMany(["sdg:6.1.1", "missing", "indikit:51-access-to-drinking-water"]);
    expect(many.map((r) => r.id)).toEqual(["sdg:6.1.1", "indikit:51-access-to-drinking-water"]);
  });

  test("catalog counts split multi-valued fields", async () => {
    const repo = bunSqliteRepo(freshDb());
    const all = await repo.catalog();
    expect(all.total).toBe(4);
    expect(all.sources).toEqual([
      { name: "indikit", count: 3 },
      { name: "sdg", count: 1 },
    ]);
    expect(all.sectors.find((s) => s.name === "WASH")?.count).toBe(3);
    expect(all.levels.find((l) => l.name === "Outcome")?.count).toBe(3);
    const indikit = await repo.catalog("indikit");
    expect(indikit.total).toBe(3);
  });
});

describe("helpers", () => {
  test("makeSnippet strips markdown and truncates", () => {
    expect(makeSnippet("**Bold** [link](http://x) _em_")).toBe("Bold link em");
    const long = makeSnippet("word ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("…")).toBe(true);
  });

  test("capRecords keeps output under the cap and flags truncation", () => {
    const big = FIXTURES.slice(0, 3).map((r) => ({ ...r, methodology: "x".repeat(30_000) }));
    const capped = capRecords(big, 50_000);
    expect(JSON.stringify(capped, null, 2).length).toBeLessThanOrEqual(50_000);
    expect(capped.every((r) => r._truncated?.includes("methodology"))).toBe(true);
    expect(capRecords(FIXTURES)[0]).not.toHaveProperty("_truncated");
  });
});
