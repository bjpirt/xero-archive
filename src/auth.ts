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

interface TokenSet {
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

// --- Scope negotiation -------------------------------------------------------

/**
 * Asks `/authorize` whether a scope set is acceptable, without sending the user
 * anywhere: an acceptable request redirects to Xero's sign-in page, an
 * unacceptable one to `/identity/error`. Read-only and unauthenticated.
 */
async function scopesAccepted(clientId: string, scopes: string[]): Promise<boolean> {
  const url = new URL(XERO.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", CONFIG.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", "probe");
  // Any well-formed challenge works; we never exchange this request for a code.
  url.searchParams.set("code_challenge", challengeFor(makeVerifier()));
  url.searchParams.set("code_challenge_method", "S256");

  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  // Treat anything we don't recognise as acceptable so a Xero change can only
  // cost us a clear invalid_scope later, never a silently narrowed archive.
  return !location.includes("/error");
}

/**
 * Trims scopes Xero hasn't assigned to this app. Which accounting scopes an app
 * holds now varies (granular vs the deprecated broad ones, premium Journals), and
 * one unassigned scope fails the whole sign-in with an `invalid_scope` that
 * doesn't say which. So: try the full set, and only if it's refused find the
 * offenders one at a time and report what the archive will therefore miss.
 */
export async function resolveScopes(clientId: string): Promise<string> {
  const wanted = SCOPES.split(" ");
  if (SCOPES_OVERRIDDEN) return SCOPES; // explicit list: the user's call, not ours
  if (await scopesAccepted(clientId, wanted)) return SCOPES;

  // Fail loudly rather than dropping everything if the client itself is the problem.
  if (!(await scopesAccepted(clientId, ["openid"]))) return SCOPES;

  log.warn("Xero rejected the scope set; checking which scopes your app allows…");
  const granted: string[] = [];
  const denied: string[] = [];
  for (const scope of wanted) {
    // Probe each against the base scopes so we test one variable at a time.
    if (await scopesAccepted(clientId, ["openid", "offline_access", scope])) granted.push(scope);
    else denied.push(scope);
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

/**
 * Xero apps that were issued a client secret are confidential clients: the token
 * endpoint then requires HTTP Basic auth on top of the PKCE verifier. Apps
 * without a secret authenticate with `client_id` in the body alone.
 */
function tokenAuth(clientId: string): { headers: Record<string, string>; body: Record<string, string> } {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (CONFIG.clientSecret) {
    const basic = Buffer.from(`${clientId}:${CONFIG.clientSecret}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
    return { headers, body: {} };
  }
  return { headers, body: { client_id: clientId } };
}

// --- Token persistence -------------------------------------------------------

async function saveTokens(t: TokenSet): Promise<void> {
  await writeFile(TOKENS_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
}

async function loadTokens(): Promise<TokenSet | null> {
  if (!existsSync(TOKENS_FILE)) return null;
  try {
    return JSON.parse(await readFile(TOKENS_FILE, "utf8")) as TokenSet;
  } catch {
    return null;
  }
}

function toTokenSet(raw: any): TokenSet {
  const now = Date.now();
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    // Xero access tokens live 30 min; refresh 60s early to be safe.
    expires_at: now + (Number(raw.expires_in) - 60) * 1000,
    scope: raw.scope ?? SCOPES,
    obtained_at: now,
  };
}

// --- Interactive PKCE login --------------------------------------------------

/** Runs the one-time browser consent flow and stores the token set. */
export async function login(): Promise<void> {
  const clientId = requireClientId();
  const scopes = await resolveScopes(clientId);
  const verifier = makeVerifier();
  const challenge = challengeFor(verifier);
  const state = base64url(crypto.randomBytes(16));

  const authUrl = new URL(XERO.authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", CONFIG.redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const callbackPath = new URL(CONFIG.redirectUri).pathname;

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CONFIG.callbackPort}`);
      if (url.pathname !== callbackPath) {
        res.writeHead(404).end("Not found");
        return;
      }
      const returnedState = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      const authCode = url.searchParams.get("code");

      const finish = (body: string) => {
        // charset matters: without it the browser reads the UTF-8 "✓" as Latin-1.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
          `<html><body style="font-family:sans-serif;padding:2rem">${body}</body></html>`,
        );
        setTimeout(() => server.close(), 200);
      };

      if (err) {
        finish(`<h2>Authorisation failed</h2><p>${err}</p>`);
        // Xero rejects the whole request if any one scope isn't assigned to the app.
        const hint =
          err === "invalid_scope"
            ? `\nYour Xero app isn't assigned one of these scopes:\n  ${scopes}\n` +
              "Enable them on the app at https://developer.xero.com/app/manage, or set\n" +
              "XERO_SCOPES in .env to the subset your app allows."
            : "";
        reject(new Error(`Authorization error: ${err}${hint}`));
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
      openBrowser(authUrl.toString());
    });
  });

  const auth = tokenAuth(clientId);
  const res = await fetch(XERO.tokenUrl, {
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
  await saveTokens(toTokenSet(await res.json()));
  log.ok("Authorised. Tokens saved to .tokens.json");
}

async function refresh(tokens: TokenSet): Promise<TokenSet> {
  const clientId = requireClientId();
  const auth = tokenAuth(clientId);
  const res = await fetch(XERO.tokenUrl, {
    method: "POST",
    headers: auth.headers,
    body: new URLSearchParams({
      ...auth.body,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Token refresh failed (${res.status}): ${body}\n` +
        "If the refresh token expired (60 days idle), run `npm run auth` again.",
    );
  }
  const next = toTokenSet(await res.json());
  await saveTokens(next);
  return next;
}

let cached: TokenSet | null = null;

/** Returns a valid access token, refreshing (and rotating) if near expiry. */
export async function getAccessToken(): Promise<string> {
  if (!cached) {
    cached = await loadTokens();
    if (!cached) {
      throw new Error("Not authorised yet. Run `npm run auth` first.");
    }
  }
  if (Date.now() >= cached.expires_at) {
    log.info("Access token expired; refreshing…");
    cached = await refresh(cached);
  }
  return cached.access_token;
}

/** Lists the Xero organisations this token is connected to. */
export async function getConnections(): Promise<Connection[]> {
  const token = await getAccessToken();
  const res = await fetch(XERO.connectionsUrl, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /connections failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as Connection[];
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* user can paste the URL manually */
  }
}
