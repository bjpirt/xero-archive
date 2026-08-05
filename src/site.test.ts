import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setSilent } from "./log";
import {
  annotateChildLines,
  applyComputed,
  applyResolutions,
  buildNameLookups,
  generateSite,
  type NameLookups,
} from "./site";
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

const INVOICES = [
  { InvoiceID: "inv-1", InvoiceNumber: "INV-001", Contact: { Name: "Acme" } },
  { InvoiceID: "inv-draft", Contact: { Name: "No Number Ltd" } }, // drafts may lack a number
];
const CONTACTS = [{ ContactID: "con-1", Name: "Acme Supplies" }];

describe("buildNameLookups", () => {
  test("indexes accounts by id and by code, and tax rates by type", () => {
    const lookups = buildNameLookups({ accounts: ACCOUNTS, taxRates: TAX_RATES });
    assert.equal(lookups.accountName.get("acc-410"), "Entertainment");
    assert.equal(lookups.accountName.get("410"), "Entertainment");
    assert.equal(lookups.taxRateName.get("INPUT2"), "20% (VAT on Expenses)");
  });

  test("indexes invoices by number, falling back to the contact for drafts", () => {
    const lookups = buildNameLookups({ invoices: INVOICES });
    assert.equal(lookups.invoiceNumber.get("inv-1"), "INV-001");
    assert.equal(lookups.invoiceNumber.get("inv-draft"), "No Number Ltd");
  });

  test("indexes contacts by id", () => {
    assert.equal(buildNameLookups({ contacts: CONTACTS }).contactName.get("con-1"), "Acme Supplies");
  });

  test("skips records missing the fields it needs", () => {
    const lookups = buildNameLookups({
      accounts: [{ AccountID: "x" }, null, { Code: "1", Name: "Named" }],
      taxRates: [{ TaxType: "T" }, { Name: "No type" }, null],
    });
    assert.equal(lookups.accountName.has("x"), false, "no Name to show");
    assert.equal(lookups.accountName.get("1"), "Named");
    assert.equal(lookups.taxRateName.size, 0);
  });

  test("copes with an empty archive, and with absent source entities", () => {
    const lookups = buildNameLookups({});
    assert.equal(lookups.accountName.size, 0);
    assert.equal(lookups.invoiceNumber.size, 0);
    assert.equal(lookups.contactName.size, 0);
  });
});

describe("applyResolutions", () => {
  const lookups = buildNameLookups({ invoices: INVOICES, contacts: CONTACTS });

  test("turns a bare GUID into something readable", () => {
    const rec: any = { SourceTransactionID: "inv-1", ContactID: "con-1" };
    applyResolutions(
      rec,
      [
        { into: "_SourceInvoice", from: "SourceTransactionID", using: "invoiceNumber" },
        { into: "_ContactName", from: "ContactID", using: "contactName" },
      ],
      lookups,
    );
    assert.equal(rec._SourceInvoice, "INV-001");
    assert.equal(rec._ContactName, "Acme Supplies");
  });

  test("leaves the field unset when the id can't be resolved", () => {
    // Better an absent column than a column full of GUIDs — childTable drops it.
    const rec: any = { ContactID: "not-archived" };
    applyResolutions(rec, [{ into: "_ContactName", from: "ContactID", using: "contactName" }], lookups);
    assert.ok(!("_ContactName" in rec));
  });

  test("resolves through a nested path", () => {
    const rec: any = { Payments: [{ Invoice: { InvoiceID: "inv-1" } }] };
    applyResolutions(
      rec,
      [{ into: "_InvoiceNumber", from: "Invoice.InvoiceID", using: "invoiceNumber", inArray: "Payments" }],
      lookups,
    );
    assert.equal(rec.Payments[0]._InvoiceNumber, "INV-001");
  });

  test("inArray tolerates a missing or non-array field", () => {
    for (const rec of [{}, { Payments: null }, { Payments: [null, 3] }] as any[]) {
      assert.doesNotThrow(() =>
        applyResolutions(
          rec,
          [{ into: "_X", from: "Invoice.InvoiceID", using: "invoiceNumber", inArray: "Payments" }],
          lookups,
        ),
      );
    }
  });
});

describe("applyComputed", () => {
  test("joins a name from its parts", () => {
    const rec: any = { FirstName: "Rebecca", LastName: "Pirt" };
    applyComputed(rec, [{ into: "_Name", from: ["FirstName", "LastName"] }]);
    assert.equal(rec._Name, "Rebecca Pirt");
  });

  test("skips absent parts rather than leaving stray separators", () => {
    const rec: any = { FirstName: "Cher" };
    applyComputed(rec, [{ into: "_Name", from: ["FirstName", "LastName"] }]);
    assert.equal(rec._Name, "Cher");
  });

  test("writes nothing when no part is present", () => {
    const rec: any = {};
    applyComputed(rec, [{ into: "_Name", from: ["FirstName", "LastName"] }]);
    assert.ok(!("_Name" in rec));
  });

  test("honours a custom separator", () => {
    const rec: any = { A: "x", B: "y" };
    applyComputed(rec, [{ into: "_J", from: ["A", "B"], separator: ", " }]);
    assert.equal(rec._J, "x, y");
  });
});

describe("annotateChildLines", () => {
  let lookups: NameLookups;
  beforeEach(() => {
    lookups = buildNameLookups({ accounts: ACCOUNTS, taxRates: TAX_RATES });
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
      InvoiceNumber: "INV-001",
      Date: "2024-01-01T00:00:00.000Z",
      LineItems: [{ AccountID: "acc-410", AccountCode: "410", TaxType: "INPUT2", LineAmount: 9.25 }],
    });
    await store.writeRecord("Invoices", "inv-2", {
      InvoiceID: "inv-2",
      InvoiceNumber: "INV-002",
      Date: "2024-02-01T00:00:00.000Z",
    });
    for (const contact of CONTACTS) await store.writeRecord("Contacts", contact.ContactID, contact);
    // Manual journal lines have AccountID but no AccountName of their own.
    await store.writeRecord("ManualJournals", "mj-1", {
      ManualJournalID: "mj-1",
      Narration: "Year end adjustments",
      Date: "2024-03-31T00:00:00.000Z",
      JournalLines: [{ AccountID: "acc-410", AccountCode: "410", TaxType: "NONE", LineAmount: -10 }],
    });
    await store.writeRecord("LinkedTransactions", "lt-1", {
      LinkedTransactionID: "lt-1",
      SourceTransactionID: "inv-1",
      TargetTransactionID: "inv-2",
      ContactID: "con-1",
      Type: "BILLABLEEXPENSE",
      Status: "BILLED",
    });
    await store.writeRecord("BatchPayments", "bp-1", {
      BatchPaymentID: "bp-1",
      Date: "2024-04-01T00:00:00.000Z",
      Type: "RECBATCH",
      TotalAmount: 100,
      Payments: [{ PaymentID: "pay-1", Amount: 100, Invoice: { InvoiceID: "inv-1" } }],
    });
    await store.writeRecord("Users", "user-1", {
      UserID: "user-1",
      FirstName: "Rebecca",
      LastName: "Pirt",
      EmailAddress: "rebecca@example.com",
      OrganisationRole: "FINANCIALADVISER",
    });

    siteDir = await generateSite(store);
    const read = async (file: string) => JSON.parse(await readFile(path.join(siteDir!, "data", file), "utf8"));
    return {
      manifest: await read("manifest.json"),
      invoices: await read("Invoices.json"),
      manualJournals: await read("ManualJournals.json"),
      linked: await read("LinkedTransactions.json"),
      batches: await read("BatchPayments.json"),
      users: await read("Users.json"),
    };
  }

  test("line items carry resolved names for the browser to render", async () => {
    const { invoices } = await generate();
    // Records are sorted newest-first, so find the one with lines rather than assume.
    const line = invoices.find((i: any) => i.InvoiceID === "inv-1").LineItems[0];
    assert.equal(line._AccountName, "Entertainment");
    assert.equal(line._TaxRateName, "20% (VAT on Expenses)");
  });

  test("the line item columns link accounts by id and tax rates by type", async () => {
    const { manifest } = await generate();
    const byKey = new Map<string, any>(manifest.lineItemColumns.map((c: any) => [c.key, c]));
    assert.deepEqual(byKey.get("_AccountName").link, { entity: "Accounts", idKey: "AccountID" });
    assert.deepEqual(byKey.get("_TaxRateName").link, { entity: "TaxRates", idKey: "TaxType" });
    assert.equal(byKey.get("_AccountName").label, "Account");
  });

  test("manual journal lines show a resolved account name, linked by id", async () => {
    // Manual journal lines carry no AccountName of their own, so without resolution
    // the Account column would be empty and childTable would drop it.
    const { manifest, manualJournals } = await generate();
    assert.equal(manualJournals[0].JournalLines[0]._AccountName, "Entertainment");
    const account = manifest.journalLineColumns.find((c: any) => c.label === "Account");
    assert.equal(account.key, "_AccountName");
    assert.deepEqual(account.link, { entity: "Accounts", idKey: "AccountID" });
  });

  test("linked transactions resolve their GUIDs to invoices and a contact", async () => {
    const { linked } = await generate();
    assert.equal(linked[0]._SourceInvoice, "INV-001");
    assert.equal(linked[0]._TargetInvoice, "INV-002");
    assert.equal(linked[0]._ContactName, "Acme Supplies");
  });

  test("batch payments resolve each nested payment to its invoice", async () => {
    const { batches, manifest } = await generate();
    assert.equal(batches[0].Payments[0]._InvoiceNumber, "INV-001");
    const view = manifest.entities.find((e: any) => e.name === "BatchPayments").view;
    assert.ok(
      view.columns.some((c: any) => c.key === "Payments.length"),
      "the list should show how many payments are in the batch",
    );
    assert.equal(view.related[0].entity, "Payments");
  });

  test("users get a name composed from their parts, and no id column", async () => {
    const { users, manifest } = await generate();
    assert.equal(users[0]._Name, "Rebecca Pirt");
    const view = manifest.entities.find((e: any) => e.name === "Users").view;
    assert.deepEqual(
      view.columns.map((c: any) => c.key),
      ["_Name", "EmailAddress", "OrganisationRole", "IsSubscriber", "UpdatedDateUTC"],
    );
    assert.ok(!view.columns.some((c: any) => c.key === "UserID"), "the GUID shouldn't be a column");
    assert.equal(view.idField, "UserID", "but it's still the record key");
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
