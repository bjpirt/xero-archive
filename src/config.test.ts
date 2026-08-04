import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { ROOT } from "./config";

const run = promisify(execFile);

/**
 * `config.ts` reads the environment once at import, so these load it in a fresh
 * process with the environment we want rather than mutating `process.env` and
 * fighting module caching. `dotenv` doesn't override variables already set, so the
 * project's own `.env` can't interfere.
 */
async function configValue(expression: string, env: Record<string, string>): Promise<string> {
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", "-e", `import(${JSON.stringify(path.join(ROOT, "src/config.ts"))}).then(c => console.log(${expression}))`],
    { env: { ...process.env, ...env }, cwd: ROOT },
  );
  return stdout.trim();
}

describe("TOKENS_FILE", () => {
  test("defaults to .tokens.json at the project root", async () => {
    assert.equal(
      await configValue("c.TOKENS_FILE", { XERO_TOKENS_FILE: "" }),
      path.join(ROOT, ".tokens.json"),
    );
  });

  test("XERO_TOKENS_FILE resolves relative paths against the project root", async () => {
    // The point of the setting: a second Xero app keeps its own refresh token.
    assert.equal(
      await configValue("c.TOKENS_FILE", { XERO_TOKENS_FILE: ".tokens.app2.json" }),
      path.join(ROOT, ".tokens.app2.json"),
    );
  });

  test("an absolute XERO_TOKENS_FILE is used as given", async () => {
    assert.equal(
      await configValue("c.TOKENS_FILE", { XERO_TOKENS_FILE: "/tmp/elsewhere/.tokens.json" }),
      "/tmp/elsewhere/.tokens.json",
    );
  });
});

describe("blank settings fall back to defaults", () => {
  test("a blank value counts as unset, not as an empty override", async () => {
    // Regression: `XERO_TOKENS_FILE=` used to resolve to the project directory,
    // so writing tokens would have failed with EISDIR.
    assert.equal(
      await configValue("c.TOKENS_FILE", { XERO_TOKENS_FILE: "   " }),
      path.join(ROOT, ".tokens.json"),
    );
    assert.equal(
      await configValue("c.CONFIG.redirectUri", { XERO_REDIRECT_URI: "" }),
      "http://localhost:5173/callback",
    );
  });
});

describe("SCOPES", () => {
  test("defaults to the granular read-only set plus the legacy fallbacks", async () => {
    const scopes = (await configValue("c.SCOPES", { XERO_SCOPES: "" })).split(" ");
    assert.ok(scopes.includes("offline_access"), "needed for a refresh token");
    assert.ok(scopes.includes("accounting.invoices.read"));
    assert.ok(scopes.includes("accounting.transactions.read"), "legacy fallback for Receipts");
    assert.equal(await configValue("c.SCOPES_OVERRIDDEN", { XERO_SCOPES: "" }), "false");
  });

  test("XERO_SCOPES is taken verbatim, accepting commas or whitespace", async () => {
    assert.equal(
      await configValue("c.SCOPES", { XERO_SCOPES: "openid, profile  accounting.contacts.read" }),
      "openid profile accounting.contacts.read",
    );
    assert.equal(
      await configValue("c.SCOPES_OVERRIDDEN", { XERO_SCOPES: "openid" }),
      "true",
      "an explicit list must skip scope negotiation",
    );
  });
});

describe("CONFIG", () => {
  test("booleans accept true/1/yes and default sensibly", async () => {
    assert.equal(await configValue("c.CONFIG.includeHistory", { INCLUDE_HISTORY: "yes" }), "true");
    assert.equal(await configValue("c.CONFIG.includeHistory", { INCLUDE_HISTORY: "1" }), "true");
    assert.equal(await configValue("c.CONFIG.includeHistory", { INCLUDE_HISTORY: "false" }), "false");
    assert.equal(await configValue("c.CONFIG.skipAttachments", { SKIP_ATTACHMENTS: "" }), "false");
  });

  test("a non-numeric integer setting falls back rather than becoming NaN", async () => {
    assert.equal(await configValue("c.CONFIG.dailyLimitBuffer", { DAILY_LIMIT_BUFFER: "lots" }), "50");
    assert.equal(await configValue("c.CONFIG.dailyLimitBuffer", { DAILY_LIMIT_BUFFER: "0" }), "0");
  });

  test("REPORT_PERIOD only accepts year or month", async () => {
    assert.equal(await configValue("c.CONFIG.reportPeriod", { REPORT_PERIOD: "month" }), "month");
    assert.equal(await configValue("c.CONFIG.reportPeriod", { REPORT_PERIOD: "nonsense" }), "year");
  });
});
