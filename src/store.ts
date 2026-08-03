import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config";

/** Filesystem-safe folder name for a tenant. */
export function slug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[^\w.\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 80) || "tenant"
  );
}

/** Filesystem-safe filename component. */
export function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?* ]+/g, "_").replace(/\.+$/, "").slice(0, 150) || "file";
}

/**
 * The archive is entirely disk-backed — there is no separate state file. Resume
 * points are derived from what's already on disk:
 *   - record lists are always re-pulled in full (idempotent overwrite)
 *   - the Journal offset is the highest journal number already stored
 *   - attachments/history are de-duplicated by file existence, plus a per-document
 *     marker under raw/_attachments/ so re-runs can skip the list call too
 */
export class Store {
  readonly tenantDir: string;
  readonly rawDir: string;
  readonly attachmentsDir: string;
  readonly reportsDir: string;

  constructor(
    readonly tenantId: string,
    readonly tenantName: string,
    tenantDir?: string,
  ) {
    this.tenantDir = tenantDir ?? path.join(DATA_DIR, `${slug(tenantName)}_${tenantId.slice(0, 8)}`);
    this.rawDir = path.join(this.tenantDir, "raw");
    this.attachmentsDir = path.join(this.tenantDir, "attachments");
    this.reportsDir = path.join(this.tenantDir, "reports");
  }

  /** Reconstructs a Store from an existing data directory (offline, no API). */
  static fromDir(dir: string): Store {
    let name = path.basename(dir);
    const orgFile = path.join(dir, "raw", "organisation.json");
    if (existsSync(orgFile)) {
      try {
        const org = JSON.parse(readFileSync(orgFile, "utf8"));
        if (org?.Name) name = org.Name;
      } catch {
        /* keep basename */
      }
    }
    return new Store("", name, dir);
  }

  async init(): Promise<void> {
    await mkdir(this.rawDir, { recursive: true });
    await mkdir(this.attachmentsDir, { recursive: true });
    await mkdir(this.reportsDir, { recursive: true });
  }

  // --- resume points, derived from disk --------------------------------------

  /** Highest Journal number already stored (0 if none) — the offset to resume from. */
  async maxJournalNumber(): Promise<number> {
    const dir = path.join(this.rawDir, "Journals");
    if (!existsSync(dir)) return 0;
    let max = 0;
    for (const f of await readdir(dir)) {
      const n = Number.parseInt(f, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }

  /** True if this specific attachment file is already on disk. */
  hasAttachment(entity: string, docId: string, filename: string): boolean {
    return existsSync(this.attachmentPath(entity, docId, filename));
  }

  /** True if this document's history has already been fetched (marker exists). */
  hasHistory(entity: string, docId: string): boolean {
    return existsSync(path.join(this.rawDir, "_history", entity, `${safeName(docId)}.json`));
  }

  private attachmentIndexPath(entity: string, docId: string): string {
    return path.join(this.rawDir, "_attachments", entity, `${safeName(docId)}.json`);
  }

  /**
   * True when this document's attachments are provably complete on disk, so the
   * per-document `GET /{Entity}/{id}/Attachments` list call can be skipped.
   *
   * Requires all three: a marker from a previous run, every file it recorded
   * still present, and the record unchanged since (`UpdatedDateUTC` match) — so a
   * document that has been touched in Xero gets re-listed in case files were added.
   */
  attachmentsComplete(entity: string, docId: string, updatedDateUTC: unknown): boolean {
    const file = this.attachmentIndexPath(entity, docId);
    if (!existsSync(file)) return false;
    try {
      const idx = JSON.parse(readFileSync(file, "utf8"));
      if (idx.updatedDateUTC !== String(updatedDateUTC ?? "")) return false;
      return (idx.files as string[]).every((f) => this.hasAttachment(entity, docId, f));
    } catch {
      return false; // unreadable marker — re-list
    }
  }

  /**
   * Records the attachment set we listed for a document. Written only once every
   * file is on disk, so a run interrupted mid-download leaves no marker and the
   * next run re-lists — the marker means "complete", never "attempted".
   */
  async writeAttachmentIndex(
    entity: string,
    docId: string,
    updatedDateUTC: unknown,
    files: string[],
  ): Promise<void> {
    const file = this.attachmentIndexPath(entity, docId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ updatedDateUTC: String(updatedDateUTC ?? ""), files }, null, 2),
    );
  }

  // --- writers ---------------------------------------------------------------

  /** Writes one record as raw/<entity>/<id>.json. */
  async writeRecord(entity: string, id: string, obj: unknown): Promise<void> {
    const dir = path.join(this.rawDir, entity);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${safeName(id)}.json`), JSON.stringify(obj, null, 2));
  }

  /** Writes a single top-level document, raw/<name>.json. */
  async writeSingle(name: string, obj: unknown): Promise<void> {
    await writeFile(path.join(this.rawDir, `${name}.json`), JSON.stringify(obj, null, 2));
  }

  async writeReport(kind: string, label: string, obj: unknown): Promise<void> {
    const dir = path.join(this.reportsDir, kind);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${safeName(label)}.json`), JSON.stringify(obj, null, 2));
  }

  /**
   * Writes a document's audit trail to raw/_history/<entity>/<id>.json. Always
   * writes — even an empty array — so the file's existence marks "history done"
   * and the disk alone tells us not to re-fetch it.
   */
  async writeHistory(entity: string, id: string, obj: unknown): Promise<void> {
    const dir = path.join(this.rawDir, "_history", entity);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${safeName(id)}.json`), JSON.stringify(obj, null, 2));
  }

  attachmentPath(entity: string, docId: string, filename: string): string {
    return path.join(this.attachmentsDir, entity, safeName(docId), safeName(filename));
  }

  async writeAttachment(entity: string, docId: string, filename: string, data: Buffer): Promise<string> {
    const full = this.attachmentPath(entity, docId, filename);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
    return path.relative(this.tenantDir, full);
  }

  // --- readers (used by the site generator) ----------------------------------

  /** Lists downloaded attachment filenames for a document. */
  async listAttachments(entity: string, docId: string): Promise<string[]> {
    const dir = path.join(this.attachmentsDir, entity, safeName(docId));
    if (!existsSync(dir)) return [];
    return (await readdir(dir)).filter((f) => !f.startsWith("_"));
  }

  /** Entity names that have an attachments/<entity>/ directory. */
  async attachmentEntities(): Promise<string[]> {
    if (!existsSync(this.attachmentsDir)) return [];
    const entries = await readdir(this.attachmentsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  /**
   * Every document with downloaded attachments, with its files and the newest file
   * mtime — the mtime lets callers spot the document a run was interrupted part-way
   * through. `docId` is the on-disk (safeName'd) form, which is what markers key on.
   */
  async listAttachmentDocs(
    entity: string,
  ): Promise<{ docId: string; files: string[]; mtime: number }[]> {
    const dir = path.join(this.attachmentsDir, entity);
    if (!existsSync(dir)) return [];
    const out: { docId: string; files: string[]; mtime: number }[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const docDir = path.join(dir, entry.name);
      const files = (await readdir(docDir)).filter((f) => !f.startsWith("_") && !f.startsWith("."));
      let mtime = 0;
      for (const f of files) {
        mtime = Math.max(mtime, (await stat(path.join(docDir, f))).mtimeMs);
      }
      out.push({ docId: entry.name, files, mtime });
    }
    return out;
  }

  hasAttachmentIndex(entity: string, docId: string): boolean {
    return existsSync(this.attachmentIndexPath(entity, docId));
  }

  /** Reads every record JSON stored under raw/<entity>/. */
  async readEntity(entity: string): Promise<any[]> {
    const dir = path.join(this.rawDir, entity);
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    const out: any[] = [];
    for (const f of files) {
      try {
        out.push(JSON.parse(await readFile(path.join(dir, f), "utf8")));
      } catch {
        /* skip unreadable file */
      }
    }
    return out;
  }

  async readSingle(name: string): Promise<any | null> {
    const file = path.join(this.rawDir, `${name}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
  }
}
