# Xero Archive

Extract and archive your historical financial data from [Xero](https://www.xero.com) to
local JSON, download every attachment, and browse it all through a self-contained HTML
microsite — no ongoing dependency on Xero.

- **Raw data** → `data/<org>/raw/` — one JSON file per record, grouped by type
- **Attachments** → `data/<org>/attachments/<type>/<id>/<file>`
- **Reports** → `data/<org>/reports/` — P&L, Balance Sheet, Trial Balance snapshots
- **Microsite** → `site/` — searchable, browsable, links to attachments and audit history
- **Stateless & resumable** — no state file; re-runs resume purely from what's already on disk

## Setup

**1. Create a Xero app** at <https://developer.xero.com/app/manage>

- Type: *Web app*
- Redirect URI: `http://localhost:5173/callback`
- Copy the **Client ID**
- Under *Configuration*, click **Generate a secret** and copy it. Xero won't treat the app
  as enabled without one — if you skip this, `npm run auth` fails with
  `unauthorized_client: Unknown client or client not enabled`. The secret is shown once, so
  copy it before leaving the page.
- Optionally check which **scopes** the app has been assigned. `npm run auth` adapts to
  whatever it finds, but two things are worth requesting if your app lacks them:
  `accounting.journals.read` (the general ledger) and `accounting.transactions.read` (the only
  scope that reaches Receipts and Expense Claims).

**2. Configure**

```bash
cp .env.example .env      # paste in XERO_CLIENT_ID and XERO_CLIENT_SECRET
npm install
```

**3. Authenticate (one-time)**

```bash
npm run auth
```

This opens your browser, you approve read-only access to your organisation, and a rotating
refresh token is saved to `.tokens.json`.

**4. Archive + build + browse**

```bash
npm run all               # archive everything, generate the site, open it
```

…or run the steps individually:

```bash
npm run archive           # pull data + attachments into data/ (incremental)
npm run site              # generate the microsite into site/
npm run serve             # serve site/ locally and open it
```

On a 1,000-call/day plan a large org won't finish in one run. The phases can be split across
days, cheapest first:

```bash
npm run archive -- --skip-attachments    # every record list + ledger + reports (~30 calls)
npm run archive -- --attachments-only    # then spend the rest of the quota on attachments
```

### Attachments downloaded before markers existed

If you archived attachments with an older version of this tool, run this once so the next
archive doesn't re-list them all:

```bash
npm run adopt-attachments   # no API calls; marks stored attachments as complete
```

It writes a `raw/_attachments/` marker for every document whose files are already on disk,
pinned to that record's current `UpdatedDateUTC`. Because it can't ask Xero anything, it
trusts the disk — so it deliberately leaves the most recently written document per entity
unmarked, that being the one an interrupted run could have left half-downloaded.

### Adding History & Notes (optional, do it last)

Per-document audit history is **off by default** because it costs one API call per
document. The recommended workflow is to archive everything first, then backfill history
for every document in a separate, resumable pass:

```bash
npm run archive           # fast — no history
npm run history           # backfill History & Notes for every document
npm run site              # rebuild the site so histories show up
```

`npm run history` tracks progress on disk (one history file per document). On a large org it
may hit the daily API limit — it stops cleanly and you just run it again (e.g. the next day)
to continue where it left off. It only fetches documents that don't already have a history
file; add `npm run history -- --refresh` to re-fetch all history from scratch.

## How it works

### Authentication (OAuth 2.0 PKCE)

A throwaway local server on `http://localhost:5173/callback` runs just long enough to catch
the redirect. The code exchange is PKCE-protected; if `XERO_CLIENT_SECRET` is set the token
requests also authenticate with it (Xero web apps are confidential clients), and if it's
empty PKCE alone is used. Tokens rotate on every refresh and are stored in `.tokens.json`
(git-ignored, `chmod 600`).

> **⚠️ 60-day rule:** Xero refresh tokens expire after **60 days of inactivity**. If you don't
> run the tool for 60 days you'll simply run `npm run auth` again. Access tokens (30 min) are
> refreshed automatically during a run.

#### Scopes

Xero is [replacing the broad accounting scopes with granular
ones](https://developer.xero.com/documentation/guides/oauth2/scopes/): since March 2026 every
web and PKCE app — new *and* existing — has been assigned granular scopes, and the broad ones
keep working only on apps that already had them, until September 2027.

So the read-only set requested is granular: `accounting.invoices.read`,
`accounting.payments.read`, `accounting.banktransactions.read`,
`accounting.manualjournals.read`, `accounting.contacts.read`, `accounting.settings.read`,
`accounting.attachments.read`, the three report scopes
(`accounting.reports.profitandloss.read`, `.balancesheet.read`, `.trialbalance.read`),
`accounting.journals.read`, plus `offline_access`. The deprecated
`accounting.transactions.read` and `accounting.reports.read` are also requested, because on an
older app they're the only way to reach Receipts and Expense Claims.

Since no app holds every one of those, and Xero rejects the *whole* sign-in with
`invalid_scope` if a single requested scope isn't assigned — without saying which — `npm run
auth` negotiates first. It asks Xero whether the full set is acceptable and, only if it isn't,
tests each scope in turn, drops the unavailable ones, and prints what the archive will
therefore miss. Set `XERO_SCOPES` in `.env` to pin an exact list and skip the negotiation.

### What gets archived

**Transactions** — Invoices & bills, Credit Notes, Bank Transactions, Bank Transfers,
Payments, Batch Payments, Overpayments, Prepayments, Manual Journals, Purchase Orders,
Quotes, Receipts, Expense Claims, Linked Transactions, Repeating Invoices.

**Ledger** — the full **Journals** general ledger (offset-paged backbone for gap-free history).

**Master data** — Chart of Accounts, Contacts, Contact Groups, Items, Tax Rates, Tracking
Categories, Currencies, Branding Themes, Users, Organisation.

**Attachments & history** — every document's files and its audit trail (History & Notes).

**Reports** — Profit & Loss, Balance Sheet, and Trial Balance snapshots per financial year
(set `REPORT_PERIOD=month` for monthly).

### Incremental re-runs (stateless — disk is the source of truth)

There's no state file to lose or corrupt: re-running resumes purely from what's already in
`data/`.

- Record lists are re-pulled in full each run and overwrite in place (cheap, and it can't
  leave a permanent gap the way a modified-since watermark can).
- **Phase order matters on a daily quota.** A run does *every* record list first, then the
  ledger, then reports, and only then attachments. A record list costs about one call per 1,000
  records; attachments cost one call per document. Interleaving them (as earlier versions did)
  let one entity's attachments exhaust the day's quota before later entities were listed at
  all, so you'd have complete invoice attachments but no idea what bank transactions existed.
- Journals resume from the highest `JournalNumber` already stored on disk.
- Attachments are skipped if the file already exists locally. A marker under
  `raw/_attachments/` records the file set listed for each document, so a re-run also skips the
  per-document *list* call — the expensive part, since it costs one call per attachment-bearing
  document whether or not anything new is there. A document is re-listed only if its
  `UpdatedDateUTC` changed (it may have gained attachments) or a recorded file is missing.
  `npm run archive -- --refresh-attachments` re-lists everything.
- History is skipped if the document already has a history file (empty histories are written
  as `[]` so they count as done and aren't re-fetched).

If a run stops at the daily API limit, just run it again — it continues from disk. It also
tells you when to come back, if Xero told *it*: the daily window is a fixed window that
[resets at a tenant-specific time](https://developer.xero.com/documentation/guides/oauth2/limits),
disclosed only through `Retry-After` on a real 429. Stopping early on `DAILY_LIMIT_BUFFER`
never sees that header, so set `DAILY_LIMIT_BUFFER=0` if you want the exact reset time.

### Rate limits

Xero allows 60 calls/min, 5 concurrent, and 1,000/day (Starter) or 5,000/day (Core+) per org.
The client throttles to stay under the minute/concurrency limits and honours `Retry-After` on
429s. If it nears the **daily** cap it stops cleanly and saves progress — just run it again
later and it resumes where it left off (`DAILY_LIMIT_BUFFER` controls the headroom).

## Development

```bash
npm test              # Node's built-in test runner, via tsx
npm run test:watch
npm run test:coverage
npm run typecheck
npm run check         # typecheck + tests
```

Tests use `node:test` and `node:assert/strict` run through `tsx`, so they add **no dependencies** —
the only devDependencies are `tsx`, `typescript` and `@types/node`. They live beside their subject
as `src/*.test.ts` and cover ~96% of the archival code's lines.

The I/O boundaries are injected rather than patched: `XeroClient` takes its `fetch`, `sleep`,
clock and token provider; `XeroAuth` takes a `TokenStore` (so tests never touch your real
`.tokens.json`); `Archiver` takes its client, connection source and store factory. A test's
`sleep` advances its own fake clock, which is how the 60-calls-per-minute throttle and the retry
backoffs get exercised in milliseconds. `cli.ts` is the only place real dependencies are wired
together.

The client-side SPA (`src/assets/app.js`) has no unit tests yet — verify the site by hand with
`npm run serve`.

## Notes & limitations

- **Journals** is a premium (Advanced-tier) endpoint that also needs a Xero security
  assessment. If it's unavailable the tool logs a warning and skips it — the transactional
  endpoints still give you full detail.
- **Reports** and Manual Journals require the authorising user to have the **"reports"** role;
  otherwise they're skipped with a warning.
- **History** costs one API call per document, so it's off by default and lives in its own
  resumable `npm run history` pass (see above). Set `INCLUDE_HISTORY=true` only if you want it
  captured inline during every `npm run archive`.
- The microsite fetches JSON, so it must be served over HTTP (`npm run serve`) — opening the
  HTML files directly via `file://` won't work because browsers block `fetch` there.
- The local server only ever exposes `site/` and `data/`; your `.env` and `.tokens.json` are
  never served.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `XERO_CLIENT_ID` | — | Your Xero app's Client ID (required) |
| `XERO_CLIENT_SECRET` | — | Your app's secret; required for *Web app* type apps |
| `XERO_TOKENS_FILE` | `.tokens.json` | Token store path; give each Xero app its own |
| `XERO_SCOPES` | auto | Pin the exact scope list (space- or comma-separated), skipping negotiation |
| `XERO_REDIRECT_URI` | `http://localhost:5173/callback` | Must match the app's registered redirect |
| `AUTH_CALLBACK_PORT` | `5173` | Local callback port (match the redirect URI) |
| `INCLUDE_HISTORY` | `false` | Pull audit trail inline during archive (prefer `npm run history`) |
| `REFRESH_ATTACHMENTS` | `false` | Re-list attachments already recorded as complete (same as `--refresh-attachments`) |
| `SKIP_ATTACHMENTS` | `false` | Records, ledger and reports only (same as `--skip-attachments`) |
| `ATTACHMENTS_ONLY` | `false` | Only the attachment pass (same as `--attachments-only`) |
| `INCLUDE_REPORTS` | `true` | Snapshot P&L / Balance Sheet / Trial Balance |
| `REPORT_PERIOD` | `year` | `year` or `month` report granularity |
| `REPORT_FROM_YEAR` | auto | Earliest year to snapshot reports from |
| `DAILY_LIMIT_BUFFER` | `50` | Stop this many calls before the daily limit |

### Using more than one Xero app

Rate limits are per **(app, tenant)** pair, so a second app connected to the same organisation
gets its own daily allowance. Two caveats before you rely on it: Xero
[limits an organisation to **two uncertified apps**](https://developer.xero.com/documentation/guides/oauth2/limits),
and its documented answer to needing more than 1,000 calls/day is to move to the Core tier.

Give each app its own token file, because a refresh token is bound to the app that issued it:

```bash
# .env.app2 — that app's XERO_CLIENT_ID and XERO_CLIENT_SECRET, plus:
XERO_TOKENS_FILE=.tokens.app2.json
```

```bash
node --env-file=.env.app2 node_modules/.bin/tsx src/cli.ts auth
node --env-file=.env.app2 node_modules/.bin/tsx src/cli.ts archive
```

Both apps can share one `data/` directory — resume is derived from disk, so whichever app runs
next simply continues from what's already there.

**Don't just swap `XERO_CLIENT_ID` and reuse one token file.** API calls are authorised by the
stored bearer token, not by the configured client id, so you would keep spending the *previous*
app's quota until the access token expired ~30 minutes later, and only then hit a confusing
refresh failure. The token file now records which app issued it and the tool refuses a mismatch
rather than letting that happen silently.

## Troubleshooting

**`unauthorized_client` — "Unknown client or client not enabled"**
Xero doesn't recognise the Client ID. Check it's copied correctly from
<https://developer.xero.com/app/manage>, and that the app has a **client secret generated** —
an app with no secret isn't enabled. Put the secret in `XERO_CLIENT_SECRET`.

**`invalid_scope`**
Xero fails the *whole* authorize request if any single requested scope isn't assigned to your
app, and doesn't say which. `npm run auth` normally negotiates around this by itself (see
[Scopes](#scopes)); you'd only see the raw error if you've pinned `XERO_SCOPES` in `.env`.

To work out which scope is at fault by hand, request them one at a time against
`https://login.xero.com/identity/connect/authorize`: a scope Xero accepts redirects to its
sign-in page, while a rejected one redirects to `/identity/error`.

**Entities skipped with a 403 during the archive**
The scope that covers them isn't assigned to your app. Two gaps are expected on a granular-only
app: **Receipts** and **Expense Claims** have no granular scope at all — only the deprecated
`accounting.transactions.read` reaches them — and **Journals** additionally needs the premium
`accounting.journals.read`. Everything else has a granular equivalent.

**`invalid_client` on token exchange**
The app has a secret but `XERO_CLIENT_SECRET` is unset or stale — regenerate it in the portal
and update `.env`.

## Data layout

```
data/
  <OrgName>_<tenant8>/
    raw/
      organisation.json
      Invoices/<InvoiceID>.json
      Journals/<JournalNumber>.json
      _history/<Type>/<id>.json
      _attachments/<Type>/<id>.json     # which files we've already got
      …
    attachments/<Type>/<id>/<filename>
    reports/profit-and-loss/2023.json …
site/
  index.html                 # landing (all orgs)
  assets/style.css, app.js
  <OrgName>_<tenant8>/index.html + data/*.json
```
