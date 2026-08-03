/* Tiny leveled logger with a couple of niceties for long-running archival runs. */

const start = Date.now();

/**
 * Output is suppressed while silenced. Tests turn this on so a run's progress
 * chatter doesn't drown the test report; `LOG_LEVEL=silent` does the same for a
 * scripted run.
 */
let silenced = process.env.LOG_LEVEL === "silent";

export function setSilent(value: boolean): void {
  silenced = value;
}

function ts(): string {
  const secs = Math.floor((Date.now() - start) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const log = {
  info(msg: string) {
    if (!silenced) console.log(`[${ts()}] ${msg}`);
  },
  step(msg: string) {
    if (!silenced) console.log(`\n[${ts()}] === ${msg} ===`);
  },
  ok(msg: string) {
    if (!silenced) console.log(`[${ts()}] ✓ ${msg}`);
  },
  warn(msg: string) {
    if (!silenced) console.warn(`[${ts()}] ! ${msg}`);
  },
  error(msg: string) {
    if (!silenced) console.error(`[${ts()}] ✗ ${msg}`);
  },
  /** Overwrites the current line — for progress counters. */
  progress(msg: string) {
    if (silenced) return;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r[${ts()}] ${msg}\x1b[K`);
    } else {
      console.log(`[${ts()}] ${msg}`);
    }
  },
  progressDone() {
    if (!silenced && process.stdout.isTTY) process.stdout.write("\n");
  },
};
