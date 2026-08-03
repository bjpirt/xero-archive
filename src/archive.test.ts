import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setSilent } from "./log";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Archiver, adoptAttachments, type ArchiveOptions } from "./archive";
import { XeroClient } from "./client";
import { Store } from "./store";
import { ALL_ENDPOINTS } from "./endpoints";

setSilent(true); // progress chatter would drown the test report

/**
 * The archiver takes its client, connection source and store factory by injection,
 * so these drive the real orchestration against a scripted Xero and a temp
 * directory. What's asserted is the *sequence* of calls, since phase order is the
 * behaviour that matters on a limited daily quota.
 */
type Call =
  | { kind: "org" }
  | { kind: "list"; entity: string }
  | { kind: "journals" }
  | { kind: "report" }
  | { kind: "attach-list"; entity: string; id: string }
  | { kind: "attach-file"; entity: string; id: string }
  | { kind: "history"; entity: string; id: string };

interface Fixture {
  /** Records returned per entity; anything absent returns an empty list. */
  records?: Record<string, any[]>;
  /** Attachment filenames per document, keyed "Entity/id". */
  attachments?: Record<string, string[]>;
  quotaHeader?: () => string | null;
  status?: (call: Call) => number | undefined;
  headers?: (call: Call) => Record<string, string> | undefined;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "xero-archive-archiver-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function build(fixture: Fixture = {}, options: Partial<ArchiveOptions> = {}) {
  const calls: Call[] = [];

  const classify = (url: URL): Call => {
    const p = url.pathname.replace("/api.xro/2.0", "");
    const parts = p.split("/").filter(Boolean);
    if (p === "/Organisation") return { kind: "org" };
    if (p === "/Journals") return { kind: "journals" };
    if (parts[0] === "Reports") return { kind: "report" };
    if (parts[2] === "Attachments") {
      return parts.length > 3
        ? { kind: "attach-file", entity: parts[0], id: parts[1] }
        : { kind: "attach-list", entity: parts[0], id: parts[1] };
    }
    if (parts[2] === "history") return { kind: "history", entity: parts[0], id: parts[1] };
    return { kind: "list", entity: parts[0] };
  };

  const bodyFor = (call: Call): unknown => {
    switch (call.kind) {
      case "org":
        return { Organisations: [{ Name: "Test Org" }] };
      case "journals":
        return {}; // empty response ends the journal walk
      case "report":
        return { Reports: [{ ReportName: "R" }] };
      case "attach-list":
        return {
          Attachments: (fixture.attachments?.[`${call.entity}/${call.id}`] ?? []).map((f) => ({
            FileName: f,
          })),
        };
      case "history":
        return { HistoryRecords: [] };
      case "list":
        return {
          [call.entity]: fixture.records?.[call.entity] ?? [],
          pagination: { pageCount: 1 },
        };
      default:
        return {};
    }
  };

  const client = new XeroClient({
    getAccessToken: async () => "token",
    sleep: async () => {},
    now: () => Date.UTC(2026, 7, 3),
    async fetch(input: any) {
      const url = new URL(String(input?.url ?? input));
      const call = classify(url);
      calls.push(call);

      const headers = new Headers(fixture.headers?.(call) ?? {});
      const quota = fixture.quotaHeader?.();
      if (quota !== null && quota !== undefined) headers.set("X-DayLimit-Remaining", quota);

      const status = fixture.status?.(call);
      if (status && status >= 400) return new Response("denied", { status, headers });

      if (call.kind === "attach-file") return new Response(Buffer.from("bytes"), { status: 200, headers });
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify(bodyFor(call)), { status: 200, headers });
    },
  });

  const archiver = new Archiver({
    client,
    auth: {
      getConnections: async () => [
        { id: "c1", tenantId: "tenant-1", tenantType: "ORGANISATION", tenantName: "Test Org" },
      ],
    },
    createStore: (tenantId, tenantName) => new Store(tenantId, tenantName, dir),
    options: { includeReports: false, dailyLimitBuffer: 0, ...options },
  });

  return { archiver, calls, client, store: () => new Store("tenant-1", "Test Org", dir) };
}

type Kind = Call["kind"];
const kinds = (calls: Call[]): Kind[] => calls.map((c) => c.kind);
const firstIndexOf = (calls: Call[], kind: Kind) => kinds(calls).indexOf(kind);
const lastIndexOf = (calls: Call[], kind: Kind) => kinds(calls).lastIndexOf(kind);

const INVOICE_WITH_ATTACHMENT = {
  InvoiceID: "inv-1",
  HasAttachments: true,
  UpdatedDateUTC: "2024-01-01T00:00:00.000Z",
};

describe("phase order", () => {
  test("every record list precedes the first attachment call", async () => {
    // The point of phasing: a list costs ~1 call per 1000 records, an attachment
    // costs 1 per document. Interleaving let one entity's attachments exhaust the
    // day's quota before later entities were listed at all.
    const { archiver, calls } = build({
      records: { Invoices: [INVOICE_WITH_ATTACHMENT] },
      attachments: { "Invoices/inv-1": ["a.pdf"] },
    });
    await archiver.run();

    assert.ok(lastIndexOf(calls, "list") < firstIndexOf(calls, "attach-list"));
    assert.equal(
      kinds(calls).filter((k) => k === "list").length,
      ALL_ENDPOINTS.length,
      "every catalogued endpoint should be listed",
    );
  });

  test("journals and reports come before attachments", async () => {
    const { archiver, calls } = build(
      { records: { Invoices: [INVOICE_WITH_ATTACHMENT] }, attachments: { "Invoices/inv-1": ["a.pdf"] } },
      { includeReports: true, reportFromYear: 2026 },
    );
    await archiver.run();
    assert.ok(lastIndexOf(calls, "journals") < firstIndexOf(calls, "attach-list"));
    assert.ok(lastIndexOf(calls, "report") < firstIndexOf(calls, "attach-list"));
  });

  test("attachments come before inline history", async () => {
    const { archiver, calls } = build(
      { records: { Invoices: [INVOICE_WITH_ATTACHMENT] }, attachments: { "Invoices/inv-1": ["a.pdf"] } },
      { includeHistory: true },
    );
    await archiver.run();
    assert.ok(firstIndexOf(calls, "history") > -1, "history should run");
    assert.ok(lastIndexOf(calls, "attach-file") < firstIndexOf(calls, "history"));
  });

  test("history is skipped by default", async () => {
    const { archiver, calls } = build({ records: { Invoices: [INVOICE_WITH_ATTACHMENT] } });
    await archiver.run();
    assert.equal(firstIndexOf(calls, "history"), -1);
  });
});

describe("phase switches", () => {
  test("skipAttachments stops after records, journals and reports", async () => {
    const { archiver, calls } = build(
      { records: { Invoices: [INVOICE_WITH_ATTACHMENT] }, attachments: { "Invoices/inv-1": ["a.pdf"] } },
      { skipAttachments: true },
    );
    await archiver.run();
    assert.ok(firstIndexOf(calls, "list") > -1);
    assert.equal(firstIndexOf(calls, "attach-list"), -1);
  });

  test("attachmentsOnly re-lists nothing but still fetches attachments", async () => {
    const fixture = {
      records: { Invoices: [INVOICE_WITH_ATTACHMENT] },
      attachments: { "Invoices/inv-1": ["a.pdf"] },
    };
    // First run populates records on disk.
    await build(fixture, { skipAttachments: true }).archiver.run();

    const second = build(fixture, { attachmentsOnly: true });
    await second.archiver.run();
    assert.equal(firstIndexOf(second.calls, "list"), -1, "no record lists on an attachments-only run");
    assert.ok(firstIndexOf(second.calls, "attach-list") > -1);
  });
});

describe("attachment de-duplication", () => {
  const fixture = {
    records: { Invoices: [INVOICE_WITH_ATTACHMENT] },
    attachments: { "Invoices/inv-1": ["a.pdf", "b.pdf"] },
  };

  test("a first run lists and downloads, then writes a marker", async () => {
    const { archiver, calls, store } = build(fixture);
    await archiver.run();
    assert.equal(kinds(calls).filter((k) => k === "attach-list").length, 1);
    assert.equal(kinds(calls).filter((k) => k === "attach-file").length, 2);
    assert.ok(store().hasAttachmentIndex("Invoices", "inv-1"));
  });

  test("a second run spends no attachment calls at all", async () => {
    await build(fixture).archiver.run();
    const second = build(fixture);
    await second.archiver.run();
    assert.equal(firstIndexOf(second.calls, "attach-list"), -1);
    assert.equal(firstIndexOf(second.calls, "attach-file"), -1);
  });

  test("refreshAttachments re-lists but re-downloads nothing already on disk", async () => {
    await build(fixture).archiver.run();
    const second = build(fixture, { refreshAttachments: true });
    await second.archiver.run();
    assert.equal(kinds(second.calls).filter((k) => k === "attach-list").length, 1);
    assert.equal(firstIndexOf(second.calls, "attach-file"), -1, "files are already stored");
  });

  test("a changed record is re-listed, since it may have gained attachments", async () => {
    await build(fixture).archiver.run();
    const changed = {
      ...fixture,
      records: { Invoices: [{ ...INVOICE_WITH_ATTACHMENT, UpdatedDateUTC: "2025-06-01T00:00:00.000Z" }] },
    };
    const second = build(changed);
    await second.archiver.run();
    assert.equal(kinds(second.calls).filter((k) => k === "attach-list").length, 1);
  });

  test("no marker is written when a download fails, so the next run retries", async () => {
    const { archiver, store } = build({
      ...fixture,
      status: (call) => (call.kind === "attach-file" ? 500 : undefined),
    });
    await archiver.run();
    assert.equal(store().hasAttachmentIndex("Invoices", "inv-1"), false);
  });
});

describe("resilience", () => {
  test("a 403 on one endpoint doesn't stop the others", async () => {
    const { archiver, calls } = build({
      records: { Invoices: [INVOICE_WITH_ATTACHMENT], Contacts: [{ ContactID: "c1" }] },
      status: (call) => (call.kind === "list" && call.entity === "Contacts" ? 403 : undefined),
    });
    await archiver.run();
    assert.equal(
      kinds(calls).filter((k) => k === "list").length,
      ALL_ENDPOINTS.length,
      "the remaining endpoints should still be listed",
    );
  });

  test("stops cleanly when the daily quota reaches the buffer", async () => {
    let remaining = 60;
    const { archiver, calls } = build(
      {
        records: { Invoices: [INVOICE_WITH_ATTACHMENT] },
        quotaHeader: () => String(remaining--),
      },
      { dailyLimitBuffer: 55 },
    );
    // Must resolve, not reject: progress is on disk and the run reports how to resume.
    await archiver.run();
    assert.ok(calls.length < ALL_ENDPOINTS.length, "should stop well before finishing");
  });

  test("a daily 429 stops the run cleanly instead of throwing", async () => {
    const { archiver, calls } = build({
      records: { Invoices: [INVOICE_WITH_ATTACHMENT] },
      status: (call) => (call.kind === "list" ? 429 : undefined),
      headers: (call) =>
        call.kind === "list" ? { "Retry-After": "26100", "X-Rate-Limit-Problem": "daily" } : undefined,
    });
    await assert.doesNotReject(() => archiver.run());
    // Halts on the first list rather than grinding through every endpoint.
    assert.equal(kinds(calls).filter((k) => k === "list").length, 1);
  });

  test("a limit that never clears gives up rather than retrying forever", async () => {
    // Unlike a daily 429, an unattributed one is retried — but only to a cap.
    const { archiver, calls } = build({
      status: (call) => (call.kind === "org" ? 429 : undefined),
    });
    await assert.rejects(() => archiver.run());
    assert.ok(calls.length <= 6, `expected retries to be capped, saw ${calls.length}`);
  });

  test("no connected organisations is a clear error", async () => {
    const { client } = build();
    const archiver = new Archiver({
      client,
      auth: { getConnections: async () => [] },
      createStore: (id, name) => new Store(id, name, dir),
    });
    await assert.rejects(() => archiver.run(), /No Xero organisations connected/);
  });

  test("non-organisation tenants are ignored", async () => {
    const { client } = build();
    const practiceOnly = new Archiver({
      client,
      auth: {
        getConnections: async () => [
          { id: "c1", tenantId: "t1", tenantType: "PRACTICE", tenantName: "My Practice" },
        ],
      },
      createStore: (id, name) => new Store(id, name, dir),
    });
    await assert.rejects(() => practiceOnly.run(), /No Xero organisations connected/);
  });
});

describe("history backfill", () => {
  test("fetches history for stored documents and skips those already done", async () => {
    const fixture = { records: { Invoices: [{ InvoiceID: "inv-1" }, { InvoiceID: "inv-2" }] } };
    await build(fixture, { skipAttachments: true }).archiver.run();

    const first = build(fixture);
    await first.archiver.backfillHistory();
    assert.equal(kinds(first.calls).filter((k) => k === "history").length, 2);

    const second = build(fixture);
    await second.archiver.backfillHistory();
    assert.equal(firstIndexOf(second.calls, "history"), -1, "markers on disk mean nothing to do");
  });

  test("refresh re-fetches everything", async () => {
    const fixture = { records: { Invoices: [{ InvoiceID: "inv-1" }] } };
    await build(fixture, { skipAttachments: true }).archiver.run();
    await build(fixture).archiver.backfillHistory();

    const refreshed = build(fixture);
    await refreshed.archiver.backfillHistory(true);
    assert.equal(kinds(refreshed.calls).filter((k) => k === "history").length, 1);
  });

  test("a 4xx writes an empty marker so the document isn't retried forever", async () => {
    const fixture = {
      records: { Invoices: [{ InvoiceID: "inv-1" }] },
      status: (call: Call) => (call.kind === "history" ? 404 : undefined),
    };
    await build(fixture, { skipAttachments: true }).archiver.run();
    const run = build(fixture);
    await run.archiver.backfillHistory();
    assert.ok(run.store().hasHistory("Invoices", "inv-1"), "expected an 'attempted' marker");
  });
});

describe("adoptAttachments", () => {
  test("marks stored documents complete, holding back the newest", async () => {
    const store = new Store("tenant-1", "Test Org", dir);
    await store.init();
    for (const id of ["inv-1", "inv-2"]) {
      await store.writeRecord("Invoices", id, {
        InvoiceID: id,
        HasAttachments: true,
        UpdatedDateUTC: "2024-01-01T00:00:00.000Z",
      });
      await store.writeAttachment("Invoices", id, "a.pdf", Buffer.from("x"));
    }

    await adoptAttachments([store]);

    const docs = await store.listAttachmentDocs("Invoices");
    const newest = docs.reduce((m, d) => Math.max(m, d.mtime), 0);
    for (const doc of docs) {
      const marked = store.hasAttachmentIndex("Invoices", doc.docId);
      // The newest document is the one an interrupted run could have left partial.
      assert.equal(marked, doc.mtime !== newest, `unexpected marker state for ${doc.docId}`);
    }
  });

  test("won't mark a document whose record isn't stored", async () => {
    const store = new Store("tenant-1", "Test Org", dir);
    await store.init();
    // Two docs so one isn't held back as "newest"; neither has a record.
    await store.writeAttachment("Invoices", "orphan-1", "a.pdf", Buffer.from("x"));
    await store.writeAttachment("Invoices", "orphan-2", "a.pdf", Buffer.from("x"));

    await adoptAttachments([store]);
    assert.equal(store.hasAttachmentIndex("Invoices", "orphan-1"), false);
    assert.equal(store.hasAttachmentIndex("Invoices", "orphan-2"), false);
  });

  test("is a no-op with no archives", async () => {
    await assert.doesNotReject(() => adoptAttachments([]));
  });
});
