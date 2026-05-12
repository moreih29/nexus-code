import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readdirCore, readFileCore, statCore } from "../../../../src/main/fs/core/read-core";
import { BINARY_DETECTION_BYTES, MAX_READABLE_FILE_SIZE } from "../../../../src/shared/fs-defaults";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nexus-read-core-"));
});

afterEach(async () => {
  await fs.promises.rm(tmpRoot, { recursive: true, force: true });
});

function expectIsoDate(value: string) {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(Number.isNaN(Date.parse(value))).toBe(false);
}

describe("readdirCore", () => {
  it("returns ordinary entries and filters hidden names", async () => {
    await fs.promises.writeFile(path.join(tmpRoot, "alpha.txt"), "alpha", "utf8");
    await fs.promises.mkdir(path.join(tmpRoot, "src"));
    await fs.promises.mkdir(path.join(tmpRoot, ".git"));
    await fs.promises.writeFile(path.join(tmpRoot, ".DS_Store"), "metadata", "utf8");

    const entries = await readdirCore(tmpRoot);

    expect([...entries].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "alpha.txt", type: "file" },
      { name: "src", type: "dir" },
    ]);
  });
});

describe("statCore", () => {
  it("reports file, directory, and symlink types with ISO mtimes", async () => {
    const filePath = path.join(tmpRoot, "note.txt");
    const dirPath = path.join(tmpRoot, "folder");
    const linkPath = path.join(tmpRoot, "note-link.txt");

    await fs.promises.writeFile(filePath, "hello", "utf8");
    await fs.promises.mkdir(dirPath);
    await fs.promises.symlink(filePath, linkPath);

    const fileStat = await statCore(filePath);
    const dirStat = await statCore(dirPath);
    const linkStat = await statCore(linkPath);

    expect(fileStat.type).toBe("file");
    expect(fileStat.isSymlink).toBe(false);
    expect(fileStat.size).toBe(5);
    expectIsoDate(fileStat.mtime);

    expect(dirStat.type).toBe("dir");
    expect(dirStat.isSymlink).toBe(false);
    expectIsoDate(dirStat.mtime);

    expect(linkStat.type).toBe("symlink");
    expect(linkStat.isSymlink).toBe(true);
    expectIsoDate(linkStat.mtime);
  });
});

describe("readFileCore", () => {
  it("returns utf8 text content", async () => {
    const filePath = path.join(tmpRoot, "hello.ts");
    const content = "export const answer = 42;\n";
    await fs.promises.writeFile(filePath, content, "utf8");

    const result = await readFileCore(filePath);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.content).toBe(content);
    expect(result.encoding).toBe("utf8");
    expect(result.sizeBytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(result.isBinary).toBe(false);
    expectIsoDate(result.mtime);
  });

  it('returns kind="missing" for ENOENT without throwing', async () => {
    const missingPath = path.join(tmpRoot, "missing.txt");

    const result = await readFileCore(missingPath);

    expect(result).toEqual({ kind: "missing", reason: "not-found" });
  });

  it("throws a too-large error before reading files larger than MAX_READABLE_FILE_SIZE", async () => {
    const filePath = path.join(tmpRoot, "too-large.txt");
    await fs.promises.writeFile(filePath, "x", "utf8");
    await fs.promises.truncate(filePath, MAX_READABLE_FILE_SIZE + 1);

    await expect(readFileCore(filePath)).rejects.toThrow(/^TOO_LARGE:/);
  });

  it("marks files with binary bytes inside BINARY_DETECTION_BYTES as binary", async () => {
    const filePath = path.join(tmpRoot, "binary.dat");
    const content = Buffer.alloc(BINARY_DETECTION_BYTES + 16, 0x41);
    content[BINARY_DETECTION_BYTES - 1] = 0x00;
    await fs.promises.writeFile(filePath, content);

    const result = await readFileCore(filePath);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.isBinary).toBe(true);
    expect(result.content).toBe("");
    expect(result.sizeBytes).toBe(content.length);
    expectIsoDate(result.mtime);
  });
});
