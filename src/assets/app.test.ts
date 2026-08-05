import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { setSilent } from "../log";
import { generateSite } from "../site";
import { Store } from "../store";
import { ROOT } from "../config";

setSilent(true);

/**
 * Runs the real `src/assets/app.js` against a real generated site, in a stub DOM
 * under `node:vm`.
 *
 * There's no browser or headless-Chrome dependency here, and no mock of the app's
 * own logic: the SPA's actual rendering code runs against actual generator output,
 * so this covers the generator→client contract that unit tests on either side miss.
 * Two shipped bugs — resolved fields rendering as `_ContactName` with no link — lived
 * exactly in that gap.
 */
interface Rendered {
  html: string;
  /** Detail-page `<dt>`/`<dd>` pairs, in render order. */
  rows: Array<{ label: string; text: string; href: string | null }>;
  /** Table rows as arrays of cell text. */
  cells: string[][];
}

let dataDir: string;
let siteDir: string;
let appSource: string;

const ACCOUNTS = [
  { AccountID: "acc-bank", Code: "600", Name: "Starling Business Account" },
  { AccountID: "acc-410", Code: "410", Name: "Entertainment" },
];

before(async () => {
  appSource = await readFile(path.join(ROOT, "src/assets/app.js"), "utf8");
  dataDir = await mkdtemp(path.join(tmpdir(), "xero-archive-app-"));

  const store = new Store("tenant-app-test", "ZZ App Test Org", dataDir);
  await store.init();
  await store.writeSingle("organisation", { Name: "ZZ App Test Org", BaseCurrency: "GBP" });
  for (const account of ACCOUNTS) await store.writeRecord("Accounts", account.AccountID, account);
  await store.writeRecord("Contacts", "con-hmrc", { ContactID: "con-hmrc", Name: "HMRC" });
  await store.writeRecord("Invoices", "inv-1", {
    InvoiceID: "inv-1",
    InvoiceNumber: "INV-001",
    Type: "ACCPAY",
    Status: "PAID",
    Date: "2022-04-21T00:00:00.000Z",
    Total: 335.8,
    CurrencyCode: "GBP",
    Contact: { ContactID: "con-hmrc", Name: "HMRC" },
    LineItems: [{ AccountID: "acc-410", AccountCode: "410", LineAmount: 335.8 }],
  });
  // 60 payments, so paging is observable; one carries the interesting references.
  for (let i = 0; i < 60; i++) {
    await store.writeRecord("Payments", `pay-${i}`, {
      PaymentID: `pay-${i}`,
      Date: `2022-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      Amount: 10 + i,
      PaymentType: "ACCPAYPAYMENT",
      Status: "AUTHORISED",
      IsReconciled: i === 0,
      Account: { AccountID: "acc-bank", Code: "600" },
      Invoice: { InvoiceID: "inv-1", InvoiceNumber: "INV-001", Contact: { ContactID: "con-hmrc" } },
    });
  }

  siteDir = await generateSite(store);
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(siteDir, { recursive: true, force: true });
});

/** Minimal stand-ins for the DOM the app touches. Event wiring is a no-op. */
function stubElement() {
  return {
    addEventListener() {},
    querySelector: () => null,
    getAttribute: () => null,
    value: "",
    className: "",
    textContent: "",
  };
}

async function render(hash: string): Promise<Rendered> {
  let html = "";
  const appElement = {
    className: "",
    set innerHTML(value: string) {
      html = value;
    },
    get innerHTML() {
      return html;
    },
  };

  const context: Record<string, unknown> = {
    console,
    Intl,
    Date,
    Number,
    Math,
    JSON,
    String,
    Object,
    Array,
    isFinite,
    parseInt,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    document: {
      getElementById: (id: string) => (id === "app" ? appElement : stubElement()),
      querySelectorAll: () => [],
    },
    window: { addEventListener() {} },
    location: { hash },
    async fetch(url: string) {
      // The app fetches "./data/…" for entities and "../../data/<org>/…" for reports.
      const relative = String(url).replace(/^\.\//, "");
      const file = relative.startsWith("../../data")
        ? path.join(dataDir, relative.replace(/^\.\.\/\.\.\/data\/[^/]+\//, ""))
        : path.join(siteDir, relative);
      const text = await readFile(file, "utf8");
      return { ok: true, json: async () => JSON.parse(text) };
    },
  };
  context.globalThis = context;

  vm.runInNewContext(appSource, context, { filename: "app.js" });

  // Rendering completes across a couple of promise chains (manifest, then entity).
  for (let i = 0; i < 50 && !html.includes("</main>"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const grid = /<dl class="detail-grid">([\s\S]*?)<\/dl>/.exec(html);
  const rows = [...(grid?.[1] ?? "").matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map(
    ([, label, value]) => ({
      label: strip(label),
      text: strip(value),
      href: /<a href="([^"]+)"/.exec(value)?.[1] ?? null,
    }),
  );
  const cells = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, cell]) => strip(cell)),
  );
  return { html, rows, cells };
}

const strip = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();

describe("payment detail page", () => {
  let rendered: Rendered;
  before(async () => {
    rendered = await render("#/e/Payments/pay-0");
  });

  test("shows resolved fields with their column label, not the generated key", () => {
    const labels = rendered.rows.map((r) => r.label);
    assert.ok(!labels.some((l) => l.includes("_")), `underscore leaked into ${labels.join(", ")}`);
    assert.ok(labels.includes("Contact"), labels.join(", "));
    assert.ok(labels.includes("Bank account"), labels.join(", "));
    assert.ok(labels.includes("Invoice"), labels.join(", "));
  });

  test("links the contact, bank account and invoice to their records", () => {
    const row = (label: string) => rendered.rows.find((r) => r.label === label);
    assert.equal(row("Contact")?.text, "HMRC");
    assert.equal(row("Contact")?.href, "#/e/Contacts/con-hmrc");
    assert.equal(row("Bank account")?.text, "Starling Business Account");
    assert.equal(row("Bank account")?.href, "#/e/Accounts/acc-bank");
    assert.equal(row("Invoice")?.href, "#/e/Invoices/inv-1");
  });

  test("does not show the record's own id as a field", () => {
    assert.ok(!rendered.rows.some((r) => r.label === "Payment ID"), "the id names the page");
    assert.ok(!rendered.rows.some((r) => r.text === "pay-0"));
  });

  test("orders the view's own columns before the remaining fields", () => {
    const labels = rendered.rows.map((r) => r.label);
    const lastColumn = Math.max(labels.indexOf("Contact"), labels.indexOf("Bank account"));
    const firstExtra = labels.indexOf("Exchange rate") === -1 ? Infinity : labels.indexOf("Exchange rate");
    assert.ok(lastColumn < firstExtra, `column fields should come first: ${labels.join(", ")}`);
    assert.equal(labels[0], "Date", "the first declared column leads");
  });

  test("renders booleans as Yes/No rather than true/false", () => {
    const reconciled = rendered.rows.find((r) => r.label === "Reconciled");
    assert.equal(reconciled?.text, "Yes");
    assert.ok(!rendered.html.includes(">true<"), "no raw boolean should reach the page");
  });
});

describe("payments list page", () => {
  test("renders a page of rows with the contact linked", async () => {
    const { html, cells } = await render("#/e/Payments");
    assert.match(html, /Payments/);
    // All 60 fit on one page: DEFAULT_PAGE_SIZE is 100.
    const bodyRows = cells.filter((row) => row.includes("HMRC"));
    assert.equal(bodyRows.length, 60);
    assert.match(html, /href="#\/e\/Contacts\/con-hmrc"/, "contact cells should link");
  });

  test("shows pagination for more records than fit on a page", async () => {
    const { html } = await render("#/e/Payments?size=50");
    assert.match(html, /Page 1 of 2/);
    assert.match(html, /1–50 of 60/);
    assert.match(html, /Next ›/);
  });

  test("honours the page parameter", async () => {
    const { html } = await render("#/e/Payments?size=50&p=2");
    assert.match(html, /Page 2 of 2/);
    assert.match(html, /51–60 of 60/);
  });

  test("clamps a page number beyond the end", async () => {
    const { html } = await render("#/e/Payments?size=50&p=99");
    assert.match(html, /Page 2 of 2/);
  });
});

describe("invoice detail page", () => {
  test("renders line items with the resolved account name", async () => {
    const { html, cells } = await render("#/e/Invoices/inv-1");
    assert.match(html, /Line items/);
    assert.ok(
      cells.some((row) => row.includes("Entertainment")),
      "line items should show the account name",
    );
    assert.match(html, /href="#\/e\/Accounts\/acc-410"/, "and link to the account");
  });

  test("formats money with the record's currency", async () => {
    const { rows } = await render("#/e/Invoices/inv-1");
    assert.ok(
      rows.some((r) => r.text.includes("£335.80")),
      rows.map((r) => `${r.label}=${r.text}`).join(" | "),
    );
  });
});

describe("links to unarchived entities", () => {
  test("are dropped rather than rendered as dead links", async () => {
    // BatchPayments isn't in this fixture, so nothing should point at it.
    const { html } = await render("#/e/Payments/pay-0");
    assert.ok(!html.includes("#/e/BatchPayments/"), "should not link to an absent entity");
  });
});

describe("home page", () => {
  test("lists each archived entity with its record count", async () => {
    const { html } = await render("#/");
    assert.match(html, /Overview/);
    assert.match(html, /Payments/);
    assert.match(html, />60</, "the payment count should show");
  });
});
