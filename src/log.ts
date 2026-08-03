/* Tiny leveled logger with a couple of niceties for long-running archival runs. */

const start = Date.now();

function ts(): string {
  const secs = Math.floor((Date.now() - start) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const log = {
  info(msg: string) {
    console.log(`[${ts()}] ${msg}`);
  },
  step(msg: string) {
    console.log(`\n[${ts()}] === ${msg} ===`);
  },
  ok(msg: string) {
    console.log(`[${ts()}] ✓ ${msg}`);
  },
  warn(msg: string) {
    console.warn(`[${ts()}] ! ${msg}`);
  },
  error(msg: string) {
    console.error(`[${ts()}] ✗ ${msg}`);
  },
  /** Overwrites the current line — for progress counters. */
  progress(msg: string) {
    if (process.stdout.isTTY) {
      process.stdout.write(`\r[${ts()}] ${msg}\x1b[K`);
    } else {
      console.log(`[${ts()}] ${msg}`);
    }
  },
  progressDone() {
    if (process.stdout.isTTY) process.stdout.write("\n");
  },
};
