import { XERO } from "./config";
import { log } from "./log";

/**
 * Thrown to unwind cleanly when the daily API quota is spent (or within the
 * configured buffer of it). `resetsAt` is only known when Xero actually returned a
 * 429 with `Retry-After`: the daily window is a fixed window that resets at a
 * tenant-specific time, so it can't be computed.
 * https://developer.xero.com/documentation/guides/oauth2/limits
 */
export class DailyLimitReached extends Error {
  constructor(readonly resetsAt: Date | null = null) {
    super("Daily API limit reached");
    this.name = "DailyLimitReached";
  }
}

export class XeroHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    public url: string,
  ) {
    super(`Xero API ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = "XeroHttpError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The seams this module needs from the outside world. Injecting them keeps the
 * retry, throttling and quota logic testable without a network, a real clock, or
 * any patching of globals — tests pass a fake clock whose `sleep` advances `now`.
 */
export interface HttpDeps {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Supplied by the auth layer; injected so this module doesn't depend on it. */
  getAccessToken: () => Promise<string>;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  accept?: "json" | "binary";
}

export interface XeroResponse {
  status: number;
  json: any; // parsed JSON (null for 304 / binary)
  buffer: Buffer | null; // raw bytes (binary requests)
  headers: Headers;
}

/**
 * Enforces Xero's per-tenant limits: 5 concurrent and 60 calls/minute, via a
 * sliding 60s window plus a concurrency semaphore.
 */
class RateLimiter {
  private static readonly MAX_CONCURRENT = 5;
  private static readonly MAX_PER_MINUTE = 60;
  private static readonly WINDOW_MS = 60_000;

  private active = 0;
  private windowStarts: number[] = [];
  private waiters: Array<() => void> = [];

  constructor(
    private readonly deps: Pick<HttpDeps, "sleep" | "now">,
    private readonly onWait: (waitMs: number) => void,
  ) {}

  private async acquire(): Promise<void> {
    while (this.active >= RateLimiter.MAX_CONCURRENT) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    for (;;) {
      const now = this.deps.now();
      this.windowStarts = this.windowStarts.filter((t) => now - t < RateLimiter.WINDOW_MS);
      if (this.windowStarts.length < RateLimiter.MAX_PER_MINUTE) break;
      const waitMs = RateLimiter.WINDOW_MS - (now - this.windowStarts[0]) + 50;
      this.onWait(waitMs);
      await this.deps.sleep(waitMs);
    }
    this.windowStarts.push(this.deps.now());
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const MAX_ATTEMPTS = 6;

/**
 * Rate-limited, retrying Xero API client. One instance per run: it accumulates the
 * call count and the lowest observed daily-quota figure, which `archive.ts` uses to
 * decide when to stop. Previously these were module-level `let`s, which meant tests
 * (and any second run in one process) shared state.
 */
export class XeroClient {
  private readonly deps: HttpDeps;
  private readonly limiter: RateLimiter;
  private lowestDayLimit = Number.POSITIVE_INFINITY;
  private calls = 0;

  constructor(deps: Partial<HttpDeps> & Pick<HttpDeps, "getAccessToken">) {
    this.deps = {
      fetch: deps.fetch ?? globalThis.fetch,
      sleep: deps.sleep ?? sleep,
      now: deps.now ?? Date.now,
      getAccessToken: deps.getAccessToken,
    };
    this.limiter = new RateLimiter(this.deps, (waitMs) => {
      log.progress(
        `rate limit: pausing ${Math.ceil(waitMs / 1000)}s to stay under 60/min${this.apiUsage()}`,
      );
    });
  }

  /** Requests sent this run, retries included — the run's cost against the daily cap. */
  get callsMade(): number {
    return this.calls;
  }

  /** Lowest `X-DayLimit-Remaining` seen this run (Infinity until Xero reports one). */
  get dayLimitRemaining(): number {
    return this.lowestDayLimit;
  }

  /** ` (123 API calls, 456 left today)` for appending to progress lines. */
  apiUsage(): string {
    const left = Number.isFinite(this.lowestDayLimit) ? `, ${this.lowestDayLimit} left today` : "";
    return ` (${this.calls} API call${this.calls === 1 ? "" : "s"}${left})`;
  }

  /**
   * Core request with rate limiting and 429/5xx retry. `path` is either a full URL
   * or a path relative to the Accounting API base.
   */
  async request(tenantId: string, path: string, opts: RequestOptions = {}): Promise<XeroResponse> {
    const url = new URL(path.startsWith("http") ? path : `${XERO.apiBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    for (let attempt = 1; ; attempt++) {
      const res = await this.limiter.run(async () => {
        this.calls++;
        const token = await this.deps.getAccessToken();
        return this.deps.fetch(url, {
          headers: {
            authorization: `Bearer ${token}`,
            "xero-tenant-id": tenantId,
            accept: opts.accept === "binary" ? "*/*" : "application/json",
          },
        });
      });

      this.recordDayLimit(res.headers);

      if (res.status === 429) {
        // Capped like the 5xx path: waiting out a minute limit is right, but retrying
        // forever would hang the run if a limit never clears.
        if (attempt >= MAX_ATTEMPTS) {
          throw new XeroHttpError(429, await res.text(), url.toString());
        }
        await this.handleRateLimited(res.headers);
        continue;
      }

      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        const backoff = Math.min(2 ** attempt, 30);
        log.warn(`${res.status} from Xero; retry ${attempt}/${MAX_ATTEMPTS} in ${backoff}s`);
        await this.deps.sleep(backoff * 1000);
        continue;
      }

      if (res.status === 304) {
        return { status: 304, json: null, buffer: null, headers: res.headers };
      }
      if (!res.ok) {
        throw new XeroHttpError(res.status, await res.text(), url.toString());
      }
      if (opts.accept === "binary") {
        return {
          status: res.status,
          json: null,
          buffer: Buffer.from(await res.arrayBuffer()),
          headers: res.headers,
        };
      }
      return { status: res.status, json: await res.json(), buffer: null, headers: res.headers };
    }
  }

  /**
   * Iterates a paged Accounting endpoint (pageSize up to 1000), yielding the array
   * under `arrayKey` for each page. Stops on the `pagination.pageCount` Xero
   * reports, falling back to "a short page means the end" when it's absent.
   */
  async *paginate(
    tenantId: string,
    path: string,
    arrayKey: string,
    opts: RequestOptions = {},
  ): AsyncGenerator<any[]> {
    for (let page = 1; ; page++) {
      const res = await this.request(tenantId, path, {
        ...opts,
        query: { ...opts.query, page, pageSize: 1000 },
      });
      if (res.status === 304) return; // defensive; not expected without conditional headers
      const items: any[] = res.json?.[arrayKey] ?? [];
      if (items.length > 0) yield items;

      const pageCount = res.json?.pagination?.pageCount;
      if (typeof pageCount === "number") {
        if (page >= pageCount || pageCount === 0) return;
      } else if (items.length < 1000) {
        return;
      }
    }
  }

  /**
   * Only trust `X-DayLimit-Remaining` when the header is actually present:
   * `Number(null)` is 0 and 0 is finite, so a response omitting it (binary
   * attachment downloads may) would clamp the quota to zero and abort the run as
   * though the daily limit had been hit.
   */
  private recordDayLimit(headers: Headers): void {
    const raw = headers.get("X-DayLimit-Remaining");
    if (raw === null || raw.trim() === "") return;
    const remain = Number(raw);
    if (Number.isFinite(remain)) this.lowestDayLimit = Math.min(this.lowestDayLimit, remain);
  }

  /**
   * A daily `Retry-After` can be many hours, and sleeping it would look like a hang,
   * so stop and let the caller report when to come back. Xero's documented
   * `X-Rate-Limit-Problem` values are "minute", "daily", "concurrent", "appminute" —
   * note "daily" does not contain the substring "day".
   */
  private async handleRateLimited(headers: Headers): Promise<void> {
    const retryAfter = Number(headers.get("Retry-After")) || 60;
    const problem = headers.get("X-Rate-Limit-Problem") ?? "unknown";
    if (/daily/i.test(problem)) {
      throw new DailyLimitReached(new Date(this.deps.now() + retryAfter * 1000));
    }
    log.warn(`429 (${problem} limit). Waiting ${retryAfter}s…`);
    await this.deps.sleep((retryAfter + 1) * 1000);
  }
}
