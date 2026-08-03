import { getAccessToken } from "./auth";
import { XERO } from "./config";
import { log } from "./log";

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

/**
 * Enforces Xero's per-tenant limits: 5 concurrent and 60 calls/minute.
 * A sliding 60s window plus a simple concurrency semaphore.
 */
class RateLimiter {
  private readonly maxConcurrent = 5;
  private readonly maxPerMinute = 60;
  private active = 0;
  private windowStarts: number[] = [];
  private waiters: Array<() => void> = [];

  private async acquire(): Promise<void> {
    // Wait for a concurrency slot.
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    // Respect the per-minute window.
    for (;;) {
      const now = Date.now();
      this.windowStarts = this.windowStarts.filter((t) => now - t < 60_000);
      if (this.windowStarts.length < this.maxPerMinute) break;
      const waitMs = 60_000 - (now - this.windowStarts[0]) + 50;
      log.progress(
        `rate limit: pausing ${Math.ceil(waitMs / 1000)}s to stay under 60/min${apiUsage()}`,
      );
      await sleep(waitMs);
    }
    this.windowStarts.push(Date.now());
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
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

const limiter = new RateLimiter();

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Lowest `X-DayLimit-Remaining` observed this run (Infinity until first call). */
export let dayLimitRemaining = Number.POSITIVE_INFINITY;

/** Requests sent this run, retries included — the run's cost against the daily cap. */
export let callsMade = 0;

/** ` (123 API calls, 456 left today)` for appending to progress lines. */
export function apiUsage(): string {
  const left = Number.isFinite(dayLimitRemaining) ? `, ${dayLimitRemaining} left today` : "";
  return ` (${callsMade} API call${callsMade === 1 ? "" : "s"}${left})`;
}

interface RequestOptions {
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
 * Core request with rate limiting and 429/5xx retry. `path` is either a full
 * URL or a path relative to the Accounting API base.
 */
export async function request(
  tenantId: string,
  path: string,
  opts: RequestOptions = {},
): Promise<XeroResponse> {
  const url = new URL(path.startsWith("http") ? path : `${XERO.apiBase}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const maxAttempts = 6;
  for (let attempt = 1; ; attempt++) {
    const res = await limiter.run(async () => {
      callsMade++;
      const token = await getAccessToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "xero-tenant-id": tenantId,
        accept: opts.accept === "binary" ? "*/*" : "application/json",
      };
      return fetch(url, { headers });
    });

    const remain = Number(res.headers.get("X-DayLimit-Remaining"));
    if (Number.isFinite(remain)) dayLimitRemaining = Math.min(dayLimitRemaining, remain);

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 60;
      const problem = res.headers.get("X-Rate-Limit-Problem") ?? "unknown";
      log.warn(`429 (${problem} limit). Waiting ${retryAfter}s…`);
      await sleep((retryAfter + 1) * 1000);
      continue;
    }

    if (res.status >= 500 && attempt < maxAttempts) {
      const backoff = Math.min(2 ** attempt, 30);
      log.warn(`${res.status} from Xero; retry ${attempt}/${maxAttempts} in ${backoff}s`);
      await sleep(backoff * 1000);
      continue;
    }

    if (res.status === 304) {
      return { status: 304, json: null, buffer: null, headers: res.headers };
    }

    if (!res.ok) {
      throw new XeroHttpError(res.status, await res.text(), url.toString());
    }

    if (opts.accept === "binary") {
      const buffer = Buffer.from(await res.arrayBuffer());
      return { status: res.status, json: null, buffer, headers: res.headers };
    }
    return { status: res.status, json: await res.json(), buffer: null, headers: res.headers };
  }
}

/**
 * Iterates a paged Accounting endpoint (pageSize up to 1000). Yields the array
 * of records held under `arrayKey` (e.g. "Invoices") for each page. Uses the
 * modern `pagination` object to know when to stop.
 */
export async function* paginate(
  tenantId: string,
  path: string,
  arrayKey: string,
  opts: RequestOptions = {},
): AsyncGenerator<any[]> {
  let page = 1;
  for (;;) {
    const res = await request(tenantId, path, {
      ...opts,
      query: { ...opts.query, page, pageSize: 1000 },
    });
    if (res.status === 304) return; // defensive; not expected without conditional headers
    const items: any[] = res.json?.[arrayKey] ?? [];
    if (items.length > 0) yield items;

    const pagination = res.json?.pagination;
    if (pagination && typeof pagination.pageCount === "number") {
      if (page >= pagination.pageCount || pagination.pageCount === 0) return;
    } else if (items.length < 1000) {
      return; // fallback when no pagination object present
    }
    page++;
  }
}
