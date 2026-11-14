/**
 * HTML home page served at "/" to browsers (API clients keep the JSON).
 * Self-contained: inline CSS, a few lines of inline JS for the copy
 * buttons, no external fonts or scripts. Light and dark themes.
 */
import type { CatalogMetadata } from "./types.ts";
import { PROJECT_URL } from "./icons.ts";
import { SERVER_VERSION } from "./tools.ts";

export const GNUCOOP_URL = "https://www.gnucoop.com/";

/** Display info for known sources; unknown sources still show with their id and count. */
const SOURCE_INFO: Record<string, { name: string; url: string; about: string }> = {
  indikit: {
    name: "IndiKit",
    url: "https://www.indikit.net",
    about: "Project-level indicators for relief and development: wording, survey questions, calculation, disaggregation.",
  },
  sdg: {
    name: "UN SDG global indicators",
    url: "https://unstats.un.org/sdgs/indicators/indicators-list/",
    about: "The SDG global indicator framework with official UN metadata: definition, computation, data sources.",
  },
  wdi: {
    name: "World Bank WDI",
    url: "https://datatopics.worldbank.org/world-development-indicators/",
    about: "World Development Indicators with World Bank metadata: methodology, limitations, relevance. CC BY 4.0.",
  },
  dhs: {
    name: "DHS Program",
    url: "https://dhsprogram.com",
    about: "Demographic and Health Surveys indicator definitions: denominator, measurement, survey topic.",
  },
};

const TOOLS: [string, string][] = [
  ["search_indicators", "Full-text search across all sources, with optional source, sector and level filters."],
  ["get_indicator_details", "The full record of one indicator: definition, methodology, link to the source."],
  ["list_catalog_metadata", "Available sources, sectors and logframe levels, with counts."],
  ["compare_indicators", "Two to five indicators side by side, across repositories."],
];

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** True when the client prefers HTML (browsers, favicon fetchers); curl and API clients get JSON. */
export function wantsHtml(accept: string | null): boolean {
  if (!accept) return false;
  const types = accept.toLowerCase().split(",").map((t) => t.split(";")[0]!.trim());
  const html = types.indexOf("text/html");
  const json = types.indexOf("application/json");
  return html !== -1 && (json === -1 || html < json);
}

export interface HomeOptions {
  origin: string;
  catalog: CatalogMetadata | null;
  /** Human-readable usage limits for this deployment. */
  limits?: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function renderHome({ origin, catalog, limits }: HomeOptions): string {
  const o = escapeHtml(origin);
  const endpoint = `${o}/mcp`;
  const sources = (catalog?.sources ?? [])
    .slice()
    .sort((a, b) => Object.keys(SOURCE_INFO).indexOf(a.name) - Object.keys(SOURCE_INFO).indexOf(b.name));
  const sourceRows = sources
    .map((s) => {
      const info = SOURCE_INFO[s.name];
      const name = info
        ? `<a href="${escapeHtml(info.url)}" rel="noopener">${escapeHtml(info.name)}</a>`
        : escapeHtml(s.name);
      return `<tr><td>${name}<div class="muted">${info ? escapeHtml(info.about) : ""}</div></td><td><code>${escapeHtml(s.name)}</code></td><td class="num">${fmt(s.count)}</td></tr>`;
    })
    .join("\n");
  const total = catalog ? `${fmt(catalog.total)} indicators from ${sources.length} repositories` : "M&E indicators from several repositories";
  const json = JSON.stringify({ mcpServers: { indicators: { type: "http", url: `${origin}/mcp` } } }, null, 2);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Indicators MCP</title>
<meta name="description" content="A free MCP server to search, inspect and compare monitoring &amp; evaluation indicators from IndiKit, UN SDG, World Bank WDI and DHS. By Gnucoop.">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" type="image/png" href="/icon.png" sizes="512x512">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:title" content="Indicators MCP">
<meta property="og:description" content="Search and compare M&amp;E indicators from IndiKit, UN SDG, World Bank WDI and DHS in your AI assistant.">
<meta property="og:image" content="${o}/icon.png">
<style>
:root{--bg:#f7f8fa;--card:#fff;--text:#1f2328;--muted:#5b6470;--line:#e3e6ea;--brand:#2d5381;--brand-ink:#fff;--code:#eef1f5;--dark:#3a3a3a}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1e24;--text:#e6e8eb;--muted:#9aa3ae;--line:#2a3038;--brand:#6c9bd2;--brand-ink:#0d1117;--code:#232932;--dark:#d0d3d7}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--brand)}
main{max-width:860px;margin:0 auto;padding:32px 16px 48px}
header{display:flex;gap:18px;align-items:center;margin-bottom:8px}
header img{width:72px;height:72px;border-radius:16px;flex:none;box-shadow:0 1px 3px rgba(0,0,0,.15)}
h1{font-size:30px;line-height:1.2;margin:0}
.tagline{margin:4px 0 0;color:var(--muted)}
.links{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 26px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--text);text-decoration:none;font-size:14px}
.btn.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:16px 0}
h2{font-size:18px;margin:0 0 12px}
.endpoint{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}
code{background:var(--code);padding:2px 6px;border-radius:6px;word-break:break-all}
.endpoint code{font-size:15px;padding:8px 12px}
pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow-x:auto;margin:6px 0 0;white-space:pre}
button.copy{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.steps{display:grid;gap:14px;grid-template-columns:minmax(0,1fr)}
.steps>div,section{min-width:0}
.steps h3{font-size:15px;margin:0}
.steps p{margin:2px 0 0;color:var(--muted);font-size:14px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 8px;border-top:1px solid var(--line);vertical-align:top}
th{border-top:none;font-size:13px;color:var(--muted);font-weight:600}
td.num,th.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
td code{word-break:normal;white-space:nowrap}
.muted{color:var(--muted);font-size:14px}
ul.tools{list-style:none;margin:0;padding:0;display:grid;gap:10px}
ul.tools li code{font-weight:600}
footer{color:var(--muted);font-size:14px;margin-top:28px;display:grid;gap:6px;grid-template-columns:minmax(0,1fr)}
footer .by{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
footer a,footer code{overflow-wrap:anywhere}
@media (max-width:560px){h1{font-size:24px}header img{width:56px;height:56px}section{padding:16px}}
</style>
</head>
<body>
<main>
<header>
  <img src="/icon-128.png" alt="Gnucoop logo" width="72" height="72">
  <div>
    <h1>Indicators MCP</h1>
    <p class="tagline">Search, inspect and compare monitoring &amp; evaluation indicators in your AI assistant: ${escapeHtml(total)}.</p>
  </div>
</header>
<nav class="links">
  <a class="btn primary" href="${PROJECT_URL}" rel="noopener">Source code on GitHub</a>
  <a class="btn" href="${GNUCOOP_URL}" rel="noopener">Made by Gnucoop</a>
  <a class="btn" href="${PROJECT_URL}#readme" rel="noopener">Documentation</a>
</nav>

<section>
  <h2>MCP endpoint</h2>
  <div class="endpoint"><code id="endpoint">${endpoint}</code><button class="copy" data-copy="endpoint">Copy</button></div>
  <p class="muted">Streamable HTTP, no sign-up, no authentication. Free public endpoint${limits ? `: ${escapeHtml(limits)}` : ""}</p>
</section>

<section>
  <h2>Connect your assistant</h2>
  <div class="steps">
    <div><h3>Claude (claude.ai and Claude Desktop)</h3><p>Settings → Connectors → Add custom connector, then paste the endpoint URL above.</p></div>
    <div><h3>ChatGPT</h3><p>Add a custom connector (developer mode) with the endpoint URL and no authentication.</p></div>
    <div><h3>Claude Code</h3><pre id="cc">claude mcp add --transport http indicators ${endpoint}</pre></div>
    <div><h3>Cursor, Claude Desktop config and other JSON-configured clients</h3><pre id="json">${escapeHtml(json)}</pre></div>
  </div>
</section>

<section>
  <h2>Sources</h2>
  ${
    sourceRows
      ? `<table><thead><tr><th>Repository</th><th>id</th><th class="num">Indicators</th></tr></thead><tbody>
${sourceRows}
</tbody></table>`
      : `<p class="muted">The catalog is not available right now.</p>`
  }
  <p class="muted">Every record links back to its source. Please cite the original repository when you use its guidance.</p>
</section>

<section>
  <h2>Tools</h2>
  <ul class="tools">
${TOOLS.map(([n, d]) => `    <li><code>${n}</code><div class="muted">${escapeHtml(d)}</div></li>`).join("\n")}
  </ul>
</section>

<footer>
  <div class="by">Made by <a href="${GNUCOOP_URL}" rel="noopener">Gnucoop</a> — IT for non profit · <a href="${PROJECT_URL}" rel="noopener">github.com/gnucoop/indicators-mcp</a></div>
  <div>Code licensed under <a href="https://www.gnu.org/licenses/agpl-3.0.html" rel="noopener">AGPL-3.0-or-later</a>. Indicator content © its publishers: IndiKit (People in Need), UN Statistics Division and custodian agencies, World Bank (CC BY 4.0), and The DHS Program Indicator Data API, The Demographic and Health Surveys (DHS) Program, ICF.</div>
  <div>v${SERVER_VERSION} · JSON for API clients at <code>${o}/</code> with <code>Accept: application/json</code></div>
</footer>
</main>
<script>
document.querySelectorAll("button.copy").forEach(function (b) {
  var el = document.getElementById(b.getAttribute("data-copy"));
  function show(text) { b.textContent = text; setTimeout(function () { b.textContent = "Copy"; }, 2000); }
  function fallback() {
    // Select the text; copy it the old way, or leave it selected for Ctrl/Cmd+C.
    var range = document.createRange(); range.selectNodeContents(el);
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
    show(ok ? "Copied" : "Selected — press Ctrl/Cmd+C");
  }
  b.addEventListener("click", function () {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(el.textContent).then(function () { show("Copied"); }, fallback);
    } else {
      fallback();
    }
  });
});
</script>
</body>
</html>`;
}
