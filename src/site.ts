import { mkdir, writeFile, readFile, readdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT, SITE_DIR, DATA_DIR } from "./config";
import { MASTER, TRANSACTIONAL } from "./endpoints";
import { Store, safeName, slug } from "./store";
import { log } from "./log";

/** Column type hints the client uses for formatting. */
type ColType = "text" | "date" | "money" | "badge";

/**
 * Turns a cell into a link to another archived record. `idKey` is a dot path on
 * *this* record holding the target's key. Without `by` that key is the target's
 * own id and we link straight to its detail page; with `by` we can't know the
 * target's id (e.g. we hold an account *code*), so we link to its list filtered
 * on that field instead. Either way `app.js` drops the link if the target entity
 * wasn't archived.
 */
interface Link {
  entity: string;
  idKey: string;
  by?: string;
}
interface Column {
  key: string; // supports dot paths, e.g. "Contact.Name"
  label: string;
  type?: ColType;
  link?: Link;
}
/** A child array on the record whose entries are documents in their own right. */
interface Related {
  label: string;
  entity: string;
  arrayKey: string;
  idKey: string;
  columns: Column[];
}
/** The reverse direction: other records pointing *at* this one. */
interface Backlink {
  label: string;
  entity: string;
  path: string; // path on the other entity, `[]` marks an array hop
  valueKey?: string; // field on *this* record they match (default: its idField)
}
interface View {
  label: string;
  idField: string;
  titleField?: string;
  dateField?: string;
  columns: Column[];
  related?: Related[];
  backlinks?: Backlink[];
}

/** Every transactional entity carries the same Contact shape. */
const contactCol = (label = "Contact"): Column => ({
  key: "Contact.Name",
  label,
  link: { entity: "Contacts", idKey: "Contact.ContactID" },
});

const accountCol = (key: string, label: string): Column => ({
  key: `${key}.Name`,
  label,
  link: { entity: "Accounts", idKey: `${key}.AccountID` },
});

/**
 * Names resolved into child lines at generation time. Line items carry only an
 * `AccountID`/`AccountCode` and a `TaxType`, and the browser has no way to join
 * across entities, so `annotateChildLines` fills these in. See `buildNameLookups`.
 */
const RESOLVED_ACCOUNT = "_AccountName";
const RESOLVED_TAX_RATE = "_TaxRateName";

const JOURNAL_LINE_COLUMNS: Column[] = [
  { key: "AccountCode", label: "Code" },
  {
    key: "AccountName",
    label: "Account",
    link: { entity: "Accounts", idKey: "AccountCode", by: "Code" },
  },
  { key: "Description", label: "Description" },
  { key: RESOLVED_TAX_RATE, label: "Tax", link: { entity: "TaxRates", idKey: "TaxType" } },
  { key: "NetAmount", label: "Net", type: "money" },
  { key: "TaxAmount", label: "Tax", type: "money" },
  { key: "GrossAmount", label: "Gross", type: "money" },
];

const LINE_ITEM_COLUMNS: Column[] = [
  { key: "Description", label: "Description" },
  { key: "Quantity", label: "Qty" },
  { key: "UnitAmount", label: "Unit", type: "money" },
  // Line items hold AccountID, so this links straight to the account's page.
  { key: RESOLVED_ACCOUNT, label: "Account", link: { entity: "Accounts", idKey: "AccountID" } },
  { key: RESOLVED_TAX_RATE, label: "Tax", link: { entity: "TaxRates", idKey: "TaxType" } },
  { key: "TaxAmount", label: "Tax amt", type: "money" },
  { key: "LineAmount", label: "Amount", type: "money" },
];

/** Display names for the ids and codes that child lines reference. */
export interface NameLookups {
  accountNameById: Map<string, string>;
  accountNameByCode: Map<string, string>;
  taxRateNameByType: Map<string, string>;
}

export function buildNameLookups(accounts: any[], taxRates: any[]): NameLookups {
  const lookups: NameLookups = {
    accountNameById: new Map(),
    accountNameByCode: new Map(),
    taxRateNameByType: new Map(),
  };
  for (const account of accounts) {
    if (!account?.Name) continue;
    if (account.AccountID) lookups.accountNameById.set(String(account.AccountID), account.Name);
    if (account.Code) lookups.accountNameByCode.set(String(account.Code), account.Name);
  }
  for (const rate of taxRates) {
    if (rate?.TaxType && rate.Name) lookups.taxRateNameByType.set(String(rate.TaxType), rate.Name);
  }
  return lookups;
}

/**
 * Resolves account and tax-rate names into a record's child lines, in place.
 *
 * Falls back to the raw code when a name can't be found — a partial archive should
 * still show something useful rather than an empty cell, and `fmtCell` drops the
 * link anyway when the target entity is absent.
 */
export function annotateChildLines(rec: any, lookups: NameLookups): void {
  for (const key of ["LineItems", "JournalLines"]) {
    const lines = rec?.[key];
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (!line || typeof line !== "object") continue;
      const byId = line.AccountID ? lookups.accountNameById.get(String(line.AccountID)) : undefined;
      const byCode = line.AccountCode
        ? lookups.accountNameByCode.get(String(line.AccountCode))
        : undefined;
      const accountName = byId ?? byCode ?? line.AccountName ?? line.AccountCode;
      if (accountName != null) line[RESOLVED_ACCOUNT] = accountName;

      if (line.TaxType != null) {
        line[RESOLVED_TAX_RATE] = lookups.taxRateNameByType.get(String(line.TaxType)) ?? line.TaxType;
      }
    }
  }
}

const PAYMENT_RELATED: Related = {
  label: "Payments",
  entity: "Payments",
  arrayKey: "Payments",
  idKey: "PaymentID",
  columns: [
    { key: "Date", label: "Date", type: "date" },
    { key: "Amount", label: "Amount", type: "money" },
    { key: "Reference", label: "Reference" },
  ],
};

/** Documents that hang off a contact — used for the reverse links on Contacts. */
const CONTACT_BACKLINKS: Backlink[] = [
  "Invoices",
  "CreditNotes",
  "BankTransactions",
  "PurchaseOrders",
  "Quotes",
  "Overpayments",
  "Prepayments",
  "RepeatingInvoices",
].map((entity) => ({ label: entity, entity, path: "Contact.ContactID" }));

const VIEWS: Record<string, View> = {
  Invoices: {
    label: "Invoices & Bills", idField: "InvoiceID", titleField: "InvoiceNumber", dateField: "Date",
    columns: [
      { key: "Type", label: "Type", type: "badge" },
      { key: "InvoiceNumber", label: "Number" },
      contactCol(),
      { key: "Date", label: "Date", type: "date" },
      { key: "DueDate", label: "Due", type: "date" },
      { key: "Total", label: "Total", type: "money" },
      { key: "AmountDue", label: "Due", type: "money" },
      { key: "Status", label: "Status", type: "badge" },
    ],
    related: [
      PAYMENT_RELATED,
      {
        label: "Credit notes",
        entity: "CreditNotes",
        arrayKey: "CreditNotes",
        idKey: "CreditNoteID",
        columns: [
          { key: "CreditNoteNumber", label: "Number" },
          { key: "Date", label: "Date", type: "date" },
          { key: "AppliedAmount", label: "Applied", type: "money" },
        ],
      },
      {
        label: "Prepayments",
        entity: "Prepayments",
        arrayKey: "Prepayments",
        idKey: "PrepaymentID",
        columns: [
          { key: "Date", label: "Date", type: "date" },
          { key: "AppliedAmount", label: "Applied", type: "money" },
        ],
      },
      {
        label: "Overpayments",
        entity: "Overpayments",
        arrayKey: "Overpayments",
        idKey: "OverpaymentID",
        columns: [
          { key: "Date", label: "Date", type: "date" },
          { key: "AppliedAmount", label: "Applied", type: "money" },
        ],
      },
    ],
  },
  CreditNotes: {
    label: "Credit Notes", idField: "CreditNoteID", titleField: "CreditNoteNumber", dateField: "Date",
    columns: [
      { key: "Type", label: "Type", type: "badge" },
      { key: "CreditNoteNumber", label: "Number" },
      contactCol(),
      { key: "Date", label: "Date", type: "date" },
      { key: "Total", label: "Total", type: "money" },
      { key: "Status", label: "Status", type: "badge" },
    ],
    related: [PAYMENT_RELATED],
  },
  BankTransactions: {
    label: "Bank Transactions", idField: "BankTransactionID", dateField: "Date",
    columns: [
      { key: "Type", label: "Type", type: "badge" },
      contactCol(),
      accountCol("BankAccount", "Bank Account"),
      { key: "Date", label: "Date", type: "date" },
      { key: "Total", label: "Total", type: "money" },
      { key: "Reference", label: "Reference" },
      { key: "Status", label: "Status", type: "badge" },
    ],
  },
  BankTransfers: {
    label: "Bank Transfers", idField: "BankTransferID", dateField: "Date",
    columns: [
      { key: "Date", label: "Date", type: "date" },
      accountCol("FromBankAccount", "From"),
      accountCol("ToBankAccount", "To"),
      { key: "Amount", label: "Amount", type: "money" },
    ],
  },
  Payments: {
    label: "Payments", idField: "PaymentID", dateField: "Date",
    columns: [
      { key: "Date", label: "Date", type: "date" },
      { key: "PaymentType", label: "Type", type: "badge" },
      {
        key: "Invoice.InvoiceNumber",
        label: "Invoice",
        link: { entity: "Invoices", idKey: "Invoice.InvoiceID" },
      },
      { key: "Invoice.Contact.Name", label: "Contact" },
      accountCol("Account", "Account"),
      { key: "Amount", label: "Amount", type: "money" },
      { key: "Reference", label: "Reference" },
      { key: "Status", label: "Status", type: "badge" },
    ],
  },
  Overpayments: {
    label: "Overpayments", idField: "OverpaymentID", dateField: "Date",
    columns: [
      { key: "Type", label: "Type", type: "badge" },
      contactCol(),
      { key: "Date", label: "Date", type: "date" },
      { key: "Total", label: "Total", type: "money" },
      { key: "Status", label: "Status", type: "badge" },
    ],
  },
  Prepayments: {
    label: "Prepayments", idField: "PrepaymentID", dateField: "Date",
    columns: [
      { key: "Type", label: "Type", type: "badge" },
      contactCol(),
      { key: "Date", label: "Date", type: "date" },
      { key: "Total", label: "Total", type: "money" },
      { key: "Status", label: "Status", type: "badge" },
    ],
  },
  ManualJournals: {
    label: "Manual Journals", idField: "ManualJournalID", dateField: "Date",
    columns: [
      { key: "Date", label: "Date", type: "date" },
      { key: "Narration", label: "Narration" },
      { key: "Status", label: "Status", type: "badge" },
    ],
  },
  PurchaseOrders: {
    label: "Purchase Orders", idField: "PurchaseOrderID", titleField: "PurchaseOrderNumber", dateField: "Date",
    columns: [
      { key: "PurchaseOrderNumber", label: "Number" },
      contactCol(),
      { key: "Date", label: "Date", type: "date" },
      { key: "Total", label: "Total", type: "money" },
      { key: "Status", label: "Status", type: "badge" },
    ],
  },
  Quotes: {
    label: "Quotes", idField: "QuoteID", titleField: "QuoteNumber", dateField: "Date",
    columns: [
      { key: "QuoteNumber", label: "Number" },
      contactCol(),
      { key: "Date", label: "Date", type: "date" },
      { key: "Total", label: "Total", type: "money" },
      { key: "Status", label: "Status", type: "badge" },
    ],
  },
  Receipts: {
    label: "Receipts", idField: "ReceiptID", dateField: "Date",
    columns: [
      { key: "ReceiptNumber", label: "Number" },
      contactCol(),
      { key: "Date", label: "Date", type: "date" },
      { key: "Total", label: "Total", type: "money" },
      { key: "Status", label: "Status", type: "badge" },
    ],
  },
  ExpenseClaims: {
    label: "Expense Claims", idField: "ExpenseClaimID",
    columns: [
      { key: "Status", label: "Status", type: "badge" },
      { key: "Total", label: "Total", type: "money" },
      { key: "AmountDue", label: "Due", type: "money" },
    ],
  },
  LinkedTransactions: {
    label: "Linked Transactions", idField: "LinkedTransactionID",
    columns: [
      { key: "SourceTransactionTypeCode", label: "Source" },
      { key: "Status", label: "Status", type: "badge" },
    ],
  },
  RepeatingInvoices: {
    label: "Repeating Invoices", idField: "RepeatingInvoiceID",
    columns: [
      { key: "Type", label: "Type", type: "badge" },
      contactCol(),
      { key: "Total", label: "Total", type: "money" },
      { key: "Status", label: "Status", type: "badge" },
    ],
  },
  Journals: {
    label: "Journals (Ledger)", idField: "JournalNumber", dateField: "JournalDate",
    columns: [
      { key: "JournalNumber", label: "#" },
      { key: "JournalDate", label: "Date", type: "date" },
      { key: "Reference", label: "Reference" },
      { key: "SourceType", label: "Source", type: "badge" },
    ],
  },
  Contacts: {
    label: "Contacts", idField: "ContactID", titleField: "Name",
    columns: [
      { key: "Name", label: "Name" },
      { key: "EmailAddress", label: "Email" },
      { key: "AccountNumber", label: "Account #" },
      { key: "ContactStatus", label: "Status", type: "badge" },
    ],
    backlinks: CONTACT_BACKLINKS,
  },
  Accounts: {
    label: "Chart of Accounts", idField: "AccountID", titleField: "Name",
    columns: [
      { key: "Code", label: "Code" },
      { key: "Name", label: "Name" },
      { key: "Type", label: "Type", type: "badge" },
      { key: "Class", label: "Class" },
      { key: "Status", label: "Status", type: "badge" },
    ],
    // Transactions reference accounts by code on each line item.
    backlinks: [
      { label: "Invoices", entity: "Invoices", path: "LineItems[].AccountCode", valueKey: "Code" },
      { label: "BankTransactions", entity: "BankTransactions", path: "LineItems[].AccountCode", valueKey: "Code" },
      { label: "CreditNotes", entity: "CreditNotes", path: "LineItems[].AccountCode", valueKey: "Code" },
    ],
  },
  TaxRates: {
    label: "Tax Rates", idField: "TaxType", titleField: "Name",
    columns: [
      { key: "Name", label: "Name" },
      { key: "TaxType", label: "Tax Type" },
      { key: "DisplayTaxRate", label: "Rate" },
      { key: "ReportTaxType", label: "Reporting type" },
      { key: "Status", label: "Status", type: "badge" },
    ],
    // Line items reference the rate by TaxType, which is this view's id.
    backlinks: [
      { label: "Invoices", entity: "Invoices", path: "LineItems[].TaxType" },
      { label: "BankTransactions", entity: "BankTransactions", path: "LineItems[].TaxType" },
      { label: "CreditNotes", entity: "CreditNotes", path: "LineItems[].TaxType" },
    ],
  },
  Items: {
    label: "Items", idField: "ItemID", titleField: "Name",
    columns: [
      { key: "Code", label: "Code" },
      { key: "Name", label: "Name" },
      { key: "Description", label: "Description" },
    ],
  },
};

function genericView(entity: string, idField: string): View {
  return {
    label: entity,
    idField,
    columns: [
      { key: idField, label: "ID" },
      { key: "Name", label: "Name" },
      { key: "UpdatedDateUTC", label: "Updated", type: "date" },
    ],
  };
}

async function readHistory(store: Store, entity: string, id: string): Promise<any[]> {
  const file = path.join(store.rawDir, "_history", entity, `${safeName(id)}.json`);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

async function scanReports(store: Store): Promise<Record<string, { label: string; file: string }[]>> {
  const out: Record<string, { label: string; file: string }[]> = {};
  if (!existsSync(store.reportsDir)) return out;
  for (const kind of await readdir(store.reportsDir)) {
    const dir = path.join(store.reportsDir, kind);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    out[kind] = files
      .map((f) => ({ label: f.replace(/\.json$/, ""), file: f }))
      .sort((a, b) => b.label.localeCompare(a.label));
  }
  return out;
}

/** Generates the browsable static site for one archived organisation. */
export async function generateSite(store: Store): Promise<string> {
  const dirName = path.basename(store.tenantDir);
  const siteTenant = path.join(SITE_DIR, dirName);
  const dataOut = path.join(siteTenant, "data");
  const assetsDir = path.join(SITE_DIR, "assets");
  await mkdir(dataOut, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  const srcAssets = path.join(ROOT, "src", "assets");
  await copyFile(path.join(srcAssets, "style.css"), path.join(assetsDir, "style.css"));
  await copyFile(path.join(srcAssets, "app.js"), path.join(assetsDir, "app.js"));

  // path from site/<dir>/index.html back to data/<dir>
  const base = `../../data/${dirName}`;

  const org = (await store.readSingle("organisation")) ?? {};
  const entitiesMeta: any[] = [];

  const order = [
    ...TRANSACTIONAL.map((e) => ({ name: e.name, idField: e.idField, attach: e.attachments, group: "transaction" })),
    { name: "Journals", idField: "JournalNumber", attach: false, group: "ledger" },
    ...MASTER.map((e) => ({ name: e.name, idField: e.idField, attach: e.attachments, group: "master" })),
  ];

  // Read once: every entity's child lines resolve their names against these.
  const lookups = buildNameLookups(
    await store.readEntity("Accounts"),
    await store.readEntity("TaxRates"),
  );

  for (const e of order) {
    const records = await store.readEntity(e.name);
    if (records.length === 0) continue;
    const view = VIEWS[e.name] ?? genericView(e.name, e.idField);

    for (const rec of records) {
      const id = String(rec[e.idField] ?? "");
      annotateChildLines(rec, lookups);
      if (e.attach) {
        const files = await store.listAttachments(e.name, id);
        if (files.length) {
          rec._attachments = files.map((f) => ({
            name: f,
            href: `${base}/attachments/${e.name}/${safeName(id)}/${encodeURIComponent(f)}`,
          }));
        }
      }
      const hist = await readHistory(store, e.name, id);
      if (hist.length) rec._history = hist;
    }

    if (view.dateField) {
      records.sort((a, b) => String(b[view.dateField!] ?? "").localeCompare(String(a[view.dateField!] ?? "")));
    }

    await writeFile(path.join(dataOut, `${e.name}.json`), JSON.stringify(records));
    entitiesMeta.push({ name: e.name, count: records.length, group: e.group, view });
  }

  const reports = await scanReports(store);

  const manifest = {
    generatedAt: new Date().toISOString(),
    base,
    org: {
      Name: org.Name ?? store.tenantName,
      LegalName: org.LegalName,
      CountryCode: org.CountryCode,
      BaseCurrency: org.BaseCurrency,
      OrganisationType: org.OrganisationType,
      FinancialYearEndDay: org.FinancialYearEndDay,
      FinancialYearEndMonth: org.FinancialYearEndMonth,
    },
    entities: entitiesMeta,
    reports,
    // Shared child-table shapes: every entity's LineItems/JournalLines look alike.
    lineItemColumns: LINE_ITEM_COLUMNS,
    journalLineColumns: JOURNAL_LINE_COLUMNS,
  };
  await writeFile(path.join(dataOut, "manifest.json"), JSON.stringify(manifest, null, 2));

  await writeFile(path.join(siteTenant, "index.html"), tenantIndexHtml(manifest.org.Name));

  log.ok(`Site generated: ${path.join(siteTenant, "index.html")}`);
  return siteTenant;
}

/** Writes a top-level landing page linking to each organisation's site. */
export async function generateLanding(orgDirs: { dir: string; name: string }[]): Promise<void> {
  const links = orgDirs
    .map((o) => `<li><a href="./${encodeURIComponent(o.dir)}/index.html">${escapeHtml(o.name)}</a></li>`)
    .join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>Xero Archive</title>
<link rel="stylesheet" href="./assets/style.css">
<div class="landing"><h1>Xero Archive</h1><p>Archived organisations:</p><ul>${links}</ul></div>`;
  await mkdir(SITE_DIR, { recursive: true });
  await writeFile(path.join(SITE_DIR, "index.html"), html);
}

function tenantIndexHtml(orgName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(orgName)} — Xero Archive</title>
<link rel="stylesheet" href="../assets/style.css">
</head>
<body>
<div id="app"><p class="loading">Loading archive…</p></div>
<script src="../assets/app.js"></script>
</body>
</html>`;
}

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** Discovers archived tenants on disk (for `site` without a fresh archive). */
export async function findArchivedStores(): Promise<Store[]> {
  if (!existsSync(DATA_DIR)) return [];
  const stores: Store[] = [];
  for (const entry of await readdir(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(DATA_DIR, entry.name);
    if (!existsSync(path.join(dir, "raw"))) continue; // a real archive has a raw/ folder
    stores.push(Store.fromDir(dir));
  }
  return stores;
}

// re-export so cli can slug names if needed
export { slug };
