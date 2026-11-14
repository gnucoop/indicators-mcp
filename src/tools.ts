/**
 * The four MCP tools, registered on any McpServer against any IndicatorRepo
 * (bun:sqlite for stdio/Docker, D1 for Cloudflare Workers).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { IndicatorRepo } from "./repo/types.ts";
import { MAX_LIMIT } from "./repo/sql.ts";
import type { UnifiedIndicator } from "./types.ts";

export const SERVER_NAME = "indicators-mcp";
export const SERVER_VERSION = "0.1.0";

/** Hard cap on characters returned by a single tool call. */
export const MAX_OUTPUT_CHARS = 50_000;

const SERVER_INSTRUCTIONS = `Search, inspect and compare Monitoring & Evaluation (M&E) indicators from curated repositories:
- indikit: IndiKit (indikit.net) — project-level indicators for relief and development, with survey questions and calculation guidance; sectors such as WASH, Food Security, Nutrition.
- sdg: UN SDG global indicator framework — its global indicators (251 entries in the UN Stats API), with official UN metadata (definition, computation, data sources); sectors are goals such as "SDG 6 Clean Water and Sanitation"; no logframe level.
- wdi: World Bank World Development Indicators — national statistics (~1,500) with World Bank metadata (definition, methodology, limitations, development relevance); sectors are WDI topics such as "Health", "Education", "Gender"; no logframe level.
- dhs: DHS Program (Demographic and Health Surveys) — household-survey indicator definitions (~3,200) with denominator, measurement and topic; sectors such as "Water and Sanitation", "Child Nutrition"; no logframe level. Short records: cite the DHS Program as each record says.
Without a source filter, search results mix sources (no source fills more than half the list); pass source to see one repository only.
Comparing a project indicator (IndiKit) with its SDG, WDI or DHS counterpart is a common use of compare_indicators.
Typical flow: list_catalog_metadata to discover valid sources/sectors/levels → search_indicators (short keyword queries work best) → get_indicator_details or compare_indicators for full definitions and data-collection methodology.
Always cite the indicator's url when you use its guidance.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function error(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Keep full records under MAX_OUTPUT_CHARS by shortening the longest text
 * fields (methodology first, then definition), flagging what was cut.
 */
export function capRecords<T extends UnifiedIndicator>(records: T[], maxChars = MAX_OUTPUT_CHARS) {
  const out = records.map((r) => ({ ...r }) as T & { _truncated?: string[] });
  const size = () => JSON.stringify(out, null, 2).length;
  const note = (r: UnifiedIndicator) => `\n\n… [truncated — see the full text at ${r.url ?? "the source"}]`;
  for (const field of ["methodology", "definition"] as const) {
    const over = size() - maxChars;
    if (over <= 0) break;
    // Fair share: find the largest per-record length L such that capping every
    // value at L removes the excess (plus room for JSON escaping and notes).
    const lengths = out.map((r) => r[field]?.length ?? 0);
    const total = lengths.reduce((a, b) => a + b, 0);
    const budget = Math.max(0, total - over - out.length * 200);
    let lo = 0;
    let hi = Math.max(...lengths);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lengths.reduce((a, l) => a + Math.min(l, mid), 0) <= budget) lo = mid;
      else hi = mid - 1;
    }
    const cap = Math.max(300, lo);
    for (const r of out) {
      const value = r[field];
      if (!value || value.length <= cap) continue;
      r[field] = `${value.slice(0, cap).trimEnd()}${note(r)}`;
      r._truncated = [...(r._truncated ?? []), field];
    }
  }
  // Last resort (pathological escaping): hard-trim the largest record.
  while (size() > maxChars) {
    const r = out.reduce((a, b) => ((a.methodology?.length ?? 0) >= (b.methodology?.length ?? 0) ? a : b));
    if (!r.methodology || r.methodology.length < 400) break;
    r.methodology = `${r.methodology.slice(0, Math.floor(r.methodology.length * 0.8))}${note(r)}`;
    if (!r._truncated?.includes("methodology")) r._truncated = [...(r._truncated ?? []), "methodology"];
  }
  return out;
}

export interface CreateServerOptions {
  /** Workers can't use the default (ajv, code-generating) validator. */
  jsonSchemaValidator?: ServerOptions["jsonSchemaValidator"];
}

export function createServer(repo: IndicatorRepo, opts: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: { tools: {} },
      ...(opts.jsonSchemaValidator && { jsonSchemaValidator: opts.jsonSchemaValidator }),
    },
  );
  registerTools(server, repo);
  return server;
}

export function registerTools(server: McpServer, repo: IndicatorRepo): void {
  server.registerTool(
    "search_indicators",
    {
      title: "Search indicators",
      description:
        "Full-text search over indicator titles, sectors, definitions and methodology. Returns compact hits " +
        "(id, source, title, sector, level, 200-char snippet). Use short keyword queries, e.g. \"drinking water access\". " +
        "Filters are optional; use list_catalog_metadata to see valid values. Pass an empty query to list by filters only.",
      inputSchema: {
        query: z.string().max(500).describe("Keywords to search for (prefix-matched; all terms first, then any term)"),
        source: z.string().optional().describe("Repository id: 'indikit', 'sdg', 'wdi' or 'dhs'"),
        sector: z.string().optional().describe("Sector name or part of it, e.g. 'WASH', 'Food Security', or an SDG goal such as 'SDG 6'"),
        level: z.string().optional().describe("Logframe level: Process, Output, Outcome or Impact (IndiKit only; the other sources have none)"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(10).describe(`Max results (1-${MAX_LIMIT}, default 10)`),
      },
      annotations: { title: "Search indicators", ...READ_ONLY },
    },
    async ({ query, source, sector, level, limit }) => {
      const { results, matchMode } = await repo.search({ query, source, sector, level, limit });
      return json({
        count: results.length,
        matchMode,
        ...(results.length === 0 && {
          hint: "No matches. Try fewer or broader keywords, or check filter values with list_catalog_metadata.",
        }),
        results,
      });
    },
  );

  server.registerTool(
    "get_indicator_details",
    {
      title: "Get indicator details",
      description:
        "Full record for one indicator: definition (wording, purpose), methodology (data collection, survey questions, " +
        "calculation, disaggregation, caveats, resources) as Markdown, and the source url for citation.",
      inputSchema: {
        id: z.string().min(1).max(300).describe("Indicator id from search results, e.g. 'indikit:51-access-to-drinking-water'"),
      },
      annotations: { title: "Get indicator details", ...READ_ONLY },
    },
    async ({ id }) => {
      const record = await repo.get(id);
      if (!record) return error(`Indicator "${id}" not found. Use search_indicators to find valid ids.`);
      return json(capRecords([record])[0]);
    },
  );

  server.registerTool(
    "list_catalog_metadata",
    {
      title: "List catalog metadata",
      description:
        "Available sources, sectors and logframe levels with indicator counts, to discover valid filter values for search_indicators.",
      inputSchema: {
        source: z.string().optional().describe("Restrict sector/level counts to one source: 'indikit', 'sdg', 'wdi' or 'dhs'"),
      },
      annotations: { title: "List catalog metadata", ...READ_ONLY },
    },
    async ({ source }) => json(await repo.catalog(source)),
  );

  server.registerTool(
    "compare_indicators",
    {
      title: "Compare indicators",
      description:
        "Full records for 2-5 indicators side by side (possibly from different repositories), to compare wording, " +
        "levels and methodologies. Long methodology texts may be shortened to fit; each record keeps its url.",
      inputSchema: {
        ids: z.array(z.string().min(1).max(300)).min(2).max(5).describe("2 to 5 indicator ids"),
      },
      annotations: { title: "Compare indicators", ...READ_ONLY },
    },
    async ({ ids }) => {
      const records = await repo.getMany(ids);
      const found = new Set(records.map((r) => r.id));
      const missing = ids.map((i) => i.trim()).filter((i) => !found.has(i));
      if (records.length === 0) return error(`None of the ids were found: ${missing.join(", ")}. Use search_indicators first.`);
      return json({
        count: records.length,
        ...(missing.length && { missing }),
        indicators: capRecords(records, MAX_OUTPUT_CHARS - 500),
      });
    },
  );
}
