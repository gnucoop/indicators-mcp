/**
 * Backend-agnostic query logic (same SQL runs on bun:sqlite and Cloudflare D1).
 */
import type { CatalogMetadata, CountedValue, IndicatorSummary, SearchParams, UnifiedIndicator } from "../types.ts";
import type { IndicatorRepo, MatchMode, SearchResult, SqlExecutor } from "./types.ts";

export const MAX_LIMIT = 50;
const MAX_TERMS = 16;
const SNIPPET_CHARS = 200;
const FTS_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);
/**
 * bm25 column weights: id (unindexed), title, sector, definition, methodology.
 * Sector is kept low: it is mostly a filter, and stemming makes e.g. "washing"
 * match the "WASH" sector name of every WASH indicator.
 */
const BM25_WEIGHTS = "0.0, 10.0, 0.5, 4.0, 1.0";

/**
 * Turn free text into a safe FTS5 expression: keep only letter/number runs,
 * drop upper-case FTS operators, quote every term and add prefix matching.
 *   `water "quality" AND (NOT` → `"water"* "quality"*`
 * Returns null when nothing searchable is left.
 */
export function sanitizeFtsQuery(query: string, mode: "and" | "or" = "and"): string | null {
  const tokens = (query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => !FTS_OPERATORS.has(t))
    .map((t) => t.toLowerCase());
  const unique = [...new Set(tokens)].slice(0, MAX_TERMS);
  if (!unique.length) return null;
  return unique.map((t) => `"${t}"*`).join(mode === "and" ? " " : " OR ");
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Plain-text preview of a Markdown definition. */
export function makeSnippet(markdown: string | null, max = SNIPPET_CHARS): string {
  if (!markdown) return "";
  const text = markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 10;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

interface SummaryRow {
  id: string;
  source: string;
  title: string;
  sector: string | null;
  level: string | null;
  definition: string | null;
}

const COLUMNS = "i.id, i.source, i.title, i.sector, i.level, i.definition, i.methodology, i.url";

/**
 * Without a source filter, no source may fill more than half of the results:
 * large sources with many short, near-identical records (e.g. DHS breakdowns
 * by sex or age) would otherwise crowd out the others. Results stay in rank
 * order, and skipped ones backfill if other sources have too few matches.
 */
export function diversifyBySource<T extends { source: string }>(ranked: T[], limit: number): T[] {
  const cap = Math.max(1, Math.ceil(limit / 2));
  const picked: T[] = [];
  const skipped: T[] = [];
  const perSource = new Map<string, number>();
  for (const r of ranked) {
    if (picked.length >= limit) break;
    const n = perSource.get(r.source) ?? 0;
    if (n < cap) {
      picked.push(r);
      perSource.set(r.source, n + 1);
    } else {
      skipped.push(r);
    }
  }
  if (picked.length < limit) {
    const backfill = new Set(skipped.slice(0, limit - picked.length));
    // Re-merge in original rank order.
    return ranked.filter((r) => picked.includes(r) || backfill.has(r));
  }
  return picked;
}

/** How many ranked candidates to read when diversifying. */
const CANDIDATE_FACTOR = 4;

export function buildSearchSql(
  params: SearchParams,
  fts: string | null,
  rowLimit = clampLimit(params.limit),
): { sql: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (fts) {
    where.push("indicators_fts MATCH ?");
    args.push(fts);
  }
  if (params.source?.trim()) {
    where.push("i.source = ?");
    args.push(params.source.trim().toLowerCase());
  }
  if (params.sector?.trim()) {
    const sector = params.sector.trim();
    // "SDG 1" / "sdg1" must not match SDG 10–17: anchor the number to the
    // start of a sector name (sector values are ", "-joined lists).
    const goal = sector.match(/^sdg\s*(\d{1,2})$/i);
    if (goal) {
      where.push("(i.sector LIKE ? OR i.sector LIKE ? OR i.sector = ?)");
      args.push(`SDG ${goal[1]} %`, `%, SDG ${goal[1]} %`, `SDG ${goal[1]}`);
    } else {
      where.push("i.sector LIKE ? ESCAPE '\\'");
      args.push(likeContains(sector));
    }
  }
  if (params.level?.trim()) {
    where.push("i.level LIKE ? ESCAPE '\\'");
    args.push(likeContains(params.level.trim()));
  }
  const limit = rowLimit;
  const select = "SELECT i.id, i.source, i.title, i.sector, i.level, i.definition";
  const sql = fts
    ? `${select} FROM indicators_fts JOIN indicators i ON i.rowid = indicators_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY bm25(indicators_fts, ${BM25_WEIGHTS}) LIMIT ?`
    : `${select} FROM indicators i ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY i.title COLLATE NOCASE LIMIT ?`;
  args.push(limit);
  return { sql, args };
}

function countValues(values: (string | null)[]): CountedValue[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    for (const part of v.split(",")) {
      const name = part.trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export class SqlIndicatorRepo implements IndicatorRepo {
  private catalogCache = new Map<string, CatalogMetadata>();

  constructor(private db: SqlExecutor) {}

  async search(params: SearchParams): Promise<SearchResult> {
    const limit = clampLimit(params.limit);
    const diversify = !params.source?.trim();
    const run = async (fts: string | null) => {
      const { sql, args } = buildSearchSql(params, fts, diversify ? limit * CANDIDATE_FACTOR : limit);
      const rows = await this.db.all<SummaryRow>(sql, args);
      return (diversify ? diversifyBySource(rows, limit) : rows).map(
        (r): IndicatorSummary => ({
          id: r.id,
          source: r.source,
          title: r.title,
          sector: r.sector,
          level: r.level,
          snippet: makeSnippet(r.definition),
        }),
      );
    };

    const andQuery = sanitizeFtsQuery(params.query, "and");
    if (!andQuery) return { results: await run(null), matchMode: "filters_only" };

    let matchMode: MatchMode = "all_terms";
    let results = await run(andQuery);
    const orQuery = sanitizeFtsQuery(params.query, "or");
    if (results.length === 0 && orQuery && orQuery !== andQuery) {
      results = await run(orQuery);
      matchMode = "any_term";
    }
    return { results, matchMode };
  }

  async get(id: string): Promise<UnifiedIndicator | null> {
    const rows = await this.db.all<UnifiedIndicator>(`SELECT ${COLUMNS} FROM indicators i WHERE i.id = ?`, [id.trim()]);
    return rows[0] ?? null;
  }

  async getMany(ids: string[]): Promise<UnifiedIndicator[]> {
    const wanted = [...new Set(ids.map((i) => i.trim()).filter(Boolean))];
    if (!wanted.length) return [];
    const rows = await this.db.all<UnifiedIndicator>(
      `SELECT ${COLUMNS} FROM indicators i WHERE i.id IN (${wanted.map(() => "?").join(", ")})`,
      wanted,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return wanted.map((id) => byId.get(id)).filter((r): r is UnifiedIndicator => Boolean(r));
  }

  /** The catalog is static between ingests, so results are cached per process. */
  async catalog(source?: string): Promise<CatalogMetadata> {
    const key = source?.trim().toLowerCase() ?? "";
    const cached = this.catalogCache.get(key);
    if (cached) return cached;

    const sourceRows = await this.db.all<{ source: string; n: number }>(
      "SELECT source, count(*) AS n FROM indicators GROUP BY source ORDER BY n DESC",
      [],
    );
    const filtered = key
      ? await this.db.all<{ sector: string | null; level: string | null }>(
          "SELECT sector, level FROM indicators WHERE source = ?",
          [key],
        )
      : await this.db.all<{ sector: string | null; level: string | null }>("SELECT sector, level FROM indicators", []);

    const result: CatalogMetadata = {
      total: filtered.length,
      sources: sourceRows.map((r) => ({ name: r.source, count: Number(r.n) })),
      sectors: countValues(filtered.map((r) => r.sector)),
      levels: countValues(filtered.map((r) => r.level)),
    };
    this.catalogCache.set(key, result);
    return result;
  }
}
