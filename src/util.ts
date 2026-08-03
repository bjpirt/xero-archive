/** "Tue 4 Aug, 08:15 BST (in 7h 12m)" — local time plus how long to wait. */
export function formatWhen(date: Date, now = new Date()): string {
  const mins = Math.max(0, Math.round((date.getTime() - now.getTime()) / 60_000));
  const rel = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  const local = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return `${local} (in ${rel})`;
}

/**
 * What to tell the user about coming back. Xero's daily window is a fixed window
 * that resets at a *tenant-specific* time, disclosed only via `Retry-After` on a
 * real 429 — so when we stopped early on our own buffer there is genuinely no time
 * to report, and saying otherwise would be a guess.
 */
export function nextAttemptHint(resetsAt: Date | null): string {
  if (resetsAt) return `Xero says the quota reopens at ${formatWhen(resetsAt)} — re-run after that.`;
  return (
    "Xero only discloses the reset time once the limit is genuinely hit, and the window " +
    "resets at a tenant-specific time, so there's no exact time to give. Re-running is " +
    "safe and cheap — it resumes from disk. Set DAILY_LIMIT_BUFFER=0 to run right up to " +
    "the limit and have Xero report the precise reset time."
  );
}

/** Xero's .NET date form, e.g. "/Date(1585526400000+0000)/". Anchored: only whole values. */
const DOT_NET_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/** Parses Xero's JSON date forms into a Date, or null. Accepts ISO 8601 too. */
export function parseXeroDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const dotNet = value.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (dotNet) {
    const ms = Number(dotNet[1]);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Rewrites a Xero .NET date string as an ISO 8601 UTC timestamp. Anything that
 * isn't one is returned untouched, so this is safe to apply to arbitrary values
 * and idempotent on already-converted data.
 *
 * The trailing offset is deliberately dropped: the epoch is already absolute, and
 * Xero sends "+0000" even for local-date fields like `Date` and `DueDate`.
 */
export function toIsoDate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const m = value.match(DOT_NET_DATE);
  if (!m) return value;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toISOString();
}

/**
 * Deep-converts every .NET date string in a payload to ISO 8601, returning a new
 * structure. Applied at the point records are written so nothing in `data/` keeps
 * Xero's wire format.
 */
export function normaliseDates<T>(value: T): T {
  if (typeof value === "string") return toIsoDate(value) as T;
  if (Array.isArray(value)) return value.map(normaliseDates) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normaliseDates(v);
    }
    return out as T;
  }
  return value;
}
