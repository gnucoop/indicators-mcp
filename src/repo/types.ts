import type { CatalogMetadata, IndicatorSummary, SearchParams, UnifiedIndicator } from "../types.ts";

export type MatchMode = "all_terms" | "any_term" | "filters_only";

export interface SearchResult {
  results: IndicatorSummary[];
  /** How the query matched: every term, any term (fallback), or no text query. */
  matchMode: MatchMode;
}

/** Read-only access to the indicator catalog, independent of the SQL backend. */
export interface IndicatorRepo {
  search(params: SearchParams): Promise<SearchResult>;
  get(id: string): Promise<UnifiedIndicator | null>;
  /** Records in the order requested; missing ids are skipped. */
  getMany(ids: string[]): Promise<UnifiedIndicator[]>;
  catalog(source?: string): Promise<CatalogMetadata>;
}

/** Minimal async SQL executor, implemented over bun:sqlite and Cloudflare D1. */
export interface SqlExecutor {
  all<T = Record<string, unknown>>(sql: string, args: unknown[]): Promise<T[]>;
}
