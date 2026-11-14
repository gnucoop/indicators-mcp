/**
 * Polite HTTP client shared by adapters: minimum gap between requests,
 * retries with backoff, a descriptive User-Agent, and null on final failure
 * so one bad page never aborts a whole ingest.
 */
export const USER_AGENT =
  "indicators-mcp/0.1 (open-source M&E indicator index for MCP; respects robots.txt crawl-delay)";

export class PoliteFetcher {
  private last = 0;

  constructor(
    private delayMs: number,
    private log: (m: string) => void = console.error,
    private retries = 3,
  ) {}

  async text(url: string, accept = "text/html,application/xhtml+xml"): Promise<string | null> {
    const res = await this.request(url, accept);
    return res ? await res.text() : null;
  }

  async json<T = unknown>(url: string): Promise<T | null> {
    const res = await this.request(url, "application/json");
    if (!res) return null;
    try {
      return (await res.json()) as T;
    } catch (err) {
      this.log(`  ✗ invalid JSON from ${url}: ${(err as Error).message}`);
      return null;
    }
  }

  async bytes(url: string): Promise<Uint8Array | null> {
    const res = await this.request(url, "*/*");
    return res ? new Uint8Array(await res.arrayBuffer()) : null;
  }

  private async request(url: string, accept: string): Promise<Response | null> {
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      const wait = this.last + this.delayMs - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      this.last = Date.now();
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: accept },
          redirect: "follow",
          signal: AbortSignal.timeout(120_000),
        });
        if (res.ok) return res;
        if (res.status === 404 || res.status === 410) {
          this.log(`  ✗ ${res.status} ${url}`);
          return null;
        }
        this.log(`  ! HTTP ${res.status} for ${url} (attempt ${attempt}/${this.retries})`);
      } catch (err) {
        this.log(`  ! ${(err as Error).message} for ${url} (attempt ${attempt}/${this.retries})`);
      }
      await Bun.sleep(this.delayMs * 2 ** attempt);
    }
    this.log(`  ✗ giving up on ${url}`);
    return null;
  }
}
