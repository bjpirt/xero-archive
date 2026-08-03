import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { log, setSilent } from "./log";

/** Captures console output for the duration of one call. */
function captured(fn: () => void): string[] {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const collect = (...args: unknown[]) => void lines.push(args.join(" "));
  console.log = collect;
  console.warn = collect;
  console.error = collect;
  try {
    fn();
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

afterEach(() => setSilent(true)); // the rest of the suite expects silence

describe("log", () => {
  test("stamps each line with elapsed time and a level marker", () => {
    setSilent(false);
    const lines = captured(() => {
      log.info("plain");
      log.ok("done");
      log.warn("careful");
      log.error("broken");
    });
    assert.match(lines[0], /^\[\d\d:\d\d\] plain$/);
    assert.match(lines[1], /^\[\d\d:\d\d\] ✓ done$/);
    assert.match(lines[2], /^\[\d\d:\d\d\] ! careful$/);
    assert.match(lines[3], /^\[\d\d:\d\d\] ✗ broken$/);
  });

  test("silencing suppresses every level", () => {
    setSilent(true);
    const lines = captured(() => {
      log.info("a");
      log.step("b");
      log.ok("c");
      log.warn("d");
      log.error("e");
      log.progress("f");
      log.progressDone();
    });
    assert.deepEqual(lines, []);
  });
});
