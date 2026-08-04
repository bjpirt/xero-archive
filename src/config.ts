import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (one level up from src/). */
export const ROOT = path.resolve(__dirname, "..");

export const DATA_DIR = path.join(ROOT, "data");
export const SITE_DIR = path.join(ROOT, "site");

/** Xero OAuth 2.0 + API endpoints. */
export const XERO = {
  authorizeUrl: "https://login.xero.com/identity/connect/authorize",
  tokenUrl: "https://identity.xero.com/connect/token",
  connectionsUrl: "https://api.xero.com/connections",
  apiBase: "https://api.xero.com/api.xro/2.0",
} as const;

/**
 * Read-only scopes for a complete archive. `offline_access` is required to get a
 * refresh token.
 *
 * Xero replaced the broad accounting scopes with granular ones and, since March
 * 2026, assigns granular scopes to every web/PKCE app — new and existing — so we
 * request granular by default. Broad scopes survive until September 2027 but only
 * on apps that already had them, hence the LEGACY list below.
 * https://developer.xero.com/documentation/guides/oauth2/scopes/
 *
 * Xero rejects the *entire* authorize request with `invalid_scope` if a single
 * scope isn't assigned to the app, so `resolveScopes()` in `auth.ts` drops the
 * ones an app can't have. `XERO_SCOPES` overrides the list wholesale and skips
 * that negotiation.
 */
const GRANULAR_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  // Invoices, CreditNotes, Quotes, PurchaseOrders, RepeatingInvoices, LinkedTransactions, Items
  "accounting.invoices.read",
  // Payments, BatchPayments, Overpayments, Prepayments
  "accounting.payments.read",
  // BankTransactions, BankTransfers
  "accounting.banktransactions.read",
  "accounting.manualjournals.read",
  "accounting.contacts.read",
  "accounting.settings.read",
  "accounting.attachments.read",
  "accounting.reports.profitandloss.read",
  "accounting.reports.balancesheet.read",
  "accounting.reports.trialbalance.read",
  // Premium (Advanced tier + security assessment); dropped if unassigned.
  "accounting.journals.read",
];

/**
 * Deprecated broad scopes, requested *in addition* to the granular ones and
 * dropped when Xero rejects them. Receipts and ExpenseClaims have no granular
 * equivalent, so on apps that still hold these scopes they remain archivable.
 */
const LEGACY_SCOPES = ["accounting.transactions.read", "accounting.reports.read"];

const DEFAULT_SCOPES = [...GRANULAR_SCOPES, ...LEGACY_SCOPES];

/** Endpoints that only the deprecated broad transactions scope can reach. */
export const BROAD_SCOPE_ONLY = ["Receipts", "ExpenseClaims"];

/**
 * A blank value counts as unset. `.env` files habitually carry empty keys
 * (`XERO_SCOPES=`), and without this a blank would win over the default — which
 * made `XERO_TOKENS_FILE=` resolve to the project directory rather than
 * `.tokens.json`.
 */
function env(name: string, fallback = ""): string {
  const raw = process.env[name]?.trim();
  return raw ? raw : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name).toLowerCase();
  if (v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Where the rotating refresh token lives. Configurable because a refresh token is
 * bound to the client that issued it: two Xero apps sharing one token file would
 * clobber each other, forcing a browser re-auth on every switch. Relative paths
 * resolve against the project root.
 */
export const TOKENS_FILE = path.resolve(ROOT, env("XERO_TOKENS_FILE", ".tokens.json"));

/** An explicit `XERO_SCOPES` (whitespace/comma separated) is used verbatim. */
export const SCOPES_OVERRIDDEN = env("XERO_SCOPES") !== "";

export const SCOPES =
  env("XERO_SCOPES").split(/[\s,]+/).filter(Boolean).join(" ") || DEFAULT_SCOPES.join(" ");

export const CONFIG = {
  clientId: env("XERO_CLIENT_ID"),
  // Optional: only "web app" style Xero apps that issue a secret need this. PKCE
  // alone is enough for mobile/desktop apps, so it stays empty for those.
  clientSecret: env("XERO_CLIENT_SECRET"),
  redirectUri: env("XERO_REDIRECT_URI", "http://localhost:5173/callback"),
  callbackPort: envInt("AUTH_CALLBACK_PORT", 5173),
  includeHistory: envBool("INCLUDE_HISTORY", false),
  // Re-list every document's attachments even when the marker says they're complete.
  // Set by `npm run archive -- --refresh-attachments` as well as the env var.
  refreshAttachments: envBool("REFRESH_ATTACHMENTS", false),
  // Phase switches, for spreading a large archive across several daily quotas.
  skipAttachments: envBool("SKIP_ATTACHMENTS", false),
  attachmentsOnly: envBool("ATTACHMENTS_ONLY", false),
  includeReports: envBool("INCLUDE_REPORTS", true),
  reportPeriod: (env("REPORT_PERIOD", "year") === "month" ? "month" : "year") as
    | "year"
    | "month",
  reportFromYear: envInt("REPORT_FROM_YEAR", 0),
  dailyLimitBuffer: envInt("DAILY_LIMIT_BUFFER", 50),
};

export function requireClientId(): string {
  if (!CONFIG.clientId) {
    throw new Error(
      "XERO_CLIENT_ID is not set. Copy .env.example to .env and fill it in.",
    );
  }
  return CONFIG.clientId;
}
