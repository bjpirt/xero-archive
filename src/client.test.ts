import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setSilent } from "./log";
import { DailyLimitReached, XeroClient, XeroHttpError, type HttpDeps } from "./client";

setSilent(true); // progress chatter would drown the test report

/**
 * A recorded request plus the canned reply for it. `fetch` is injected, so none of
 * this patches globals — and `sleep` advances the fake clock instead of waiting,
 * which makes the rate limiter and the retry backoffs testable in microseconds.
 */
interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  bytes?: Buffer;
}

function harness(replies: Reply[] | ((url: string, n: number) => Reply)) {
  const urls: string[] = [];
  const sleeps: number[] = [];
  let clock = Date.UTC(2026, 7, 3, 12, 0, 0);
  let n = 0;

  const deps: HttpDeps = {
    async fetch(input: any) {
      const url = String(input?.url ?? input);
      urls.push(url);
      const reply = typeof replies === "function" ? replies(url, n) : (replies[n] ?? replies.at(-1)!);
      n++;
      const headers = new Headers(reply.headers ?? {});
      const status = reply.status ?? 200;
      // 204/304 are null-body statuses; the Response constructor rejects a body.
      if (status === 204 || status === 304) return new Response(null, { status, headers });
      if (reply.bytes) return new Response(reply.bytes, { status, headers });
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify(reply.body ?? {}), { status, headers });
    },
    async sleep(ms) {
      sleeps.push(ms);
      clock += ms; // the whole point: time moves without us waiting for it
    },
    now: () => clock,
    getAccessToken: async () => "test-token",
  };

  return { client: new XeroClient(deps), urls, sleeps, advance: (ms: number) => (clock += ms) };
}

const withQuota = (remaining: number, body: unknown = {}): Reply => ({
  body,
  headers: { "X-DayLimit-Remaining": String(remaining) },
});

describe("request", () => {
  test("sends the tenant header and bearer token", async () => {
    const urls: string[] = [];
    let seen: Headers | undefined;
    const client = new XeroClient({
      getAccessToken: async () => "tok-123",
      async fetch(input: any, init: any) {
        urls.push(String(input));
        seen = new Headers(init.headers);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.request("tenant-9", "/Invoices");
    assert.equal(seen?.get("authorization"), "Bearer tok-123");
    assert.equal(seen?.get("xero-tenant-id"), "tenant-9");
    assert.equal(seen?.get("accept"), "application/json");
    assert.match(urls[0], /api\.xero\.com\/api\.xro\/2\.0\/Invoices$/);
  });

  test("asks for any content type on binary requests and returns bytes", async () => {
    const { client } = harness([{ bytes: Buffer.from("pdf-bytes") }]);
    const res = await client.request("t", "/Invoices/i1/Attachments/a.pdf", { accept: "binary" });
    assert.equal(res.buffer?.toString(), "pdf-bytes");
    assert.equal(res.json, null);
  });

  test("appends query parameters, skipping undefined ones", async () => {
    const { client, urls } = harness([{}]);
    await client.request("t", "/Journals", { query: { offset: 120, unused: undefined } });
    assert.match(urls[0], /\?offset=120$/);
  });

  test("throws XeroHttpError on a 4xx, carrying status and body", async () => {
    const { client } = harness([{ status: 403, body: { Message: "no" } }]);
    await assert.rejects(
      () => client.request("t", "/Journals"),
      (e: unknown) => e instanceof XeroHttpError && e.status === 403,
    );
  });

  test("returns 304 without treating it as an error", async () => {
    const { client } = harness([{ status: 304 }]);
    const res = await client.request("t", "/Invoices");
    assert.equal(res.status, 304);
    assert.equal(res.json, null);
  });
});

describe("daily quota tracking", () => {
  test("records the quota Xero reports", async () => {
    const { client } = harness([withQuota(900)]);
    await client.request("t", "/Invoices");
    assert.equal(client.dayLimitRemaining, 900);
  });

  test("keeps the lowest figure seen, not the latest", async () => {
    const { client } = harness([withQuota(900), withQuota(500), withQuota(700)]);
    for (let i = 0; i < 3; i++) await client.request("t", "/Invoices");
    assert.equal(client.dayLimitRemaining, 500);
  });

  test("a response without the header must not zero the quota", async () => {
    // Regression: Number(null) is 0 and 0 is finite, so an absent header used to
    // clamp the quota to zero and abort the run with a bogus "limit reached".
    const { client } = harness([withQuota(900), { bytes: Buffer.from("x") }]);
    await client.request("t", "/Invoices");
    await client.request("t", "/Invoices/i1/Attachments/a.pdf", { accept: "binary" });
    assert.equal(client.dayLimitRemaining, 900);
  });

  test("a blank or non-numeric header is ignored too", async () => {
    const { client } = harness([
      withQuota(900),
      { headers: { "X-DayLimit-Remaining": "  " } },
      { headers: { "X-DayLimit-Remaining": "lots" } },
    ]);
    for (let i = 0; i < 3; i++) await client.request("t", "/Invoices");
    assert.equal(client.dayLimitRemaining, 900);
  });

  test("stays Infinity until Xero reports a figure", async () => {
    const { client } = harness([{}]);
    await client.request("t", "/Invoices");
    assert.equal(client.dayLimitRemaining, Number.POSITIVE_INFINITY);
  });
});

describe("429 handling", () => {
  test("a daily limit throws rather than sleeping for hours", async () => {
    // Xero's documented value is "daily" — which does not contain "day".
    const { client, sleeps } = harness([
      { status: 429, headers: { "Retry-After": "26100", "X-Rate-Limit-Problem": "daily" } },
    ]);
    const err = await client.request("t", "/Invoices").catch((e) => e);
    assert.ok(err instanceof DailyLimitReached, `expected DailyLimitReached, got ${err}`);
    assert.deepEqual(sleeps, [], "must not sleep on a daily limit");
    assert.equal(err.resetsAt?.toISOString(), new Date(Date.UTC(2026, 7, 3, 12) + 26100_000).toISOString());
  });

  test("a minute limit waits and retries", async () => {
    const { client, sleeps } = harness((_url, n) =>
      n === 0
        ? { status: 429, headers: { "Retry-After": "5", "X-Rate-Limit-Problem": "minute" } }
        : { body: { Invoices: [] } },
    );
    const res = await client.request("t", "/Invoices");
    assert.deepEqual(res.json, { Invoices: [] });
    assert.deepEqual(sleeps, [6000], "Retry-After plus a second of slack");
  });

  test("gives up on a limit that never clears, rather than looping forever", async () => {
    const { client, sleeps } = harness([
      { status: 429, headers: { "Retry-After": "1", "X-Rate-Limit-Problem": "minute" } },
    ]);
    await assert.rejects(
      () => client.request("t", "/Invoices"),
      (e: unknown) => e instanceof XeroHttpError && e.status === 429,
    );
    assert.equal(sleeps.length, 5, "one fewer sleep than attempts, then it throws");
  });

  test("both attempts count against the call total", async () => {
    const { client } = harness((_url, n) =>
      n === 0 ? { status: 429, headers: { "Retry-After": "1", "X-Rate-Limit-Problem": "minute" } } : {},
    );
    await client.request("t", "/Invoices");
    assert.equal(client.callsMade, 2);
  });
});

describe("5xx retry", () => {
  test("retries with exponential backoff then succeeds", async () => {
    const { client, sleeps } = harness((_url, n) => (n < 3 ? { status: 503 } : { body: { ok: true } }));
    const res = await client.request("t", "/Invoices");
    assert.deepEqual(res.json, { ok: true });
    assert.deepEqual(sleeps, [2000, 4000, 8000]);
  });

  test("gives up after the attempt limit and surfaces the error", async () => {
    const { client } = harness([{ status: 500 }]);
    await assert.rejects(
      () => client.request("t", "/Invoices"),
      (e: unknown) => e instanceof XeroHttpError && e.status === 500,
    );
  });
});

describe("rate limiting", () => {
  test("pauses once 60 calls have gone out inside a minute", async () => {
    const { client, sleeps } = harness([{}]);
    for (let i = 0; i < 61; i++) await client.request("t", "/Invoices");
    assert.equal(sleeps.length, 1, "expected exactly one pause on the 61st call");
    assert.ok(sleeps[0] > 59_000 && sleeps[0] <= 60_050, `unexpected wait: ${sleeps[0]}`);
    assert.equal(client.callsMade, 61);
  });

  test("no pause when the window has already rolled over", async () => {
    const { client, sleeps, advance } = harness([{}]);
    for (let i = 0; i < 60; i++) await client.request("t", "/Invoices");
    advance(61_000);
    await client.request("t", "/Invoices");
    assert.deepEqual(sleeps, []);
  });
});

describe("paginate", () => {
  test("walks pages up to the reported pageCount", async () => {
    const { client, urls } = harness((_url, n) => ({
      body: { Invoices: [{ id: n + 1 }], pagination: { pageCount: 3 } },
    }));
    const pages = [];
    for await (const page of client.paginate("t", "/Invoices", "Invoices")) pages.push(page);
    assert.equal(pages.length, 3);
    assert.equal(urls.length, 3);
    assert.match(urls[0], /page=1&pageSize=1000/);
    assert.match(urls[2], /page=3&pageSize=1000/);
  });

  test("stops immediately when pageCount is 0", async () => {
    const { client, urls } = harness([{ body: { Invoices: [], pagination: { pageCount: 0 } } }]);
    const pages = [];
    for await (const page of client.paginate("t", "/Invoices", "Invoices")) pages.push(page);
    assert.deepEqual(pages, []);
    assert.equal(urls.length, 1);
  });

  test("without pagination metadata, a short page ends the walk", async () => {
    const { client } = harness([{ body: { Invoices: [{ id: 1 }] } }]);
    const pages = [];
    for await (const page of client.paginate("t", "/Invoices", "Invoices")) pages.push(page);
    assert.equal(pages.length, 1);
  });

  test("does not yield empty pages", async () => {
    const { client } = harness([{ body: { Invoices: [], pagination: { pageCount: 1 } } }]);
    const pages = [];
    for await (const page of client.paginate("t", "/Invoices", "Invoices")) pages.push(page);
    assert.deepEqual(pages, []);
  });
});

describe("apiUsage", () => {
  test("counts calls and singularises correctly", async () => {
    const { client } = harness([{}]);
    assert.equal(client.apiUsage(), " (0 API calls)");
    await client.request("t", "/Invoices");
    assert.equal(client.apiUsage(), " (1 API call)");
  });

  test("includes the remaining quota once known", async () => {
    const { client } = harness([withQuota(42)]);
    await client.request("t", "/Invoices");
    assert.equal(client.apiUsage(), " (1 API call, 42 left today)");
  });
});

describe("instance isolation", () => {
  test("two clients don't share counters", async () => {
    const a = harness([withQuota(10)]);
    const b = harness([withQuota(999)]);
    await a.client.request("t", "/Invoices");
    assert.equal(b.client.callsMade, 0);
    assert.equal(b.client.dayLimitRemaining, Number.POSITIVE_INFINITY);
  });
});
