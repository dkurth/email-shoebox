import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Collection } from "../src/shared/api.ts";
import {
  addMissingFromFolder,
  EMPTY,
  loadRegistry,
  markOpened,
  namesInUse,
  newCollectionDir,
  saveRegistry,
  slug,
  startupCollection,
  uniqueName,
} from "../src/main/registry.ts";
import { tempDir } from "./helpers.ts";

const col = (id: string, name: string, extra: Partial<Collection> = {}): Collection => ({
  id,
  name,
  path: `/tmp/${id}`,
  createdAt: 1000,
  lastOpenedAt: null,
  incomplete: null,
  ...extra,
});

describe("registry", () => {
  it("saves and loads, and starts empty when the file is missing or broken", () => {
    const dir = tempDir();
    const file = path.join(dir, "collections.json");
    expect(loadRegistry(file)).toEqual(EMPTY);
    const reg = { ...structuredClone(EMPTY), collections: [col("a", "Personal")] };
    saveRegistry(file, reg);
    expect(loadRegistry(file)).toEqual(reg);
    fs.writeFileSync(file, "{not json");
    expect(loadRegistry(file)).toEqual(EMPTY);
  });

  it("makes names unique, ignoring case", () => {
    expect(uniqueName("Personal", [])).toBe("Personal");
    expect(uniqueName("Personal", ["personal"])).toBe("Personal 2");
    expect(uniqueName("Personal", ["Personal", "Personal 2"])).toBe("Personal 3");
    expect(uniqueName("  ", [])).toBe("Mail");
    const reg = { ...structuredClone(EMPTY), collections: [col("a", "A"), col("b", "B")] };
    expect(namesInUse(reg, "a")).toEqual(["B"]);
  });

  it("makes folder names from collection names", () => {
    expect(slug("Personal 2024")).toBe("personal-2024");
    expect(slug("me@example.com (2004–2024)")).toBe("me-at-example-com-2004-2024");
    expect(slug("Ünïcödé")).toBe("unicode");
    expect(slug("!!!")).toBe("mail");
    const parent = tempDir();
    fs.mkdirSync(path.join(parent, "personal"));
    expect(newCollectionDir(parent, "Personal")).toBe(path.join(parent, "personal-2"));
  });

  it("opens the last collection at start-up, else the most recent", () => {
    const reg = { ...structuredClone(EMPTY), collections: [col("a", "A", { createdAt: 1 }), col("b", "B", { createdAt: 2 })] };
    expect(startupCollection(reg)?.id).toBe("b");
    markOpened(reg, "a", 5);
    expect(startupCollection(reg)?.id).toBe("a");
    expect(startupCollection(structuredClone(EMPTY))).toBeUndefined();
  });

  it("adds archive folders that the list doesn't know", () => {
    const dir = tempDir();
    for (const f of ["one", "two", "not-an-archive"]) fs.mkdirSync(path.join(dir, f));
    fs.writeFileSync(path.join(dir, "one", "mail.db"), "");
    fs.writeFileSync(path.join(dir, "two", "mail.db"), "");
    const reg = { ...structuredClone(EMPTY), collections: [col("x", "Two", { path: path.join(dir, "two") })] };
    const added = addMissingFromFolder(reg, dir, (d) => (d.endsWith("one") ? "Saved name" : undefined));
    expect(added).toBe(1);
    expect(reg.collections.map((c) => c.name)).toEqual(["Two", "Saved name"]);
    expect(addMissingFromFolder(reg, path.join(dir, "missing"), () => undefined)).toBe(0);
  });
});
