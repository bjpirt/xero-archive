import { getConnections } from "./auth";
import { request, paginate, XeroHttpError, dayLimitRemaining, apiUsage } from "./client";
import { CONFIG } from "./config";
import { ALL_ENDPOINTS, type Endpoint } from "./endpoints";
import { archiveReports } from "./reports";
import { Store, safeName } from "./store";
import { log } from "./log";

/** Thrown to unwind cleanly when we're about to exhaust the daily API quota. */
class DailyLimitReached extends Error {}

function checkDailyBudget(): void {
  if (dayLimitRemaining <= CONFIG.dailyLimitBuffer) throw new DailyLimitReached();
}

async function downloadAttachments(store: Store, ep: Endpoint, records: any[]): Promise<void> {
  // One list call per document that has attachments, plus one per new file — easily
  // hundreds of calls at 60/min, so report position rather than going silent.
  const withAttachments = records.filter((r) => r?.HasAttachments === true);
  if (withAttachments.length === 0) return;

  // Documents whose attachments are already complete on disk cost nothing: skipping
  // the list call is what makes a re-run cheap rather than re-spending the daily quota.
  const todo = CONFIG.refreshAttachments
    ? withAttachments
    : withAttachments.filter(
        (r) => !store.attachmentsComplete(ep.name, String(r[ep.idField] ?? ""), r.UpdatedDateUTC),
      );
  const skipped = withAttachments.length - todo.length;
  if (todo.length === 0) {
    log.progress(`${ep.name}: attachments already complete for ${skipped} doc(s)${apiUsage()}`);
    return;
  }

  let done = 0;
  let files = 0;
  for (const rec of todo) {
    const id = String(rec[ep.idField] ?? "");
    if (!id) continue;
    const at = `${ep.name}: attachments ${done + 1}/${todo.length} doc(s)`;
    log.progress(`${at}, ${files} file(s)${skipped ? `, ${skipped} skipped` : ""}${apiUsage()}`);
    try {
      const list = await request(store.tenantId, `/${ep.name}/${id}/Attachments`);
      const names: string[] = [];
      for (const att of list.json?.Attachments ?? []) {
        names.push(att.FileName);
        if (store.hasAttachment(ep.name, id, att.FileName)) continue; // already on disk
        log.progress(`${at} — downloading ${att.FileName}${apiUsage()}`);
        const bin = await request(
          store.tenantId,
          `/${ep.name}/${id}/Attachments/${encodeURIComponent(att.FileName)}`,
          { accept: "binary" },
        );
        if (bin.buffer) {
          await store.writeAttachment(ep.name, id, att.FileName, bin.buffer);
          files++;
        }
      }
      // Only now that every file is on disk does this count as complete.
      await store.writeAttachmentIndex(ep.name, id, rec.UpdatedDateUTC, names);
    } catch (e) {
      if (e instanceof XeroHttpError) log.warn(`attachments for ${ep.name}/${id}: ${e.status} — skipped`);
      else throw e;
    }
    done++;
    checkDailyBudget();
  }
  log.progress(
    `${ep.name}: attachments done — ${todo.length} doc(s) checked, ${files} new file(s)` +
      `${skipped ? `, ${skipped} already complete` : ""}${apiUsage()}`,
  );
}

/**
 * Fetches one document's History & Notes and always writes a file (even an empty
 * array) so the disk marks it done. `force` re-fetches even if already present.
 */
async function fetchHistoryForDoc(store: Store, entity: string, id: string, force: boolean): Promise<void> {
  if (!id) return;
  if (!force && store.hasHistory(entity, id)) return;
  try {
    const res = await request(store.tenantId, `/${entity}/${id}/history`);
    await store.writeHistory(entity, id, res.json?.HistoryRecords ?? []);
  } catch (e) {
    if (!(e instanceof XeroHttpError)) throw e;
    if (e.status >= 400 && e.status < 500) {
      await store.writeHistory(entity, id, []); // permanent — marker so we don't retry
    } else {
      log.warn(`history for ${entity}/${id}: ${e.status} — will retry next run`);
    }
  }
}

async function fetchHistory(store: Store, ep: Endpoint, records: any[]): Promise<void> {
  let done = 0;
  for (const rec of records) {
    log.progress(`${ep.name}: history ${done + 1}/${records.length} doc(s)${apiUsage()}`);
    await fetchHistoryForDoc(store, ep.name, String(rec[ep.idField] ?? ""), false);
    done++;
    checkDailyBudget();
  }
}

/**
 * Pulls an endpoint in full every run. Writes are idempotent (same <id>.json is
 * overwritten), so a re-run simply refreshes records and fills any gaps — no
 * modified-since watermark, hence nothing to persist between runs.
 */
async function archiveEndpoint(store: Store, ep: Endpoint): Promise<void> {
  let total = 0;
  let page = 0;

  const handlePage = async (items: any[]) => {
    if (items.length > 0) {
      const where = page > 1 ? ` page ${page},` : "";
      log.progress(`${ep.name}:${where} writing ${items.length} record(s)${apiUsage()}`);
    }
    for (const rec of items) {
      const id = String(rec[ep.idField] ?? "");
      if (!id) continue;
      await store.writeRecord(ep.name, id, rec);
      total++;
    }
    if (ep.attachments) await downloadAttachments(store, ep, items);
    if (ep.history && CONFIG.includeHistory) await fetchHistory(store, ep, items);
    if (items.length > 0) log.progress(`${ep.name}: ${total} record(s)${apiUsage()}`);
    checkDailyBudget();
  };

  try {
    log.progress(`${ep.name}: fetching…${apiUsage()}`);
    if (ep.paged) {
      for await (const p of paginate(store.tenantId, ep.path, ep.arrayKey)) {
        page++;
        await handlePage(p);
      }
    } else {
      const res = await request(store.tenantId, ep.path);
      await handlePage(res.json?.[ep.arrayKey] ?? []);
    }
  } catch (e) {
    if (e instanceof XeroHttpError && (e.status === 403 || e.status === 401)) {
      log.progressDone();
      log.warn(
        `${ep.name}: ${e.status} (scope not granted to your Xero app, or the ` +
          `authorising user lacks the role) — skipped`,
      );
      return;
    }
    throw e;
  }

  log.progressDone();
  if (total > 0) log.ok(`${ep.name}: ${total} record(s) archived${apiUsage()}`);
}

async function archiveJournals(store: Store): Promise<void> {
  log.info("Journals (general ledger backbone)…");
  let offset = await store.maxJournalNumber(); // resume from highest stored journal
  let count = 0;
  try {
    for (;;) {
      const res = await request(store.tenantId, "/Journals", { query: { offset } });
      const journals: any[] = res.json?.Journals ?? [];
      if (journals.length === 0) break; // only an empty response means "done"
      for (const j of journals) {
        await store.writeRecord("Journals", String(j.JournalNumber), j);
        if (typeof j.JournalNumber === "number") offset = Math.max(offset, j.JournalNumber);
        count++;
      }
      log.progress(`Journals: ${count} new (offset ${offset})${apiUsage()}`);
      checkDailyBudget();
    }
    log.progressDone();
    if (count > 0) log.ok(`Journals: ${count} new journal(s)${apiUsage()}`);
  } catch (e) {
    log.progressDone();
    if (e instanceof XeroHttpError && (e.status === 403 || e.status === 401)) {
      log.warn(
        "Journals unavailable (premium/Advanced tier + security assessment required, or missing scope) — skipped.",
      );
      return;
    }
    throw e;
  }
}

async function archiveTenant(conn: { tenantId: string; tenantName: string }): Promise<Store> {
  log.step(`Organisation: ${conn.tenantName}`);
  const store = new Store(conn.tenantId, conn.tenantName);
  await store.init();

  try {
    const orgRes = await request(conn.tenantId, "/Organisation");
    await store.writeSingle("organisation", orgRes.json?.Organisations?.[0] ?? orgRes.json);

    for (const ep of ALL_ENDPOINTS) {
      await archiveEndpoint(store, ep);
    }
    await archiveJournals(store);
    if (CONFIG.includeReports) await archiveReports(store);
  } catch (e) {
    if (e instanceof DailyLimitReached) {
      log.warn(
        "Approaching the daily API limit — stopping early. Progress is on disk; re-run later to resume.",
      );
    } else {
      log.error(`Archive failed for ${conn.tenantName}: ${(e as Error).message}`);
      throw e;
    }
  }
  log.ok(`Done: ${conn.tenantName}`);
  return store;
}

/** Archives every connected organisation. Returns their stores. */
export async function runArchive(): Promise<Store[]> {
  const connections = await getConnections();
  const orgs = connections.filter((c) => c.tenantType === "ORGANISATION");
  if (orgs.length === 0) {
    throw new Error("No Xero organisations connected to this token. Run `npm run auth` again.");
  }
  log.info(`Connected organisation(s): ${orgs.map((o) => o.tenantName).join(", ")}`);
  const stores: Store[] = [];
  for (const conn of orgs) {
    stores.push(await archiveTenant(conn));
  }
  return stores;
}

/**
 * One-off, offline: writes `_attachments` markers for documents whose files were
 * downloaded before markers existed, so the next archive skips their list calls
 * instead of re-spending a call per document to rediscover filenames we have.
 *
 * Makes no API calls, so it cannot verify a document is complete — it trusts the
 * disk. To limit the damage that would do, it leaves the newest document per entity
 * unmarked: that's the one a run interrupted mid-download would have left partial.
 */
export async function adoptAttachments(stores: Store[]): Promise<void> {
  if (stores.length === 0) {
    log.warn("No archived organisations found in data/. Run `npm run archive` first.");
    return;
  }

  for (const store of stores) {
    log.step(`Adopting attachments: ${store.tenantName}`);
    let adopted = 0;
    let already = 0;
    let unresolved = 0;

    for (const entity of await store.attachmentEntities()) {
      const ep = ALL_ENDPOINTS.find((e) => e.name === entity);
      if (!ep) {
        log.warn(`${entity}: not in the endpoint catalog — skipped`);
        continue;
      }
      // UpdatedDateUTC has to come from the stored records; markers are worthless
      // without it since it's what detects a document changing later.
      const updatedById = new Map<string, unknown>();
      for (const rec of await store.readEntity(entity)) {
        const id = String(rec[ep.idField] ?? "");
        if (id) updatedById.set(safeName(id), rec.UpdatedDateUTC);
      }

      const docs = await store.listAttachmentDocs(entity);
      const newest = docs.reduce((m, d) => Math.max(m, d.mtime), 0);

      for (const doc of docs) {
        if (doc.files.length === 0) continue;
        if (store.hasAttachmentIndex(entity, doc.docId)) {
          already++;
          continue;
        }
        if (doc.mtime === newest) continue; // possibly interrupted — let it re-list
        if (!updatedById.has(doc.docId)) {
          unresolved++; // no stored record, so no UpdatedDateUTC to pin the marker to
          continue;
        }
        await store.writeAttachmentIndex(entity, doc.docId, updatedById.get(doc.docId), doc.files);
        adopted++;
        log.progress(`${entity}: ${adopted} marker(s) written`);
      }
    }

    log.progressDone();
    log.ok(`Adopted ${adopted} document(s) — that many list calls saved on the next archive.`);
    if (already > 0) log.info(`${already} document(s) already had markers.`);
    if (unresolved > 0) {
      log.warn(`${unresolved} document(s) have files but no stored record — they'll be re-listed.`);
    }
  }
  log.info("Run `npm run archive -- --refresh-attachments` any time to re-verify against Xero.");
}

/**
 * Standalone History & Notes backfill over EVERY archived document. Resumable
 * purely from disk: each history file is written as it's fetched, so if this
 * hits the daily API limit it stops cleanly and the next `npm run history`
 * skips whatever already has a history file. `refresh` re-fetches everything.
 */
export async function runHistoryBackfill(refresh = false): Promise<void> {
  const connections = await getConnections();
  const orgs = connections.filter((c) => c.tenantType === "ORGANISATION");
  if (orgs.length === 0) {
    throw new Error("No Xero organisations connected. Run `npm run auth` first.");
  }
  const historyEndpoints = ALL_ENDPOINTS.filter((e) => e.history);

  for (const conn of orgs) {
    log.step(`History backfill: ${conn.tenantName}`);
    const store = new Store(conn.tenantId, conn.tenantName);
    await store.init();

    let done = 0;
    let remaining = 0;
    try {
      for (const ep of historyEndpoints) {
        const records = await store.readEntity(ep.name);
        const todo = records
          .map((r) => String(r[ep.idField] ?? ""))
          .filter((id) => id && (refresh || !store.hasHistory(ep.name, id)));
        if (todo.length === 0) continue;
        remaining += todo.length;
        log.info(`${ep.name}: ${todo.length} document(s) need history`);

        let n = 0;
        for (const id of todo) {
          await fetchHistoryForDoc(store, ep.name, id, refresh);
          done++;
          n++;
          log.progress(`${ep.name}: history ${n}/${todo.length}, ${done} this run${apiUsage()}`);
          checkDailyBudget();
        }
      }
      log.progressDone();
      if (remaining === 0) log.ok(`History already complete for ${conn.tenantName}.`);
      else log.ok(`History backfill done for ${conn.tenantName} (${done} document(s) this run).`);
    } catch (e) {
      log.progressDone();
      if (e instanceof DailyLimitReached) {
        log.warn(
          `Daily API limit reached after ${done} document(s) — progress is on disk. ` +
            "Re-run `npm run history` (e.g. tomorrow) to continue.",
        );
      } else {
        throw e;
      }
    }
  }
  log.info("Rebuild the site with `npm run site` to include the history.");
}
