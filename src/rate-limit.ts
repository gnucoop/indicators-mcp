/**
 * In-memory fixed-window rate limiter (per key, several windows at once).
 * Good for a single container; use a shared store if you run many replicas.
 */
import type { LimitDecision } from "./http.ts";

export interface Window {
  name: string;
  /** Window length in seconds. */
  seconds: number;
  /** Max units per window (0 disables the window). */
  max: number;
}

interface Counter {
  start: number;
  used: number;
}

export class MemoryRateLimiter {
  private counters = new Map<string, Counter>();
  private lastSweep = Date.now();

  constructor(
    private windows: Window[],
    private hint = "",
  ) {
    this.windows = windows.filter((w) => w.max > 0);
  }

  get policy(): string {
    return this.windows.map((w) => `${w.max};w=${w.seconds}`).join(", ");
  }

  check(key: string, units = 1, now = Date.now()): LimitDecision {
    this.sweep(now);
    const states = this.windows.map((w) => {
      const id = `${w.name}:${key}`;
      let c = this.counters.get(id);
      if (!c || now - c.start >= w.seconds * 1000) {
        c = { start: now, used: 0 };
        this.counters.set(id, c);
      }
      return { w, c };
    });

    const blocked = states.find(({ w, c }) => c.used + units > w.max);
    if (blocked) {
      const retryAfter = Math.max(1, Math.ceil((blocked.c.start + blocked.w.seconds * 1000 - now) / 1000));
      return {
        allowed: false,
        retryAfter,
        message:
          `Rate limit exceeded: ${blocked.w.max} tool calls per ${blocked.w.name} per client on this free public endpoint. ` +
          `Retry in ${retryAfter}s.${this.hint ? ` ${this.hint}` : ""}`,
        headers: { "RateLimit-Policy": this.policy, "RateLimit-Remaining": "0", "RateLimit-Reset": String(retryAfter) },
      };
    }

    for (const { c } of states) c.used += units;
    const tightest = states.reduce<{ remaining: number; reset: number } | null>((acc, { w, c }) => {
      const remaining = w.max - c.used;
      const reset = Math.ceil((c.start + w.seconds * 1000 - now) / 1000);
      return !acc || remaining < acc.remaining ? { remaining, reset } : acc;
    }, null);
    return {
      allowed: true,
      headers: tightest
        ? {
            "RateLimit-Policy": this.policy,
            "RateLimit-Remaining": String(tightest.remaining),
            "RateLimit-Reset": String(tightest.reset),
          }
        : {},
    };
  }

  /** Drop expired counters at most once a minute to bound memory. */
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const longest = Math.max(...this.windows.map((w) => w.seconds), 0) * 1000;
    for (const [id, c] of this.counters) if (now - c.start >= longest) this.counters.delete(id);
  }
}
