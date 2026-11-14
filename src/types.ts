/**
 * Canonical record every adapter normalises its indicators into.
 * Multi-valued fields (an indicator listed under several sectors, or valid at
 * several logframe levels) are stored comma-joined, e.g. "Output, Outcome".
 */
export interface UnifiedIndicator {
  /** Namespaced id, e.g. `indikit:51-access-to-drinking-water`, `sdg:2.1.2`. */
  id: string;
  /** Repository identifier, e.g. `indikit`. */
  source: string;
  title: string;
  sector: string | null;
  /** Output | Outcome | Impact | Process (comma-joined if several), or null. */
  level: string | null;
  /** Indicator wording / definition / calculation (Markdown). */
  definition: string | null;
  /** Data collection & analysis guidance, disaggregation, caveats (Markdown). */
  methodology: string | null;
  /** Canonical page for citation. */
  url: string | null;
}

/** Compact search hit, kept small to save LLM context. */
export interface IndicatorSummary {
  id: string;
  source: string;
  title: string;
  sector: string | null;
  level: string | null;
  snippet: string;
}

export interface SearchParams {
  query: string;
  source?: string;
  sector?: string;
  level?: string;
  limit?: number;
}

export interface CountedValue {
  name: string;
  count: number;
}

export interface CatalogMetadata {
  total: number;
  sources: CountedValue[];
  sectors: CountedValue[];
  levels: CountedValue[];
}
