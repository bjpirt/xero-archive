import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setSilent } from "./log";
import { archiveReports, earliestYear, periodsFor } from "./reports";
import { XeroClient } from "./client";
import { Store } from "./store";

setSilent(true);

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "xero-archive-reports-"));
  store = new Store("tenant-1", "Test Org", dir);
  await store.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Scripts the report endpoints, optionally refusing particular report kinds. */
function reportClient(forbidden: string[] = []) {
  const requested: string[] = [];
  const client = new XeroClient({
    getAccessToken: async () => "token",
    sleep: async () => {},
    async fetch(input: any) {
      const url = new URL(String(input?.url ?? input));
      const kind = url.pathname.split("/").pop()!;
      requested.push(kind);
      if (forbidden.includes(kind)) return new Response("denied", { status: 403 });
      return new Response(JSON.stringify({ Reports: [{ ReportName: kind }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, requested };
}

describe("periodsFor", () => {
  const thisYear = new Date().getUTCFullYear();

  test("one period per year, ending on 31 December", () => {
    const periods = periodsFor(thisYear - 1, "year");
    assert.equal(periods.length, 2);
    assert.deepEqual(periods[0], {
      label: String(thisYear - 1),
      fromDate: `${thisYear - 1}-01-01`,
      toDate: `${thisYear - 1}-12-31`,
      asAt: `${thisYear - 1}-12-31`,
    });
  });

  test("month periods end on the real last day, including February", () => {
    const periods = periodsFor(2024, "month"); // 2024 is a leap year
    const byLabel = new Map(periods.map((p) => [p.label, p]));
    assert.equal(byLabel.get("2024-02")?.toDate, "2024-02-29");
    assert.equal(byLabel.get("2023-02"), undefined);
    assert.equal(byLabel.get("2024-04")?.toDate, "2024-04-30");
    assert.equal(byLabel.get("2024-12")?.toDate, "2024-12-31");
  });

  test("non-leap February ends on the 28th", () => {
    assert.equal(periodsFor(2023, "month").find((p) => p.label === "2023-02")?.toDate, "2023-02-28");
  });

  test("stops at the current month rather than running into the future", () => {
    const periods = periodsFor(thisYear, "month");
    assert.equal(periods.length, new Date().getUTCMonth() + 1);
  });

  test("labels are zero-padded so they sort lexicographically", () => {
    const labels = periodsFor(2023, "month")
      .filter((p) => p.label.startsWith("2023"))
      .map((p) => p.label);
    assert.deepEqual(labels.slice(0, 3), ["2023-01", "2023-02", "2023-03"]);
    assert.deepEqual([...labels].sort(), labels, "expected already-sorted labels");
  });

  test("a future start year produces nothing", () => {
    assert.deepEqual(periodsFor(thisYear + 5, "year"), []);
  });
});

describe("earliestYear", () => {
  test("an explicit year wins without touching the archive", async () => {
    assert.equal(await earliestYear(store, 2015), 2015);
  });

  test("finds the earliest date across invoices, bank transactions and journals", async () => {
    await store.writeRecord("Invoices", "i1", { InvoiceID: "i1", Date: "2019-05-01T00:00:00.000Z" });
    await store.writeRecord("BankTransactions", "b1", { BankTransactionID: "b1", Date: "2017-03-01T00:00:00.000Z" });
    await store.writeRecord("Journals", "1", { JournalNumber: 1, JournalDate: "2021-01-01T00:00:00.000Z" });
    assert.equal(await earliestYear(store, 0), 2017);
  });

  test("still understands Xero's wire format, for archives written before the migration", async () => {
    await store.writeRecord("Invoices", "i1", { InvoiceID: "i1", Date: "2016-07-26T02:07:11.767Z" });
    assert.equal(await earliestYear(store, 0), 2016);
  });

  test("falls back to seven years ago when nothing is archived", async () => {
    assert.equal(await earliestYear(store, 0), new Date().getUTCFullYear() - 7);
  });

  test("ignores records with unparseable dates", async () => {
    await store.writeRecord("Invoices", "i1", { InvoiceID: "i1", Date: "not a date" });
    assert.equal(await earliestYear(store, 0), new Date().getUTCFullYear() - 7);
  });
});

describe("archiveReports", () => {
  test("writes all three report kinds per period", async () => {
    const { client } = reportClient();
    await archiveReports(client, store, { reportPeriod: "year", reportFromYear: 2026 });
    assert.deepEqual((await readdir(store.reportsDir)).sort(), [
      "balance-sheet",
      "profit-and-loss",
      "trial-balance",
    ]);
  });

  test("a 403 on one kind doesn't cost the others", async () => {
    // Each report has its own granular scope now, so one refusal must not abort all.
    const { client } = reportClient(["ProfitAndLoss"]);
    await archiveReports(client, store, { reportPeriod: "year", reportFromYear: 2026 });
    assert.deepEqual((await readdir(store.reportsDir)).sort(), ["balance-sheet", "trial-balance"]);
  });

  test("a refused kind is not requested again for later periods", async () => {
    const { client, requested } = reportClient(["ProfitAndLoss"]);
    await archiveReports(client, store, { reportPeriod: "year", reportFromYear: 2024 });
    assert.equal(
      requested.filter((k) => k === "ProfitAndLoss").length,
      1,
      "should give up on that kind after the first 403",
    );
    assert.ok(requested.filter((k) => k === "BalanceSheet").length > 1);
  });

  test("stops early when every kind is refused", async () => {
    const { client, requested } = reportClient(["ProfitAndLoss", "BalanceSheet", "TrialBalance"]);
    await archiveReports(client, store, { reportPeriod: "year", reportFromYear: 2020 });
    assert.equal(requested.length, 3, "one attempt each, then abandon the pass");
  });

  test("P&L gets a date range while as-at reports get a single date", async () => {
    const urls: string[] = [];
    const client = new XeroClient({
      getAccessToken: async () => "t",
      sleep: async () => {},
      async fetch(input: any) {
        urls.push(String(input));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await archiveReports(client, store, { reportPeriod: "year", reportFromYear: 2026 });
    assert.match(urls.find((u) => u.includes("ProfitAndLoss"))!, /fromDate=2026-01-01&toDate=2026-12-31/);
    assert.match(urls.find((u) => u.includes("BalanceSheet"))!, /date=2026-12-31/);
  });
});
