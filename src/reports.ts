import { request, XeroHttpError, apiUsage } from "./client";
import { CONFIG } from "./config";
import { Store } from "./store";
import { log } from "./log";
import { parseXeroDate } from "./util";

/** Scans archived transactions to find the earliest financial year present. */
async function earliestYear(store: Store): Promise<number> {
  if (CONFIG.reportFromYear > 0) return CONFIG.reportFromYear;
  let min: Date | null = null;
  const consider = (v: unknown) => {
    const d = parseXeroDate(v);
    if (d && (!min || d < min)) min = d;
  };
  for (const inv of await store.readEntity("Invoices")) consider(inv.Date);
  for (const tx of await store.readEntity("BankTransactions")) consider(tx.Date);
  for (const j of await store.readEntity("Journals")) consider(j.JournalDate);
  const fallback = new Date().getUTCFullYear() - 7;
  return min ? (min as Date).getUTCFullYear() : fallback;
}

interface Period {
  label: string;
  fromDate: string;
  toDate: string;
  asAt: string;
}

function periodsFor(fromYear: number, granularity: "year" | "month"): Period[] {
  const now = new Date();
  const thisYear = now.getUTCFullYear();
  const out: Period[] = [];
  for (let y = fromYear; y <= thisYear; y++) {
    if (granularity === "year") {
      out.push({ label: String(y), fromDate: `${y}-01-01`, toDate: `${y}-12-31`, asAt: `${y}-12-31` });
    } else {
      for (let m = 1; m <= 12; m++) {
        if (y === thisYear && m > now.getUTCMonth() + 1) break;
        const mm = String(m).padStart(2, "0");
        const end = new Date(Date.UTC(y, m, 0)).getUTCDate(); // last day of month
        out.push({
          label: `${y}-${mm}`,
          fromDate: `${y}-${mm}-01`,
          toDate: `${y}-${mm}-${end}`,
          asAt: `${y}-${mm}-${end}`,
        });
      }
    }
  }
  return out;
}

/**
 * Snapshots Profit & Loss (period), Balance Sheet and Trial Balance (as-at)
 * for every period. Each needs the "reports" user role plus its own granular scope;
 * a 403 skips that one kind, not the whole pass.
 */
export async function archiveReports(store: Store): Promise<void> {
  log.step("Reports (P&L, Balance Sheet, Trial Balance)");
  const fromYear = await earliestYear(store);
  const periods = periodsFor(fromYear, CONFIG.reportPeriod);
  log.info(`Snapshotting ${periods.length} period(s) from ${fromYear} (${CONFIG.reportPeriod}).`);

  // Each report now has its own granular scope, so one being unavailable must not
  // cost us the others. Give up on a kind after its first 403 rather than
  // re-requesting it for every remaining period.
  const forbidden = new Set<string>();

  const pull = async (kind: string, path: string, query: Record<string, string>, label: string) => {
    if (forbidden.has(kind)) return;
    log.progress(`reports: ${kind} ${label}${apiUsage()}`);
    try {
      const res = await request(store.tenantId, path, { query });
      const report = res.json?.Reports?.[0] ?? res.json;
      await store.writeReport(kind, label, report);
    } catch (e) {
      if (!(e instanceof XeroHttpError) || (e.status !== 403 && e.status !== 401)) throw e;
      forbidden.add(kind);
      log.progressDone();
      log.warn(
        `${kind}: ${e.status} — needs the "reports" user role on the authorising ` +
          "account and the matching report scope on your Xero app — skipped.",
      );
    }
  };

  for (const p of periods) {
    await pull("profit-and-loss", "/Reports/ProfitAndLoss", { fromDate: p.fromDate, toDate: p.toDate }, p.label);
    await pull("balance-sheet", "/Reports/BalanceSheet", { date: p.asAt }, p.label);
    await pull("trial-balance", "/Reports/TrialBalance", { date: p.asAt }, p.label);
    if (forbidden.size === 3) break;
  }
  log.progressDone();
  if (forbidden.size === 3) log.warn("No reports available — skipped.");
  else log.ok(`Reports snapshotted for ${periods.length} period(s)`);
}
