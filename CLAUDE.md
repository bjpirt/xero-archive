# CLAUDE.md

Guidance for working in this repository.

## What this is

A personal tool that extracts and archives historical financial data from the **Xero
Accounting API** to local JSON, downloads all attachments, and generates a self-contained,
browsable HTML microsite. Read-only against Xero. Designed for a single user archiving their
own organisation(s), re-runnable incrementally.

The four design decisions that shaped it: **Node/TypeScript**, **PKCE auth** (free, no
secret), **archive everything** (all endpoints + attachments + history + reports), and
**incremental re-runs**.

## Commands

```bash
npm install
npm run auth        # one-time PKCE browser sign-in; writes .tokens.json
npm run archive     # pull data + attachments (+ reports) into data/  (incremental)
npm run history     # resumable History & Notes backfill for every document
npm run adopt-attachments   # offline: mark already-downloaded attachments complete
npm run site        # generate the microsite into site/
npm run serve       # static server for site/ + data/, opens the browser
npm run all         # archive + site + serve
npm run typecheck   # tsc --noEmit  (there is no build step — tsx runs TS directly)
npm test            # node:test via tsx
npm run test:watch  # same, in watch mode
npm run test:coverage
npm run check       # typecheck + test — run this before finishing
```

`npm run history -- --refresh` re-fetches all history from scratch.

There is **no compile step** — everything runs through `tsx`. Tests use **Node's built-in
runner** (`node:test` + `node:assert/strict`) executed through `tsx`, so the test framework adds
**zero dependencies**. Don't introduce Vitest or Jest: the minimal-dependency rule below applies
to dev dependencies too, and `node --import tsx --test` already gives globs, watch mode, a spec
reporter and coverage.

## Runtime & conventions

- **ESM + TypeScript run directly via `tsx`.** `package.json` has `"type": "module"`,
  `tsconfig` uses `moduleResolution: "Bundler"`, so imports are **extensionless**
  (`import { x } from "./config"`, not `"./config.js"`). Do not add `.js`/`.ts` extensions.
- **Node ≥ 20, built-in `fetch`.** No HTTP client library.
- **No Xero SDK.** We call the REST API with raw `fetch` for full control over rate limiting
  and storage. Do not introduce `xero-node`.
- **Minimal dependencies.** Runtime dep is only `dotenv`. Keep it that way unless there's a
  strong reason — prefer Node built-ins (`node:http`, `node:crypto`, `node:fs/promises`).
- Strict TypeScript is on (`noUnusedLocals`/`noUnusedParameters`). Match the existing style:
  small focused modules, `async`/`await`, early returns, terse comments explaining *why*.
- Logging goes through `src/log.ts` (`log.info/step/ok/warn/error/progress`). Don't
  `console.log` directly in the archival code.

## Architecture & data flow

```
cli.ts ──► auth.ts        PKCE login, token store, silent refresh, GET /connections
       ├─► archive.ts     orchestration: records → journals → reports → attachments → history
       │     ├─ endpoints.ts   declarative catalog of every resource
       │     ├─ client.ts      rate-limited fetch + pagination (429/5xx retry)
       │     ├─ store.ts       filesystem writes + disk-derived resume points
       │     └─ reports.ts     P&L / Balance Sheet / Trial Balance snapshots
       ├─► site.ts        reads data/ → generates site/ (+ copies assets/)
       │     └─ assets/app.js, assets/style.css   client-side SPA
       └─► serve.ts       static server rooted at project root, guarded to site/ + data/
```

`src/util.ts` holds shared helpers (Xero date parsing, money/HTML formatting).

**Phase order is deliberate and load-bearing.** `archiveTenant` runs *all* record lists, then
Journals, then reports, and only then attachments (and inline history last). A record list is
~1 call per 1000 records; an attachment list is 1 call *per document*. Interleaving them — as
earlier versions did, inside `archiveEndpoint`'s page handler — meant one entity's attachments
could burn the whole daily quota before later entities were even listed. The attachment and
history passes read records back off disk (`store.readEntity`), so they're independent of the
record pass and resume on their own. `--skip-attachments` / `--attachments-only`
(`CONFIG.skipAttachments` / `attachmentsOnly`) split the phases across daily quotas.

**The endpoint catalog (`endpoints.ts`) drives everything.** To add or change what gets
archived, edit that catalog — `archive.ts` and `site.ts` iterate it. Each entry declares
`path`, `arrayKey` (the JSON array key in the response), `idField`, and booleans `paged`,
`attachments`, `history`.

## Storage layout

```
data/<OrgName>_<tenant8>/
  raw/
    organisation.json
    <Entity>/<id>.json            one file per record (e.g. Invoices/<InvoiceID>.json)
    Journals/<JournalNumber>.json
    _history/<Entity>/<id>.json   audit trail marker (always written, may be [])
    _attachments/<Entity>/<id>.json  {updatedDateUTC, files} — lets re-runs skip the list call
  attachments/<Entity>/<id>/<filename>
  reports/<kind>/<label>.json
site/
  index.html                      landing (all orgs)
  assets/style.css, app.js        copied from src/assets/ at generation time
  <OrgName>_<tenant8>/
    index.html                    SPA shell
    data/manifest.json, <Entity>.json, ...   generated for the browser
```

- The tenant folder name is `slug(name)_<first 8 chars of tenantId>` — computed in
  `Store`'s constructor. `site/` reuses the **exact same** folder basename so the two pair up.
- `data/` and `site/` are git-ignored, as are `.env` and `.tokens.json`.

### Stateless resume (disk is the only source of truth)

There is **no state file**. Every resume point is derived from what's already on disk, so an
interrupted run resumes just by re-running it, and deleting a stray file can't corrupt state:

- **Record lists** are always re-pulled in full each run. Writes are idempotent (same
  `<id>.json` overwritten), so a re-run refills gaps and refreshes statuses. List calls are
  cheap (1 per 1000 records) and — unlike `If-Modified-Since`, which Xero documents as missing
  some edits — a full re-pull can't leave a permanent gap.
- **Journals** resume from `store.maxJournalNumber()` (highest `<JournalNumber>.json` on disk).
- **Attachments** are de-duplicated by file existence (`store.hasAttachment(...)`), and the
  per-document *list* call is skipped via a marker at `raw/_attachments/<Entity>/<id>.json`
  recording `{updatedDateUTC, files}`. `store.attachmentsComplete()` demands all three: marker
  present, every recorded file still on disk, and the record's `UpdatedDateUTC` unchanged (a
  touched document may have gained attachments). The marker is written **only after every file
  is on disk**, so unlike `_history` it means "complete", never "attempted" — an interrupted
  download therefore re-lists next run. `--refresh-attachments` bypasses it.
  `adoptAttachments()` backfills markers for attachments downloaded before markers existed;
  it makes no API calls so it can't verify completeness, and deliberately leaves the
  newest-mtime document per entity unmarked (the one an interrupted run may have left partial).
- **History** is de-duplicated by file existence (`store.hasHistory(...)`). Crucially,
  `writeHistory` **always writes a file even for empty history** (`[]`), so "attempted" is
  visible on disk — otherwise no-history docs would be re-fetched every run.

The daily-limit stop/resume still works: `DailyLimitReached` just stops the run; because each
record/attachment/history file is written as it's fetched, the next run picks up from disk.

`Store.fromDir(dir)` reconstructs a Store from an existing directory for the offline `site`
command (reads the org name from `raw/organisation.json`; tenantId isn't needed offline).

## Xero API domain knowledge (important gotchas)

- **Dates are .NET style:** `"/Date(1672531200000+0000)/"`. Always parse via
  `parseXeroDate()` in `util.ts` (and its JS twin in `app.js`). Never `new Date(value)`
  directly on Xero fields.
- **No "Bills" endpoint** — bills are Invoices with `Type=ACCPAY`; sales are `ACCREC`. Same
  for credit notes.
- **Pagination:** `?page=N&pageSize=1000` (max 1000). Use the response `pagination` object
  (`pageCount`) to stop — `client.ts`'s `paginate()` handles this. `304 Not Modified` means
  nothing changed.
- **Journals** paginate differently: `?offset=<JournalNumber>`, 100 max, oldest→newest. Only
  an **empty** response means done (a short page does not). Journals is a **premium
  (Advanced-tier) endpoint** needing a security assessment — expect `403`, which we skip
  gracefully.
- **Reports** and Manual Journals need the authorising user's **"reports" role** — expect
  `403`, skipped with a warning.
- **Rate limits (per org):** 60 calls/min, 5 concurrent, 1,000/day (Starter) or 5,000/day
  (Core+). `client.ts` throttles minute+concurrency and honours `Retry-After` on 429. When
  `X-DayLimit-Remaining` approaches `DAILY_LIMIT_BUFFER`, `archive.ts`/backfill throw
  `DailyLimitReached` and stop cleanly; because progress is on disk, the next run resumes.
  **Preserve this resumability** in any change to the fetch loops — write each file as it's
  fetched, and never rely on end-of-run bookkeeping.
- `X-DayLimit-Remaining` must only be trusted **when the header is present** — `Number(null)`
  is `0` and `Number.isFinite(0)` is true, so a response omitting it (binary attachment
  downloads may) would clamp `dayLimitRemaining` to 0 and abort the run with a bogus
  "daily limit reached". `client.ts` null-checks the raw header first; keep that.
- **The daily window resets at a *tenant-specific* time** — it is **not** midnight UTC and
  cannot be computed. Xero reveals it only via `Retry-After` on a real 429. So
  `DailyLimitReached` (defined in `client.ts`) carries an optional `resetsAt`, `client.ts`
  **throws instead of sleeping** when `X-Rate-Limit-Problem` is `daily` (a multi-hour sleep
  reads as a hang), and `nextAttemptHint()` in `util.ts` says the time is unknown when we
  stopped on our own `DAILY_LIMIT_BUFFER` rather than inventing one. Note the header value is
  `daily`, which does **not** contain the substring "day" — match it carefully.
- **Attachments:** list via `GET /{Entity}/{id}/Attachments` (only when the record's
  `HasAttachments === true`), download the raw bytes via
  `GET /{Entity}/{id}/Attachments/{filename}` with `Accept: */*`. There is no bulk listing, so
  the list call is one per attachment-bearing document — the dominant cost on a re-run, hence
  the `_attachments` marker.
- **History has no bulk endpoint** — one call per document. That's why it's off by default in
  the main archive and lives in the separate resumable `npm run history` pass.

## Auth notes

- PKCE. `npm run auth` spins up a throwaway `node:http` server on
  `AUTH_CALLBACK_PORT` to catch the redirect, exchanges the code, stores a **rotating**
  refresh token in `.tokens.json` (mode 600).
- A Xero "Web app" is a **confidential client**: it must have a secret generated (otherwise
  `/authorize` returns `unauthorized_client`), and the token endpoint needs HTTP Basic auth.
  `tokenAuth()` in `auth.ts` adds it when `XERO_CLIENT_SECRET` is set and falls back to
  PKCE-only (`client_id` in the body) when it isn't — keep both paths working.
- **Scopes are per-app and negotiated at login.** Xero is replacing the broad accounting
  scopes with granular ones; since March 2026 every web/PKCE app has granular scopes, and the
  broad ones survive only on apps that already had them (until Sept 2027). `config.ts`
  therefore requests `GRANULAR_SCOPES` plus the two `LEGACY_SCOPES` — the deprecated
  `accounting.transactions.read` is the *only* scope that reaches Receipts and ExpenseClaims.
- Since no app holds all of them and Xero fails the entire authorize request with
  `invalid_scope` (without saying which scope), `resolveScopes()` in `auth.ts` probes
  `/authorize` before opening the browser: accepted → redirect to the login page, rejected →
  redirect to `/identity/error`. It tries the full set first and only bisects if that's
  refused, treats an unrecognised redirect as accepted, and bails out rather than trimming
  when even `openid` alone is refused (that means the *client* is wrong, not the scopes).
  `XERO_SCOPES` pins an exact list and skips negotiation. Don't make this heuristic
  load-bearing on the happy path.
- **Tokens are bound to the app that issued them.** API calls are authorised by the stored bearer
  token, *not* by `XERO_CLIENT_ID` — so swapping the client id while reusing one token file would
  keep spending the previous app's quota for the ~30 minutes the access token stays valid, then
  fail refresh with a misleading "expired" message. `TokenSet.client_id` records the issuer and
  `appMismatch()` refuses the mismatch; `XERO_TOKENS_FILE` gives each app its own store.
  `client_id` is optional because token files written before this existed lack it — treat absent
  as "can't tell, allow it", never as a failure.
- Rate limits are per **(app, tenant)** pair, but Xero caps an organisation at **two uncertified
  apps**, so multiple apps buy at most 2× the daily quota.
- **Refresh tokens expire after 60 days of inactivity** → user re-runs `npm run auth`.
  Access tokens (30 min) refresh automatically mid-run (`getAccessToken()` refreshes ~60s
  before expiry and persists the rotated pair).
- The redirect URI in `.env` must exactly match the one registered on the Xero app, and its
  port must equal `AUTH_CALLBACK_PORT`.

## Architecture: dependency injection, not global patching

The I/O seams are **constructor-injected**, and that's deliberate — tests must never patch
globals (`globalThis.fetch = …`) or reach for a mocking library.

- **`XeroClient`** (`client.ts`) takes `{ fetch, sleep, now, getAccessToken }`, all defaulted to
  the real thing. `sleep` and `now` are what make the rate limiter and retry backoffs testable:
  a test's `sleep` advances its fake clock instead of waiting, so the 60-calls-per-minute window
  is exercised in microseconds. Call counters and the lowest observed daily quota are **instance**
  state (they were module-level `let`s, which leaked between tests and between runs in a process).
- **`XeroAuth`** (`auth.ts`) takes `{ fetch, now, tokens, openBrowser }`. `tokens` is a
  `TokenStore` — `fileTokenStore()` in production, `memoryTokenStore()` in tests, so no test can
  touch the real `.tokens.json`. `getAccessToken` is injected *into* the client, which also breaks
  the auth↔client import cycle.
- **`Archiver`** (`archive.ts`) takes `{ client, auth, options, createStore }`. `options` is an
  `ArchiveOptions` snapshot rather than reads of `CONFIG`, so tests vary behaviour without
  touching `process.env`; `createStore` lets them archive into a temp directory.
- **`cli.ts` is the composition root** — the single place real dependencies are wired together
  (`buildArchiver()`). Keep it that way: modules receive collaborators, they don't reach for them.
- `store.ts` is deliberately *not* abstracted behind an fs interface. Disk **is** the archive's
  state, so tests use a real temp directory (`Store`'s third constructor arg) — faking `fs` would
  only test the fake.
- `log.setSilent(true)` suppresses output; test files call it so progress chatter doesn't drown
  the report. `LOG_LEVEL=silent` does the same for a scripted run.

## Testing

**Always run `npm run check` (typecheck + tests) before considering any work complete.** Not
"when it seems risky" — every time, including for changes that look trivial or documentation-only.
If a change makes a test fail, decide which is wrong and fix that; never leave a failing or
skipped test behind. If you change behaviour deliberately, update the test in the same change.
New behaviour needs a test that would fail without it.

Tests live beside their subject as `src/*.test.ts`. Coverage sits around 96% of lines;
`npm run test:coverage` prints the table.

What's deliberately **not** covered, and why:

- `XeroAuth.login()`'s callback server and browser launch — needs a real socket and a browser.
  Everything it depends on (scope negotiation, `tokenAuth`, `toTokenSet`, `scopeHint`) is tested.
- `site.ts` and `src/assets/app.js` — the client-side SPA has no unit tests yet. Extracting its
  pure view-model logic (formatting, pagination maths, link resolution, hash parsing) into an
  importable module is the intended next step; until then verify the site by hand.
- `serve.ts` — verify the path guard by hand (see below).

Regressions worth keeping tests for, because each was a real bug: the `X-DayLimit-Remaining`
header being absent must not zero the quota; `X-Rate-Limit-Problem: daily` must throw rather than
sleep for hours; 429s must be retry-capped rather than looping forever; attachment markers must
compare dates format-agnostically so pre-migration markers still match.

## The microsite

- `site/assets/app.js` is a **dependency-free vanilla SPA** with hash routing
  (`#/e/<Entity>`, `#/e/<Entity>/<id>`, `#/reports`, `#/report/<kind>/<file>`). It fetches
  the generated JSON.
- **It must be served over HTTP** — opening `file://` breaks `fetch` (CORS `null` origin).
  That's the whole reason `serve.ts` exists.
- `serve.ts` roots at the **project root** (so the site can reference `../../data/<org>/...`
  for attachments and reports) but a **path guard only exposes `site/` and `data/`** — never
  `.env`/`.tokens.json`. Keep that guard intact.
- Per-entity display columns live in the `VIEWS` map in `site.ts`; unknown entities fall back
  to `genericView`. `app.js` is generic and reads columns from the generated `manifest.json`.
- **Cross-entity links are declared in `site.ts`, never hardcoded in `app.js`.** A `Column` may
  carry `link` (→ that record's page, or its filtered list when matching a non-id field like an
  account `Code`); a view may declare `related` (child arrays that are documents in their own
  right, e.g. an invoice's `Payments`) and `backlinks` (the reverse direction, rendered as
  `?link=<path>:<value>` filters — `[]` in the path marks an array hop). `app.js` silently drops
  any link whose target entity wasn't archived, so a partial archive still renders.
- List views paginate via `?p=` / `?size=`; `parseHash`/`hashFor`/`withParams` in `app.js` own
  the query string, so add new list state as a param rather than module-level state.
- Editing the SPA: change `src/assets/app.js` / `style.css` (the source of truth). `site.ts`
  copies them into `site/assets/` on every `npm run site`.

## Verifying end-to-end (the parts without unit tests)

`npm run check` covers the archival code. For the site generator, client app, server and path
guard, verify by hand without live Xero credentials: write a throwaway `_smoke.ts` at the project
root that uses `Store` to fabricate a small archive in a **temp directory** (organisation, a few
records, an attachment, some history, a report), call `generateSite()`, then `npm run serve` and
check pages over HTTP. Delete the fixture (`rm -f _smoke*.ts`) and stop the server afterwards.

Never point a throwaway script at the user's real `data/` or `.tokens.json`.

## Gotchas checklist when editing

- **Run `npm run check` before saying you're done.** Every time.
- Resume is disk-derived — there is **no state file**. Don't reintroduce one; add a
  disk-derivation helper on `Store` (like `maxJournalNumber`/`hasHistory`) instead.
- Keep `writeHistory` writing even empty `[]` — it's the "attempted" marker that makes history
  resumable. The `_attachments` marker is the opposite: write it only once every file is down,
  because it means "complete".
- Adding an archived resource → edit `endpoints.ts` (and optionally a `VIEWS` entry in
  `site.ts`); the rest is driven off the catalog.
- Touching fetch loops → write each file as it's fetched and keep `DailyLimitReached` handling
  so runs stay resumable purely from disk.
- New `.env` settings → remember a **blank value counts as unset** in `env()`, so `FOO=` falls
  back to the default rather than overriding it with `""`.
- Any Xero date field → go through `parseXeroDate`. Records are stored with dates already
  converted to ISO 8601: `Store`'s writers all funnel through `normaliseDates()`, so nothing in
  `data/` keeps the `/Date(…)/` wire format. Keep new writers going through that helper, and
  keep readers tolerant of both forms (older archives, and live API responses, still use it).
- Keep changes read-only against Xero — this tool never writes to the user's accounts.
