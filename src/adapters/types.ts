import type { UnifiedIndicator } from "../types.ts";

export interface FetchOptions {
  /** Stop after this many indicators (for test runs). */
  limit?: number;
  /** Only crawl sectors whose name or slug contains one of these (case-insensitive). */
  sectors?: string[];
  /** Minimum delay between HTTP requests, in ms. */
  delayMs: number;
  /** Progress logger (must write to stderr). */
  log: (message: string) => void;
}

export interface AdapterStats {
  ok: number;
  failed: number;
  total: number;
}

/**
 * A source repository of indicators. To add a new repository (UN SDG, WHO,
 * World Bank, a local CSV...), implement this interface and register it in
 * `src/ingest.ts`. Ids must be namespaced as `<source>:<local id>`.
 */
export interface Adapter {
  readonly source: string;
  readonly description: string;
  fetchAll(opts: FetchOptions): AsyncGenerator<UnifiedIndicator, AdapterStats>;
}
