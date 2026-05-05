import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteFile,
  type ExpectedFileState,
} from "../../../../src/main/filesystem/atomic-write";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-atomic-write-test-"));
}

function readUtf8(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function statExpected(p: string): ExpectedFileState {
  const s = fs.lstatSync(p);
  return { exists: true, mtime: s.mtime.toISOString(), size: s.size };
}

describe("atomicWriteFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a new file when expected.exists=false", async () => {
    const target = path.join(tmpDir, "new.txt");
    const result = await atomicWriteFile(target, "hello", { expected: { exists: false } });
    expect(result.kind).toBe("ok");
    expect(readUtf8(target)).toBe("hello");
  });

  it("returns conflict when target exists but expected.exists=false", async () => {
    const target = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(target, "prior");
    const result = await atomicWriteFile(target, "new", { expected: { exists: false } });
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.actual.exists).toBe(true);
    }
    expect(readUtf8(target)).toBe("prior");
  });

  it("overwrites when expected mtime/size matches", async () => {
    const target = path.join(tmpDir, "f.txt");
    fs.writeFileSync(target, "first");
    const expected = statExpected(target);
    const result = await atomicWriteFile(target, "second", { expected });
    expect(result.kind).toBe("ok");
    expect(readUtf8(target)).toBe("second");
  });

  it("returns conflict when on-disk mtime no longer matches expected", async () => {
    const target = path.join(tmpDir, "f.txt");
    fs.writeFileSync(target, "first");
    const expected = statExpected(target);
    // Mutate externally — different size and a definite mtime bump.
    fs.utimesSync(target, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    fs.writeFileSync(target, "DIFFERENT external content");

    const result = await atomicWriteFile(target, "ours", { expected });
    expect(result.kind).toBe("conflict");
    expect(readUtf8(target)).toBe("DIFFERENT external content");
  });

  it("returns conflict when expected.exists=true but file was deleted", async () => {
    const target = path.join(tmpDir, "f.txt");
    fs.writeFileSync(target, "first");
    const expected = statExpected(target);
    fs.unlinkSync(target);

    const result = await atomicWriteFile(target, "ours", { expected });
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.actual.exists).toBe(false);
    }
  });

  it("does not leave any tmp files in the directory after a successful write", async () => {
    const target = path.join(tmpDir, "f.txt");
    fs.writeFileSync(target, "first");
    const expected = statExpected(target);
    await atomicWriteFile(target, "second", { expected });
    const entries = fs.readdirSync(tmpDir);
    expect(entries.filter((n) => n.startsWith(".nexus-tmp-"))).toEqual([]);
  });

  it("returns mtime+size of the written content", async () => {
    const target = path.join(tmpDir, "f.txt");
    const content = "abcdef\n";
    const result = await atomicWriteFile(target, content, { expected: { exists: false } });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.size).toBe(Buffer.byteLength(content, "utf8"));
      const stat = fs.lstatSync(target);
      expect(result.mtime).toBe(stat.mtime.toISOString());
    }
  });

  it("writes through a symlink without replacing it", async () => {
    const real = path.join(tmpDir, "real.txt");
    const link = path.join(tmpDir, "link.txt");
    fs.writeFileSync(real, "first");
    fs.symlinkSync(real, link);

    const expected = statExpected(link);
    const result = await atomicWriteFile(link, "second", { expected });
    expect(result.kind).toBe("ok");
    expect(readUtf8(real)).toBe("second");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
