import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  BROAD_SCOPE_ONLY,
  CONFIG,
  SCOPES,
  SCOPES_OVERRIDDEN,
  TOKENS_FILE,
  XERO,
  requireClientId,
} from "./config";
import { log } from "./log";

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scope: string;
  obtained_at: number; // epoch ms
}

export interface Connection {
  id: string; // connection id
  tenantId: string;
  tenantType: string;
  tenantName: string;
}

/** Where the rotating refresh token lives. A seam so tests never touch the real file. */
export interface TokenStore {
  read(): Promise<TokenSet | null>;
  write(tokens: TokenSet): Promise<void>;
}

/** Default store: `.tokens.json`, mode 600. */
export function fileTokenStore(file = TOKENS_FILE): TokenStore {
  return {
    async read() {
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(await readFile(file, "utf8")) as TokenSet;
      } catch {
        return null; // corrupt file — treat as "not authorised"
      }
    },
    async write(tokens) {
      await writeFile(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    },
  };
}

/** In-memory store, for tests and dry runs. */
export function memoryTokenStore(initial: TokenSet | null = null): TokenStore {
  let held = initial;
  return {
    async read() {
      return held;
    },
    async write(tokens) {
      held = tokens;
    },
  };
}

export interface AuthDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
  tokens: TokenStore;
  /** Opens the consent URL; a no-op is fine, the URL is always printed too. */
  openBrowser: (url: string) => void;
}

// --- PKCE helpers ------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeVerifier(): string {
  return base64url(crypto.randomBytes(64)).slice(0, 96); // 43–128 chars
}

function challengeFor(verifier: string): string {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

/**
 * Xero apps issued a client secret are confidential clients: the token endpoint
 * then requires HTTP Basic auth on top of the PKCE verifier. Apps without a secret
 * authenticate with `client_id` in the body alone.
 */
export function tokenAuth(
  clientId: string,
  clientSecret = CONFIG.clientSecret,
): { headers: Record<string, string>; body: Record<string, string> } {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    return { headers, body: {} };
  }
  return { headers, body: { client_id: clientId } };
}

/** Xero access tokens live 30 min; refresh 60s early to be safe. */
export function toTokenSet(raw: any, now: number): TokenSet {
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at: now + (Number(raw.expires_in) - 60) * 1000,
    scope: raw.scope ?? SCOPES,
    obtained_at: now,
  };
}

function openBrowserDefault(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    /* user can paste the URL manually */
  }
}

export class XeroAuth {
  private readonly deps: AuthDeps;
  private cached: TokenSet | null = null;

  constructor(deps: Partial<AuthDeps> = {}) {
    this.deps = {
      fetch: deps.fetch ?? globalThis.fetch,
      now: deps.now ?? Date.now,
      tokens: deps.tokens ?? fileTokenStore(),
      openBrowser: deps.openBrowser ?? openBrowserDefault,
    };
  }

  // --- scope negotiation -----------------------------------------------------

  /**
   * Asks `/authorize` whether a scope set is acceptable without sending the user
   * anywhere: an acceptable request redirects to Xero's sign-in page, an
   * unacceptable one to `/identity/error`. Read-only and unauthenticated.
   */
  private async scopesAccepted(clientId: string, scopes: string[]): Promise<boolean> {
    const url = new URL(XERO.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", CONFIG.redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", "probe");
    // Any well-formed challenge works; this request is never exchanged for a code.
    url.searchParams.set("code_challenge", challengeFor(makeVerifier()));
    url.searchParams.set("code_challenge_method", "S256");

    const res = await this.deps.fetch(url, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    // Treat anything unrecognised as acceptable, so a change at Xero's end can only
    // cost a clear invalid_scope later, never a silently narrowed archive.
    return !location.includes("/error");
  }

  /**
   * Trims scopes Xero hasn't assigned to this app. Which accounting scopes an app
   * holds varies (granular vs the deprecated broad ones, premium Journals), and one
   * unassigned scope fails the whole sign-in with an `invalid_scope` that doesn't
   * say which. So: try the full set, and only if it's refused find the offenders one
   * at a time and report what the archive will therefore miss.
   */
  async resolveScopes(clientId: string): Promise<string> {
    const wanted = SCOPES.split(" ");
    if (SCOPES_OVERRIDDEN) return SCOPES; // explicit list: the user's call, not ours
    if (await this.scopesAccepted(clientId, wanted)) return SCOPES;

    // Fail loudly rather than dropping everything if the client itself is the problem.
    if (!(await this.scopesAccepted(clientId, ["openid"]))) return SCOPES;

    log.warn("Xero rejected the scope set; checking which scopes your app allows…");
    const granted: string[] = [];
    const denied: string[] = [];
    for (const scope of wanted) {
      // Probe against the base scopes so only one variable changes at a time.
      if (await this.scopesAccepted(clientId, ["openid", "offline_access", scope])) {
        granted.push(scope);
      } else {
        denied.push(scope);
      }
    }
    if (denied.length) {
      log.warn(`Not available to your app: ${denied.join(", ")}`);
      const lost = [
        denied.includes("accounting.transactions.read") && BROAD_SCOPE_ONLY.join(" and "),
        denied.includes("accounting.journals.read") && "the Journals general ledger",
      ].filter(Boolean);
      if (lost.length) log.warn(`${lost.join(", ")} will be skipped during archiving.`);
    }
    if (!granted.some((s) => s.startsWith("accounting."))) {
      throw new Error(
        "Your Xero app has no accounting scopes assigned. Enable them on the app at " +
          "https://developer.xero.com/app/manage, then re-run `npm run auth`.",
      );
    }
    return granted.join(" ");
  }

  // --- tokens ----------------------------------------------------------------

  /** Returns a valid access token, refreshing (and rotating) if at/near expiry. */
  async getAccessToken(): Promise<string> {
    this.cached ??= await this.deps.tokens.read();
    if (!this.cached) throw new Error("Not authorised yet. Run `npm run auth` first.");
    if (this.deps.now() >= this.cached.expires_at) {
      log.info("Access token expired; refreshing…");
      this.cached = await this.refresh(this.cached);
    }
    return this.cached.access_token;
  }

  private async refresh(tokens: TokenSet): Promise<TokenSet> {
    const clientId = requireClientId();
    const auth = tokenAuth(clientId);
    const res = await this.deps.fetch(XERO.tokenUrl, {
      method: "POST",
      headers: auth.headers,
      body: new URLSearchParams({
        ...auth.body,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Token refresh failed (${res.status}): ${await res.text()}\n` +
          "If the refresh token expired (60 days idle), run `npm run auth` again.",
      );
    }
    const next = toTokenSet(await res.json(), this.deps.now());
    await this.deps.tokens.write(next);
    return next;
  }

  /** Lists the Xero organisations this token is connected to. */
  async getConnections(): Promise<Connection[]> {
    const token = await this.getAccessToken();
    const res = await this.deps.fetch(XERO.connectionsUrl, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`GET /connections failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as Connection[];
  }

  // --- interactive login -----------------------------------------------------

  /**
   * Runs the one-time browser consent flow and stores the token set. The throwaway
   * callback server and browser launch are the one part of this module that isn't
   * unit-tested; everything it depends on (scope negotiation, token exchange
   * shaping) is covered separately.
   */
  async login(): Promise<void> {
    const clientId = requireClientId();
    const scopes = await this.resolveScopes(clientId);
    const verifier = makeVerifier();
    const state = base64url(crypto.randomBytes(16));

    const authUrl = new URL(XERO.authorizeUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", CONFIG.redirectUri);
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challengeFor(verifier));
    authUrl.searchParams.set("code_challenge_method", "S256");

    const code = await this.awaitCallback(authUrl, state, scopes);

    const auth = tokenAuth(clientId);
    const res = await this.deps.fetch(XERO.tokenUrl, {
      method: "POST",
      headers: auth.headers,
      body: new URLSearchParams({
        ...auth.body,
        grant_type: "authorization_code",
        code,
        redirect_uri: CONFIG.redirectUri,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) {
      throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
    }
    await this.deps.tokens.write(toTokenSet(await res.json(), this.deps.now()));
    log.ok("Authorised. Tokens saved to .tokens.json");
  }

  /** Spins up a throwaway server on the callback port and resolves with the code. */
  private awaitCallback(authUrl: URL, state: string, scopes: string): Promise<string> {
    const callbackPath = new URL(CONFIG.redirectUri).pathname;
    return new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://localhost:${CONFIG.callbackPort}`);
        if (url.pathname !== callbackPath) {
          res.writeHead(404).end("Not found");
          return;
        }
        const finish = (body: string) => {
          // charset matters: without it the browser reads the UTF-8 "✓" as Latin-1.
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
            `<html><body style="font-family:sans-serif;padding:2rem">${body}</body></html>`,
          );
          setTimeout(() => server.close(), 200);
        };

        const err = url.searchParams.get("error");
        const returnedState = url.searchParams.get("state");
        const authCode = url.searchParams.get("code");

        if (err) {
          finish(`<h2>Authorisation failed</h2><p>${err}</p>`);
          reject(new Error(`Authorization error: ${err}${scopeHint(err, scopes)}`));
        } else if (returnedState !== state) {
          finish("<h2>State mismatch</h2><p>Possible CSRF; aborting.</p>");
          reject(new Error("OAuth state mismatch"));
        } else if (!authCode) {
          finish("<h2>No code returned</h2>");
          reject(new Error("No authorization code in callback"));
        } else {
          finish("<h2>Xero connected ✓</h2><p>You can close this tab and return to the terminal.</p>");
          resolve(authCode);
        }
      });
      server.on("error", reject);
      server.listen(CONFIG.callbackPort, () => {
        log.info(`Waiting for Xero authorisation on ${CONFIG.redirectUri} …`);
        log.info("Opening your browser. If it doesn't open, paste this URL:");
        console.log("\n" + authUrl.toString() + "\n");
        this.deps.openBrowser(authUrl.toString());
      });
    });
  }
}

/** Xero rejects the whole request if any one scope isn't assigned to the app. */
export function scopeHint(error: string, scopes: string): string {
  if (error !== "invalid_scope") return "";
  return (
    `\nYour Xero app isn't assigned one of these scopes:\n  ${scopes}\n` +
    "Enable them on the app at https://developer.xero.com/app/manage, or set\n" +
    "XERO_SCOPES in .env to the subset your app allows."
  );
}
