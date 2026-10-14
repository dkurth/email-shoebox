// The service with the real importer (../importer/src) and python3.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ImportState, ScanEvent } from "../src/shared/api.ts";
import { collectionSize, folderSize, Service } from "../src/main/service.ts";
import { bigMbox, PYTHON, takeoutFolder, tempDir } from "./helpers.ts";

function service(dataDir = tempDir()) {
  return new Service({ dataDir, python: PYTHON });
}

function scanAll(svc: Service, paths: string[]): Promise<ScanEvent[]> {
  return new Promise((resolve) => {
    const events: ScanEvent[] = [];
    svc.scan(paths, (e) => {
      events.push(e);
      if (e.type === "result" || e.type === "error") resolve(events);
    });
  });
}

function untilDone(svc: Service): Promise<ImportState> {
  return new Promise((resolve) => {
    const stop = svc.onImport((s) => {
      if (s.phase === "finished" || s.phase === "failed" || s.phase === "interrupted") {
        stop();
        resolve(s);
      }
    });
  });
}

describe("scan", () => {
  it("finds the owner, the dates and a default name", async () => {
    const svc = service();
    const events = await scanAll(svc, [takeoutFolder()]);
    expect(events[0]).toMatchObject({ type: "files", look: { mbox_count: 1 } });
    const result = events.at(-1)!;
    expect(result.type).toBe("result");
    if (result.type !== "result") return;
    expect(result.result.owner).toBe("me@example.com");
    expect(result.defaultName).toMatch(/^me@example\.com \(\d{4}(–\d{4})?\)$/);
  });

  it("reports an error for a folder with no mail", async () => {
    const events = await scanAll(service(), [tempDir()]);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/no \.mbox/) });
  });
});

describe("import", () => {
  it("imports into a new collection in the app data folder", async () => {
    const svc = service();
    const done = untilDone(svc);
    const started = svc.startImport({ mode: "new", paths: [takeoutFolder()], name: "Personal 2024", skipSpamTrash: false, mboxCount: 1 });
    expect(started.phase).toBe("running");
    const s = await done;
    expect(s.phase).toBe("finished");
    expect(s.counts?.inserted).toBeGreaterThan(50);
    const [c] = svc.list(null);
    expect(c).toMatchObject({ name: "Personal 2024", incomplete: null, missing: false });
    expect(c.path).toBe(path.join(svc.collectionsDir, "personal-2024"));
    expect(c.messages).toBe(s.counts?.inserted);
    expect(svc.schemaStatus(c.id)).toBe("ok");
    // The name is also in the archive, so the list can be rebuilt from the folders.
    fs.rmSync(svc.registryFile);
    expect(service(svc.dataDir).list(null).map((x) => x.name)).toEqual(["Personal 2024"]);
  });

  it("can store a collection elsewhere, and importing again adds nothing new", async () => {
    const svc = service();
    const elsewhere = tempDir();
    const folder = takeoutFolder();
    let done = untilDone(svc);
    svc.startImport({ mode: "new", paths: [folder], name: "Work", skipSpamTrash: false, storageParent: elsewhere });
    await done;
    const [c] = svc.list(null);
    expect(c.path).toBe(path.join(elsewhere, "work"));
    done = untilDone(svc);
    svc.startImport({ mode: "into", collectionId: c.id, paths: [folder], skipSpamTrash: false });
    const s = await done;
    expect(s.phase).toBe("finished");
    expect(s.counts?.inserted).toBe(0);
  });

  it("a failed first import leaves no collection behind", async () => {
    const svc = service();
    const done = untilDone(svc);
    svc.startImport({ mode: "new", paths: [path.join(tempDir(), "missing.mbox")], name: "Oops", skipSpamTrash: false });
    const s = await done;
    expect(s.phase).toBe("failed");
    expect(s.error).toMatch(/no such file or folder/);
    expect(svc.list(null)).toEqual([]);
    expect(fs.readdirSync(svc.collectionsDir)).toEqual([]);
  });

  it("cancel keeps what was imported; continue finishes it", async () => {
    const svc = service();
    const mbox = bigMbox();
    let done = untilDone(svc);
    let cancelled = false;
    svc.onImport((s) => {
      if (!cancelled && s.progress && s.progress.messages > 0) {
        cancelled = true;
        svc.cancelImport();
      }
    });
    svc.startImport({ mode: "new", paths: [mbox], name: "Big", skipSpamTrash: true });
    let s = await done;
    expect(s.phase).toBe("interrupted");
    const [c] = svc.list(null);
    expect(c.incomplete).toEqual({ paths: [mbox], skipSpamTrash: true });
    expect(c.messages).toBeLessThan(3000);

    done = untilDone(svc);
    svc.startImport({ mode: "continue", collectionId: c.id, paths: [], skipSpamTrash: false });
    s = await done;
    expect(s.phase).toBe("finished");
    expect(svc.list(null)[0]).toMatchObject({ incomplete: null });
  });

  it("refuses a second import while one runs", () => {
    const svc = service();
    svc.startImport({ mode: "new", paths: [takeoutFolder()], name: "One", skipSpamTrash: false });
    expect(() => svc.startImport({ mode: "new", paths: [takeoutFolder()], name: "Two", skipSpamTrash: false })).toThrow(/already running/);
    svc.killImport();
  });
});

describe("changing collections", () => {
  async function withCollection() {
    const svc = service();
    const done = untilDone(svc);
    svc.startImport({ mode: "new", paths: [takeoutFolder()], name: "Mine", skipSpamTrash: false });
    await done;
    return { svc, c: svc.list(null)[0] };
  }

  it("renames, refusing empty and duplicate names", async () => {
    const { svc, c } = await withCollection();
    svc.rename(c.id, "  Old   letters ");
    expect(svc.get(c.id).name).toBe("Old letters");
    expect(() => svc.rename(c.id, " ")).toThrow(/needs a name/);
    svc.reg.collections.push({ ...c, id: "other", name: "Taken" });
    expect(() => svc.rename(c.id, "taken")).toThrow(/already a collection/);
  });

  it("removes from the list but keeps the files; deletes from disk", async () => {
    const { svc, c } = await withCollection();
    svc.remove(c.id);
    expect(svc.list(null)).toEqual([]);
    expect(fs.existsSync(path.join(c.path, "mail.db"))).toBe(true);
    svc.reg.collections.push(c);
    // The size from the database is the size of the files on disk.
    const size = svc.list(null, true)[0].sizeBytes!;
    expect(size).toBeGreaterThan(10_000);
    expect(Math.abs(size - folderSize(c.path))).toBeLessThan(64 * 1024); // only small files differ: mail.db-shm, folders
    // A deleted attachment file no longer counts.
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(c.path, "mail.db"));
    const biggest = db.prepare("SELECT id, size_bytes FROM attachments ORDER BY size_bytes DESC LIMIT 1").get() as { id: number; size_bytes: number };
    db.prepare("UPDATE attachments SET deleted_at = 1 WHERE id = ?").run(biggest.id);
    db.close();
    expect(collectionSize(c.path)).toBe(size - biggest.size_bytes);
    await svc.deleteFromDisk(c.id);
    expect(fs.existsSync(c.path)).toBe(false);
    expect(svc.list(null)).toEqual([]);
  });

  it("notices a missing folder and can locate it again", async () => {
    const { svc, c } = await withCollection();
    const moved = c.path + "-moved";
    fs.renameSync(c.path, moved);
    expect(svc.list(null)[0].missing).toBe(true);
    expect(svc.schemaStatus(c.id)).toBe("missing");
    expect(() => svc.locate(c.id, tempDir())).toThrow(/no mail\.db/);
    svc.locate(c.id, moved);
    expect(svc.list(null)[0]).toMatchObject({ missing: false, path: moved });
  });

  it("remembers where the viewer was, saving a moment later", () => {
    const dataDir = tempDir();
    const svc = service(dataDir);
    svc.reg.collections.push({ id: "a", name: "A", path: tempDir(), createdAt: 1, lastOpenedAt: null, incomplete: null });
    svc.save();
    svc.rememberView("a", "#/label/Work/t/123");
    svc.rememberView("a", "not a place"); // ignored
    svc.rememberView("gone", "#/inbox"); // no such collection: ignored
    expect(service(dataDir).get("a").lastView).toBeUndefined(); // not saved yet
    svc.flush();
    expect(service(dataDir).get("a").lastView).toBe("#/label/Work/t/123");
  });

  it("upgrades an older archive", async () => {
    const { svc, c } = await withCollection();
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(c.path, "mail.db"));
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    db.close();
    expect(svc.schemaStatus(c.id)).toBe("older");
    const states: string[] = [];
    const s = await svc.upgrade(c.id, (x) => states.push(x.phase));
    expect(s.phase).toBe("finished");
    expect(states[0]).toBe("running");
    expect(svc.schemaStatus(c.id)).toBe("ok");
  });
});
