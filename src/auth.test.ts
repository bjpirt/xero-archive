import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setSilent } from "./log";
import {
  XeroAuth,
  memoryTokenStore,
  scopeHint,
  toTokenSet,
  tokenAuth,
  type TokenSet,
} from "./auth";
import { SCOPES } from "./config";

setSilent(true); // progress chatter would drown the test report

/**
 * `XeroAuth` takes its fetch, clock and token store by injection, so nothing here
 * patches globals or reads/writes the real `.tokens.json`.
 */
const CLIENT_ID = "8DDFC95F7AC444F8918C88625E3F07E1";

/** Xero's authorize endpoint redirects to sign-in when a scope set is acceptable. */
function scopeProbe(isAccepted: (scopes: string[]) => boolean) {
  const probed: string[][] = [];
  const fetchImpl = (async (input: any) => {
    const url = new URL(String(input?.url ?? input));
    const scopes = (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean);
    probed.push(scopes);
    const location = isAccepted(scopes)
      ? "https://login.xero.com/identity/user/login?ReturnUrl=x"
      : "https://login.xero.com/identity/error?errorId=x";
    return new Response(null, { status: 302, headers: { location } });
  }) as typeof globalThis.fetch;
  return { fetchImpl, probed };
}

describe("tokenAuth", () => {
  test("puts client_id in the body when there's no secret", () => {
    const { headers, body } = tokenAuth(CLIENT_ID, "");
    assert.equal(headers.authorization, undefined);
    assert.deepEqual(body, { client_id: CLIENT_ID });
    assert.equal(headers["content-type"], "application/x-www-form-urlencoded");
  });

  test("uses HTTP Basic when the app is a confidential client", () => {
    const { headers, body } = tokenAuth(CLIENT_ID, "s3cret");
    assert.deepEqual(body, {}, "client_id belongs in the Basic header, not the body");
    const decoded = Buffer.from(headers.authorization.replace("Basic ", ""), "base64").toString();
    assert.equal(decoded, `${CLIENT_ID}:s3cret`);
  });
});

describe("toTokenSet", () => {
  test("expires 60 seconds early, to refresh before Xero rejects the token", () => {
    const now = 1_000_000;
    const set = toTokenSet({ access_token: "a", refresh_token: "r", expires_in: 1800 }, now);
    assert.equal(set.expires_at, now + (1800 - 60) * 1000);
    assert.equal(set.obtained_at, now);
  });

  test("falls back to the requested scopes when Xero doesn't echo them", () => {
    assert.equal(toTokenSet({ access_token: "a", refresh_token: "r", expires_in: 1 }, 0).scope, SCOPES);
    const echoed = toTokenSet({ access_token: "a", refresh_token: "r", expires_in: 1, scope: "openid" }, 0);
    assert.equal(echoed.scope, "openid");
  });
});

describe("scopeHint", () => {
  test("explains invalid_scope and lists what was asked for", () => {
    const hint = scopeHint("invalid_scope", "openid accounting.journals.read");
    assert.match(hint, /accounting\.journals\.read/);
    assert.match(hint, /XERO_SCOPES/);
  });

  test("stays quiet for other errors", () => {
    assert.equal(scopeHint("access_denied", "openid"), "");
  });
});

describe("resolveScopes", () => {
  test("makes a single probe and changes nothing when the full set is accepted", async () => {
    const { fetchImpl, probed } = scopeProbe(() => true);
    const auth = new XeroAuth({ fetch: fetchImpl });
    assert.equal(await auth.resolveScopes(CLIENT_ID), SCOPES);
    assert.equal(probed.length, 1, "should not bisect when the whole set is fine");
  });

  test("drops only the scopes the app isn't assigned", async () => {
    // Mirrors a granular-scope app: the deprecated broad scopes and premium Journals
    // are refused, everything else is fine.
    const denied = new Set([
      "accounting.transactions.read",
      "accounting.reports.read",
      "accounting.journals.read",
    ]);
    const { fetchImpl } = scopeProbe((scopes) => !scopes.some((s) => denied.has(s)));
    const auth = new XeroAuth({ fetch: fetchImpl });

    const resolved = (await auth.resolveScopes(CLIENT_ID)).split(" ");
    for (const scope of denied) assert.ok(!resolved.includes(scope), `${scope} should be dropped`);
    assert.ok(resolved.includes("accounting.invoices.read"));
    assert.ok(resolved.includes("offline_access"), "offline_access is needed for a refresh token");
  });

  test("returns the full set untouched when even openid is refused", async () => {
    // That means the *client* is wrong, not the scopes — surfacing Xero's real
    // unauthorized_client error beats reporting "no scopes available".
    const { fetchImpl } = scopeProbe(() => false);
    const auth = new XeroAuth({ fetch: fetchImpl });
    assert.equal(await auth.resolveScopes(CLIENT_ID), SCOPES);
  });

  test("throws when the app has no accounting scopes at all", async () => {
    const { fetchImpl } = scopeProbe((scopes) => !scopes.some((s) => s.startsWith("accounting.")));
    const auth = new XeroAuth({ fetch: fetchImpl });
    await assert.rejects(() => auth.resolveScopes(CLIENT_ID), /no accounting scopes/);
  });

  test("treats an unrecognised redirect as acceptable", async () => {
    // A change at Xero's end should cost a clear invalid_scope later, never a
    // silently narrowed archive.
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: "https://login.xero.com/somewhere-new" } })) as typeof fetch;
    const auth = new XeroAuth({ fetch: fetchImpl });
    assert.equal(await auth.resolveScopes(CLIENT_ID), SCOPES);
  });

  test("probes with PKCE parameters but never exchanges a code", async () => {
    const seen: URL[] = [];
    const fetchImpl = (async (input: any) => {
      seen.push(new URL(String(input?.url ?? input)));
      return new Response(null, { status: 302, headers: { location: "/identity/user/login" } });
    }) as typeof fetch;
    await new XeroAuth({ fetch: fetchImpl }).resolveScopes(CLIENT_ID);
    assert.equal(seen[0].searchParams.get("response_type"), "code");
    assert.equal(seen[0].searchParams.get("code_challenge_method"), "S256");
    assert.ok(seen[0].searchParams.get("code_challenge"));
  });
});

describe("getAccessToken", () => {
  const validToken: TokenSet = {
    access_token: "fresh",
    refresh_token: "r1",
    expires_at: 2_000_000,
    scope: "openid",
    obtained_at: 0,
  };

  test("tells the user to authorise when there are no stored tokens", async () => {
    const auth = new XeroAuth({ tokens: memoryTokenStore(null) });
    await assert.rejects(() => auth.getAccessToken(), /Run `npm run auth`/);
  });

  test("returns the stored token while it's still valid", async () => {
    let fetched = 0;
    const auth = new XeroAuth({
      tokens: memoryTokenStore(validToken),
      now: () => 1_000_000,
      fetch: (async () => {
        fetched++;
        return new Response("{}");
      }) as typeof fetch,
    });
    assert.equal(await auth.getAccessToken(), "fresh");
    assert.equal(fetched, 0, "no refresh needed");
  });

  test("refreshes at expiry and persists the rotated pair", async () => {
    const store = memoryTokenStore({ ...validToken, access_token: "stale", expires_at: 500 });
    const auth = new XeroAuth({
      tokens: store,
      now: () => 1_000_000,
      fetch: (async () =>
        new Response(JSON.stringify({ access_token: "rotated", refresh_token: "r2", expires_in: 1800 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    assert.equal(await auth.getAccessToken(), "rotated");
    const persisted = await store.read();
    assert.equal(persisted?.access_token, "rotated");
    assert.equal(persisted?.refresh_token, "r2", "the rotated refresh token must be saved");
  });

  test("caches within a run rather than re-reading the store", async () => {
    let reads = 0;
    const auth = new XeroAuth({
      now: () => 0,
      tokens: {
        async read() {
          reads++;
          return validToken;
        },
        async write() {},
      },
    });
    await auth.getAccessToken();
    await auth.getAccessToken();
    assert.equal(reads, 1);
  });

  test("explains the 60-day rule when the refresh is rejected", async () => {
    const auth = new XeroAuth({
      tokens: memoryTokenStore({ ...validToken, expires_at: 0 }),
      now: () => 1_000_000,
      fetch: (async () => new Response("invalid_grant", { status: 400 })) as typeof fetch,
    });
    await assert.rejects(() => auth.getAccessToken(), /60 days idle/);
  });
});

describe("getConnections", () => {
  const token: TokenSet = {
    access_token: "a",
    refresh_token: "r",
    expires_at: Number.MAX_SAFE_INTEGER,
    scope: "openid",
    obtained_at: 0,
  };

  test("returns the connection list", async () => {
    const auth = new XeroAuth({
      tokens: memoryTokenStore(token),
      fetch: (async () =>
        new Response(JSON.stringify([{ id: "c1", tenantId: "t1", tenantType: "ORGANISATION", tenantName: "Org" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const conns = await auth.getConnections();
    assert.equal(conns[0].tenantName, "Org");
  });

  test("surfaces the status when the call fails", async () => {
    const auth = new XeroAuth({
      tokens: memoryTokenStore(token),
      fetch: (async () => new Response("nope", { status: 401 })) as typeof fetch,
    });
    await assert.rejects(() => auth.getConnections(), /GET \/connections failed \(401\)/);
  });
});

describe("memoryTokenStore", () => {
  test("round-trips what it's given", async () => {
    const store = memoryTokenStore(null);
    assert.equal(await store.read(), null);
    const set = toTokenSet({ access_token: "a", refresh_token: "r", expires_in: 60 }, 0);
    await store.write(set);
    assert.deepEqual(await store.read(), set);
  });
});
