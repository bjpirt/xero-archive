import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setSilent } from "./log";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, safeName, slug } from "./store";

setSilent(true); // progress chatter would drown the test report

/**
 * These exercise real filesystem behaviour in a temp directory rather than a mocked
 * `fs`. Disk *is* the archive's state, so faking it would test the fake.
 */
let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "xero-archive-store-"));
  store = new Store("tenant-1234-5678", "Test Org", dir);
  await store.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("slug", () => {
  test("makes a filesystem-safe folder name", () => {
    assert.equal(slug("Pirt Design & Technology Ltd"), "Pirt_Design_Technology_Ltd");
  });

  test("collapses whitespace and strips punctuation", () => {
    assert.equal(slug("  A   B  "), "A_B");
    assert.equal(slug("a/b\\c:d"), "abcd");
  });

  test("falls back rather than returning an empty name", () => {
    assert.equal(slug("///"), "tenant");
    assert.equal(slug(""), "tenant");
  });

  test("truncates very long names", () => {
    assert.equal(slug("x".repeat(200)).length, 80);
  });
});

describe("safeName", () => {
  test("replaces characters that are unsafe in filenames", () => {
    assert.equal(safeName("Receipt from Mother Clucker.pdf"), "Receipt_from_Mother_Clucker.pdf");
    assert.equal(safeName('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j");
  });

  test("is idempotent — markers written from disk names still match", () => {
    const once = safeName("in voice: 1.pdf");
    assert.equal(safeName(once), once);
  });

  test("leaves GUIDs untouched, so folder names are greppable ids", () => {
    const id = "d9e688ee-cecc-496f-a308-c223182143a0";
    assert.equal(safeName(id), id);
  });

  test("strips trailing dots", () => {
    assert.equal(safeName("name..."), "name");
  });

  test("never returns an empty filename", () => {
    assert.equal(safeName(""), "file");
    // All-unsafe input collapses to a single separator, which is a valid name.
    assert.equal(safeName("///"), "_");
  });
});

describe("date normalisation on write", () => {
  test("writeRecord stores ISO 8601, not Xero's wire format", async () => {
    await store.writeRecord("Invoices", "inv-1", {
      InvoiceID: "inv-1",
      Date: "/Date(1585526400000+0000)/",
      Contact: { UpdatedDateUTC: "/Date(1585526400000+0000)/" },
    });
    const written = JSON.parse(
      await readFile(path.join(store.rawDir, "Invoices", "inv-1.json"), "utf8"),
    );
    assert.equal(written.Date, "2020-03-30T00:00:00.000Z");
    assert.equal(written.Contact.UpdatedDateUTC, "2020-03-30T00:00:00.000Z");
  });

  test("writeSingle, writeHistory and writeReport normalise too", async () => {
    await store.writeSingle("organisation", { CreatedDateUTC: "/Date(0+0000)/" });
    await store.writeHistory("Invoices", "inv-1", [{ DateUTC: "/Date(0+0000)/" }]);
    await store.writeReport("profit-and-loss", "2024", { ReportDate: "/Date(0+0000)/" });

    const org = await store.readSingle("organisation");
    assert.equal(org.CreatedDateUTC, "1970-01-01T00:00:00.000Z");
    const hist = JSON.parse(
      await readFile(path.join(store.rawDir, "_history", "Invoices", "inv-1.json"), "utf8"),
    );
    assert.equal(hist[0].DateUTC, "1970-01-01T00:00:00.000Z");
    const report = JSON.parse(
      await readFile(path.join(store.reportsDir, "profit-and-loss", "2024.json"), "utf8"),
    );
    assert.equal(report.ReportDate, "1970-01-01T00:00:00.000Z");
  });
});

describe("history markers", () => {
  test("an empty history still writes a file — the 'attempted' marker", async () => {
    assert.equal(store.hasHistory("Invoices", "inv-1"), false);
    await store.writeHistory("Invoices", "inv-1", []);
    assert.equal(store.hasHistory("Invoices", "inv-1"), true);
  });
});

describe("attachmentsComplete", () => {
  const id = "inv-1";
  const iso = "2020-03-30T07:50:44.260Z";
  const dotNet = "/Date(1585554644260+0000)/"; // the same instant, as Xero sends it

  async function storeFiles(...names: string[]) {
    for (const name of names) {
      await store.writeAttachment("Invoices", id, name, Buffer.from("bytes"));
    }
  }

  test("false with no marker, however many files are on disk", async () => {
    await storeFiles("a.pdf");
    assert.equal(store.attachmentsComplete("Invoices", id, iso), false);
  });

  test("true once a marker matches the files present", async () => {
    await storeFiles("a.pdf", "b.pdf");
    await store.writeAttachmentIndex("Invoices", id, iso, ["a.pdf", "b.pdf"]);
    assert.equal(store.attachmentsComplete("Invoices", id, iso), true);
  });

  test("matches across date formats, so pre-migration markers still count", async () => {
    await storeFiles("a.pdf");
    await store.writeAttachmentIndex("Invoices", id, dotNet, ["a.pdf"]);
    // Marker written from a .NET value, record now ISO — and vice versa.
    assert.equal(store.attachmentsComplete("Invoices", id, iso), true);
    assert.equal(store.attachmentsComplete("Invoices", id, dotNet), true);
  });

  test("false when the record has changed since — it may have gained attachments", async () => {
    await storeFiles("a.pdf");
    await store.writeAttachmentIndex("Invoices", id, iso, ["a.pdf"]);
    assert.equal(store.attachmentsComplete("Invoices", id, "2021-01-01T00:00:00.000Z"), false);
  });

  test("false when a recorded file has gone missing", async () => {
    await storeFiles("a.pdf");
    await store.writeAttachmentIndex("Invoices", id, iso, ["a.pdf", "gone.pdf"]);
    assert.equal(store.attachmentsComplete("Invoices", id, iso), false);
  });

  test("tolerates a corrupt marker by re-listing rather than throwing", async () => {
    await storeFiles("a.pdf");
    const file = path.join(store.rawDir, "_attachments", "Invoices", `${id}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json");
    assert.equal(store.attachmentsComplete("Invoices", id, iso), false);
  });

  test("marker filenames are matched through safeName", async () => {
    // Xero reports the original name; disk holds the sanitised one.
    await store.writeAttachment("Invoices", id, "in voice.pdf", Buffer.from("b"));
    await store.writeAttachmentIndex("Invoices", id, iso, ["in voice.pdf"]);
    assert.equal(store.attachmentsComplete("Invoices", id, iso), true);
  });
});

describe("disk-derived resume points", () => {
  test("maxJournalNumber returns 0 with nothing stored", async () => {
    assert.equal(await store.maxJournalNumber(), 0);
  });

  test("maxJournalNumber finds the highest number, not the last written", async () => {
    for (const n of [5, 120, 37]) await store.writeRecord("Journals", String(n), { JournalNumber: n });
    assert.equal(await store.maxJournalNumber(), 120);
  });

  test("listAttachmentDocs reports files and a modification time per document", async () => {
    await store.writeAttachment("Invoices", "a", "1.pdf", Buffer.from("x"));
    await store.writeAttachment("Invoices", "b", "1.pdf", Buffer.from("x"));
    await store.writeAttachment("Invoices", "b", "2.pdf", Buffer.from("x"));

    const docs = await store.listAttachmentDocs("Invoices");
    assert.deepEqual(
      docs.map((d) => [d.docId, d.files.length]).sort(),
      [["a", 1], ["b", 2]],
    );
    assert.ok(docs.every((d) => d.mtime > 0), "expected a modification time per doc");
  });

  test("attachmentEntities lists only entities with downloads", async () => {
    assert.deepEqual(await store.attachmentEntities(), []);
    await store.writeAttachment("Invoices", "a", "1.pdf", Buffer.from("x"));
    assert.deepEqual(await store.attachmentEntities(), ["Invoices"]);
  });

  test("readEntity returns [] for an entity never archived", async () => {
    assert.deepEqual(await store.readEntity("Nope"), []);
  });

  test("readEntity skips an unreadable file rather than failing the run", async () => {
    await store.writeRecord("Invoices", "good", { InvoiceID: "good" });
    await writeFile(path.join(store.rawDir, "Invoices", "bad.json"), "{ not json");
    const records = await store.readEntity("Invoices");
    assert.deepEqual(records.map((r) => r.InvoiceID), ["good"]);
  });
});

describe("fromDir", () => {
  test("recovers the organisation name from the archived record", async () => {
    await store.writeSingle("organisation", { Name: "Recovered Ltd" });
    assert.equal(Store.fromDir(dir).tenantName, "Recovered Ltd");
  });

  test("falls back to the directory name when there's no organisation file", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "xero-archive-bare-"));
    try {
      assert.equal(Store.fromDir(bare).tenantName, path.basename(bare));
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
