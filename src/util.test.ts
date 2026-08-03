import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatWhen, nextAttemptHint, normaliseDates, parseXeroDate, toIsoDate } from "./util";

describe("parseXeroDate", () => {
  test("parses Xero's .NET form", () => {
    assert.equal(parseXeroDate("/Date(1585526400000+0000)/")?.toISOString(), "2020-03-30T00:00:00.000Z");
  });

  test("ignores the trailing offset — the epoch is already absolute", () => {
    const withOffset = parseXeroDate("/Date(1585526400000+1300)/");
    const without = parseXeroDate("/Date(1585526400000)/");
    assert.deepEqual(withOffset, without);
  });

  test("handles pre-epoch dates", () => {
    assert.equal(parseXeroDate("/Date(-86400000+0000)/")?.toISOString(), "1969-12-31T00:00:00.000Z");
  });

  test("accepts ISO 8601, so migrated archives still read", () => {
    assert.equal(parseXeroDate("2020-03-30T00:00:00.000Z")?.toISOString(), "2020-03-30T00:00:00.000Z");
  });

  test("returns null for anything unparseable", () => {
    for (const bad of ["", "not a date", null, undefined, 42, {}, []]) {
      assert.equal(parseXeroDate(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("toIsoDate", () => {
  test("converts the .NET form to ISO 8601 UTC", () => {
    assert.equal(toIsoDate("/Date(1585526400000+0000)/"), "2020-03-30T00:00:00.000Z");
  });

  test("is idempotent, so re-running the migration is safe", () => {
    const once = toIsoDate("/Date(1585526400000+0000)/");
    assert.equal(toIsoDate(once), once);
  });

  test("leaves non-date strings untouched", () => {
    // Deliberately close to the pattern: the regex is anchored, so these must survive.
    for (const s of ["Date(123)", "/Date(abc)/", "prefix /Date(1)/", "/Date(1)/ suffix", "", "INV-001"]) {
      assert.equal(toIsoDate(s), s, `mangled ${JSON.stringify(s)}`);
    }
  });

  test("passes non-strings straight through", () => {
    assert.equal(toIsoDate(42), 42);
    assert.equal(toIsoDate(null), null);
    assert.equal(toIsoDate(undefined), undefined);
    assert.equal(toIsoDate(true), true);
  });
});

describe("normaliseDates", () => {
  test("rewrites dates at any depth, in objects and arrays alike", () => {
    const input = {
      Date: "/Date(0+0000)/",
      Contact: { Name: "Acme", UpdatedDateUTC: "/Date(1000+0000)/" },
      LineItems: [{ Tracking: [{ When: "/Date(2000+0000)/" }] }],
    };
    assert.deepEqual(normaliseDates(input), {
      Date: "1970-01-01T00:00:00.000Z",
      Contact: { Name: "Acme", UpdatedDateUTC: "1970-01-01T00:00:01.000Z" },
      LineItems: [{ Tracking: [{ When: "1970-01-01T00:00:02.000Z" }] }],
    });
  });

  test("preserves non-date values and structure", () => {
    const input = { n: 1, b: false, nil: null, s: "hello", arr: [1, "two", null] };
    assert.deepEqual(normaliseDates(input), input);
  });

  test("does not mutate its input", () => {
    const input = { Date: "/Date(0+0000)/" };
    normaliseDates(input);
    assert.equal(input.Date, "/Date(0+0000)/");
  });

  test("handles a bare string or primitive", () => {
    assert.equal(normaliseDates("/Date(0+0000)/"), "1970-01-01T00:00:00.000Z");
    assert.equal(normaliseDates(7), 7);
    assert.equal(normaliseDates(null), null);
  });
});

describe("formatWhen", () => {
  const now = new Date("2026-08-03T12:00:00Z");

  test("reports hours and minutes remaining", () => {
    const later = new Date("2026-08-03T19:15:00Z");
    assert.match(formatWhen(later, now), /\(in 7h 15m\)/);
  });

  test("drops the hours part under an hour", () => {
    assert.match(formatWhen(new Date("2026-08-03T12:42:00Z"), now), /\(in 42m\)/);
  });

  test("never reports negative time for a past date", () => {
    assert.match(formatWhen(new Date("2026-08-03T11:00:00Z"), now), /\(in 0m\)/);
  });
});

describe("nextAttemptHint", () => {
  test("quotes Xero's reset time when it gave us one", () => {
    const hint = nextAttemptHint(new Date(Date.now() + 3_600_000));
    assert.match(hint, /quota reopens at/);
    assert.match(hint, /in 1h 0m/);
  });

  test("admits the time is unknown when we stopped on our own buffer", () => {
    const hint = nextAttemptHint(null);
    // Must not imply a specific time — the window is tenant-specific.
    assert.doesNotMatch(hint, /reopens at/);
    assert.match(hint, /tenant-specific/);
    assert.match(hint, /DAILY_LIMIT_BUFFER=0/);
  });
});
