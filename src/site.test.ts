import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setSilent } from "./log";
import { annotateChildLines, buildNameLookups, generateSite, type NameLookups } from "./site";
import { Store } from "./store";
import { ALL_ENDPOINTS } from "./endpoints";

setSilent(true);

const ACCOUNTS = [
  { AccountID: "acc-410", Code: "410", Name: "Entertainment" },
  { AccountID: "acc-489", Code: "489", Name: "Telephone & Internet" },
  { AccountID: "acc-nocode", Name: "No Code Account" },
];
const TAX_RATES = [
  { TaxType: "INPUT2", Name: "20% (VAT on Expenses)", DisplayTaxRate: 20 },
  { TaxType: "NONE", Name: "No VAT", DisplayTaxRate: 0 },
];

describe("buildNameLookups", () => {
  test("indexes accounts by id and by code, and tax rates by type", () => {
    const lookups = buildNameLookups(ACCOUNTS, TAX_RATES);
    assert.equal(lookups.accountNameById.get("acc-410"), "Entertainment");
    assert.equal(lookups.accountNameByCode.get("410"), "Entertainment");
    assert.equal(lookups.taxRateNameByType.get("INPUT2"), "20% (VAT on Expenses)");
  });

  test("skips records missing the fields it needs", () => {
    const lookups = buildNameLookups(
      [{ AccountID: "x" }, null, { Code: "1", Name: "Named" }],
      [{ TaxType: "T" }, { Name: "No type" }, null],
    );
    assert.equal(lookups.accountNameById.has("x"), false, "no Name to show");
    assert.equal(lookups.accountNameByCode.get("1"), "Named");
    assert.equal(lookups.taxRateNameByType.size, 0);
  });

  test("copes with an empty archive", () => {
    const lookups = buildNameLookups([], []);
    assert.equal(lookups.accountNameById.size, 0);
    assert.equal(lookups.taxRateNameByType.size, 0);
  });
});

describe("annotateChildLines", () => {
  let lookups: NameLookups;
  beforeEach(() => {
    lookups = buildNameLookups(ACCOUNTS, TAX_RATES);
  });

  test("resolves the account name from AccountID, in preference to the code", () => {
    const rec: any = { LineItems: [{ AccountID: "acc-410", AccountCode: "489", TaxType: "INPUT2" }] };
    annotateChildLines(rec, lookups);
    assert.equal(rec.LineItems[0]._AccountName, "Entertainment", "AccountID should win");
  });

  test("falls back to the code when the id is unknown", () => {
    const rec: any = { LineItems: [{ AccountID: "gone", AccountCode: "489" }] };
    annotateChildLines(rec, lookups);
    assert.equal(rec.LineItems[0]._AccountName, "Telephone & Internet");
  });

  test("falls back to the bare code when nothing resolves", () => {
    // A partial archive shouldn't leave the cell empty.
    const rec: any = { LineItems: [{ AccountCode: "999" }] };
    annotateChildLines(rec, lookups);
    assert.equal(rec.LineItems[0]._AccountName, "999");
  });

  test("resolves the tax rate name from TaxType", () => {
    const rec: any = { LineItems: [{ TaxType: "INPUT2" }] };
    annotateChildLines(rec, lookups);
    assert.equal(rec.LineItems[0]._TaxRateName, "20% (VAT on Expenses)");
  });

  test("falls back to the raw tax type when unknown", () => {
    const rec: any = { LineItems: [{ TaxType: "MYSTERY" }] };
    annotateChildLines(rec, lookups);
    assert.equal(rec.LineItems[0]._TaxRateName, "MYSTERY");
  });

  test("leaves the resolved fields off entirely when there's nothing to resolve", () => {
    const rec: any = { LineItems: [{ Description: "just text" }] };
    annotateChildLines(rec, lookups);
    assert.ok(!("_AccountName" in rec.LineItems[0]));
    assert.ok(!("_TaxRateName" in rec.LineItems[0]));
  });

  test("annotates journal lines too, keeping Xero's own AccountName", () => {
    const rec: any = { JournalLines: [{ AccountCode: "410", AccountName: "From Xero", TaxType: "NONE" }] };
    annotateChildLines(rec, lookups);
    assert.equal(rec.JournalLines[0]._AccountName, "Entertainment");
    assert.equal(rec.JournalLines[0].AccountName, "From Xero", "the original is preserved");
    assert.equal(rec.JournalLines[0]._TaxRateName, "No VAT");
  });

  test("tolerates records with no child lines, or junk in them", () => {
    for (const rec of [{}, { LineItems: null }, { LineItems: [null, "x", 7] }] as any[]) {
      assert.doesNotThrow(() => annotateChildLines(rec, lookups));
    }
  });
});

describe("generated manifest and data", () => {
  let dir: string;
  let siteDir: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "xero-archive-site-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (siteDir) await rm(siteDir, { recursive: true, force: true });
    siteDir = undefined;
  });

  async function generate() {
    const store = new Store("tenant-site-test", "ZZ Site Test Org", dir);
    await store.init();
    await store.writeSingle("organisation", { Name: "ZZ Site Test Org" });
    for (const account of ACCOUNTS) await store.writeRecord("Accounts", account.AccountID ?? account.Code!, account);
    for (const rate of TAX_RATES) await store.writeRecord("TaxRates", rate.TaxType, rate);
    await store.writeRecord("Invoices", "inv-1", {
      InvoiceID: "inv-1",
      Date: "2024-01-01T00:00:00.000Z",
      LineItems: [{ AccountID: "acc-410", AccountCode: "410", TaxType: "INPUT2", LineAmount: 9.25 }],
    });

    siteDir = await generateSite(store);
    const read = async (file: string) => JSON.parse(await readFile(path.join(siteDir!, "data", file), "utf8"));
    return { manifest: await read("manifest.json"), invoices: await read("Invoices.json") };
  }

  test("line items carry resolved names for the browser to render", async () => {
    const { invoices } = await generate();
    assert.equal(invoices[0].LineItems[0]._AccountName, "Entertainment");
    assert.equal(invoices[0].LineItems[0]._TaxRateName, "20% (VAT on Expenses)");
  });

  test("the line item columns link accounts by id and tax rates by type", async () => {
    const { manifest } = await generate();
    const byKey = new Map<string, any>(manifest.lineItemColumns.map((c: any) => [c.key, c]));
    assert.deepEqual(byKey.get("_AccountName").link, { entity: "Accounts", idKey: "AccountID" });
    assert.deepEqual(byKey.get("_TaxRateName").link, { entity: "TaxRates", idKey: "TaxType" });
    assert.equal(byKey.get("_AccountName").label, "Account");
  });

  test("TaxRates is keyed by TaxType so the link resolves to a record", async () => {
    const { manifest } = await generate();
    const taxRates = manifest.entities.find((e: any) => e.name === "TaxRates");
    assert.equal(taxRates.view.idField, "TaxType");
    assert.equal(taxRates.view.titleField, "Name");
    assert.ok(
      taxRates.view.columns.some((c: any) => c.key === "TaxType" && c.label === "Tax Type"),
      "Tax Type should be a column",
    );
    // The catalog must agree, or records would be stored under a different key.
    assert.equal(ALL_ENDPOINTS.find((e) => e.name === "TaxRates")?.idField, "TaxType");
  });
});
