/** Declarative catalog of every Accounting API resource we archive. */

export interface Endpoint {
  /** Folder name + used for logging. */
  name: string;
  /** API path relative to the Accounting base, e.g. "/Invoices". */
  path: string;
  /** Key holding the array in the JSON response, e.g. "Invoices". */
  arrayKey: string;
  /** Field holding the record's unique id (GUID for most). */
  idField: string;
  /** Uses page/pageSize pagination. */
  paged: boolean;
  /** Supports attachments (folder segment equals `name`). */
  attachments: boolean;
  /** Supports the /{id}/history endpoint. */
  history: boolean;
  /** "master" data (settings/contacts) vs "transaction" data. */
  kind: "master" | "transaction";
  /** Scope this needs — used only to skip gracefully on 403. */
  scopeNote?: string;
}

/** Master data — pulled first; small and referenced by everything else. */
export const MASTER: Endpoint[] = [
  { name: "Accounts", path: "/Accounts", arrayKey: "Accounts", idField: "AccountID", paged: false, attachments: true, history: false, kind: "master" },
  { name: "Contacts", path: "/Contacts", arrayKey: "Contacts", idField: "ContactID", paged: true, attachments: true, history: true, kind: "master" },
  { name: "ContactGroups", path: "/ContactGroups", arrayKey: "ContactGroups", idField: "ContactGroupID", paged: false, attachments: false, history: false, kind: "master" },
  { name: "Items", path: "/Items", arrayKey: "Items", idField: "ItemID", paged: false, attachments: false, history: true, kind: "master" },
  // Keyed by TaxType, not Name: TaxType is what line items reference (e.g. "INPUT2"),
  // so it makes the id a direct link target and gives tidy filenames.
  { name: "TaxRates", path: "/TaxRates", arrayKey: "TaxRates", idField: "TaxType", paged: false, attachments: false, history: false, kind: "master" },
  { name: "TrackingCategories", path: "/TrackingCategories", arrayKey: "TrackingCategories", idField: "TrackingCategoryID", paged: false, attachments: false, history: false, kind: "master" },
  { name: "Currencies", path: "/Currencies", arrayKey: "Currencies", idField: "Code", paged: false, attachments: false, history: false, kind: "master" },
  { name: "BrandingThemes", path: "/BrandingThemes", arrayKey: "BrandingThemes", idField: "BrandingThemeID", paged: false, attachments: false, history: false, kind: "master" },
  { name: "Users", path: "/Users", arrayKey: "Users", idField: "UserID", paged: false, attachments: false, history: false, kind: "master" },
];

/** Transactional data — the bulk of a historical archive. */
export const TRANSACTIONAL: Endpoint[] = [
  { name: "Invoices", path: "/Invoices", arrayKey: "Invoices", idField: "InvoiceID", paged: true, attachments: true, history: true, kind: "transaction" },
  { name: "CreditNotes", path: "/CreditNotes", arrayKey: "CreditNotes", idField: "CreditNoteID", paged: true, attachments: true, history: true, kind: "transaction" },
  { name: "BankTransactions", path: "/BankTransactions", arrayKey: "BankTransactions", idField: "BankTransactionID", paged: true, attachments: true, history: true, kind: "transaction" },
  { name: "BankTransfers", path: "/BankTransfers", arrayKey: "BankTransfers", idField: "BankTransferID", paged: false, attachments: true, history: true, kind: "transaction" },
  { name: "Payments", path: "/Payments", arrayKey: "Payments", idField: "PaymentID", paged: true, attachments: false, history: true, kind: "transaction" },
  { name: "BatchPayments", path: "/BatchPayments", arrayKey: "BatchPayments", idField: "BatchPaymentID", paged: false, attachments: false, history: true, kind: "transaction" },
  { name: "Overpayments", path: "/Overpayments", arrayKey: "Overpayments", idField: "OverpaymentID", paged: true, attachments: false, history: true, kind: "transaction" },
  { name: "Prepayments", path: "/Prepayments", arrayKey: "Prepayments", idField: "PrepaymentID", paged: true, attachments: false, history: true, kind: "transaction" },
  { name: "ManualJournals", path: "/ManualJournals", arrayKey: "ManualJournals", idField: "ManualJournalID", paged: true, attachments: true, history: true, kind: "transaction" },
  { name: "PurchaseOrders", path: "/PurchaseOrders", arrayKey: "PurchaseOrders", idField: "PurchaseOrderID", paged: true, attachments: true, history: true, kind: "transaction" },
  { name: "Quotes", path: "/Quotes", arrayKey: "Quotes", idField: "QuoteID", paged: false, attachments: true, history: true, kind: "transaction" },
  { name: "Receipts", path: "/Receipts", arrayKey: "Receipts", idField: "ReceiptID", paged: false, attachments: true, history: true, kind: "transaction" },
  { name: "ExpenseClaims", path: "/ExpenseClaims", arrayKey: "ExpenseClaims", idField: "ExpenseClaimID", paged: false, attachments: false, history: true, kind: "transaction" },
  { name: "LinkedTransactions", path: "/LinkedTransactions", arrayKey: "LinkedTransactions", idField: "LinkedTransactionID", paged: false, attachments: false, history: false, kind: "transaction" },
  { name: "RepeatingInvoices", path: "/RepeatingInvoices", arrayKey: "RepeatingInvoices", idField: "RepeatingInvoiceID", paged: false, attachments: true, history: true, kind: "transaction" },
];

export const ALL_ENDPOINTS = [...MASTER, ...TRANSACTIONAL];
