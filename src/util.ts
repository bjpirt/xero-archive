/** Parses Xero's JSON date forms into a Date, or null. */
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
