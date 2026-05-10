/**
 * Scenario tests for bounded HEAD reads and large Git blob streaming.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitError } from "../../../../src/main/git/git-error";
import {
  GIT_OPEN_FILE_AT_HEAD_MAX_BYTES,
  readAtHead,
  streamBlob,
} from "../../../../src/main/git/git-blob";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("git blob readers", () => {
  test("readAtHead decodes UTF-8 BOM text from cat-file batch output", async () => {
    const fixture = makeFakeCatFileRepo();

    await expect(readAtHead(fixture, "small.txt")).resolves.toEqual({
      content: "hello\n",
      encoding: "utf8-bom",
      sizeBytes: Buffer.byteLength("\ufeffhello\n"),
    });
  });

  test("readAtHead rejects oversized or binary blobs while streamBlob reads large blobs", async () => {
    const fixture = makeFakeCatFileRepo();

    try {
      await readAtHead(fixture, "large.txt");
      throw new Error("expected oversized read to throw");
    } catch (error) {
      expect((error as GitError).kind).toBe("binary-too-large");
    }

    try {
      await readAtHead(fixture, "binary.dat");
      throw new Error("expected binary read to throw");
    } catch (error) {
      expect((error as GitError).kind).toBe("binary-too-large");
    }

    const generator = streamBlob(fixture, "HEAD", "large.txt");
    let bytes = 0;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        expect(next.value).toEqual({ bytes: GIT_OPEN_FILE_AT_HEAD_MAX_BYTES + 1 });
        break;
      }
      bytes += next.value.chunk.byteLength;
    }
    expect(bytes).toBe(GIT_OPEN_FILE_AT_HEAD_MAX_BYTES + 1);
  });
});

/** Creates a fake git executable that implements the cat-file --batch rows used by the test. */
function makeFakeCatFileRepo(): { bin: string; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-blob-"));
  roots.push(root);
  const bin = path.join(root, "fake-git.cjs");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8').trim();
const oid = '0123456789abcdef0123456789abcdef01234567';
function writeBlob(buffer) {
  process.stdout.write(oid + ' blob ' + buffer.length + '\\n');
  process.stdout.write(buffer);
  process.stdout.write('\\n');
}
if (process.argv[2] !== 'cat-file' || process.argv[3] !== '--batch') process.exit(2);
if (input === 'HEAD:small.txt') writeBlob(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('hello\\n')]));
else if (input === 'HEAD:large.txt') writeBlob(Buffer.alloc(${GIT_OPEN_FILE_AT_HEAD_MAX_BYTES + 1}, 0x61));
else if (input === 'HEAD:binary.dat') writeBlob(Buffer.from([0x00, 0x01, 0x02, 0x03]));
else process.stdout.write(input + ' missing\\n');
`,
    "utf8",
  );
  fs.chmodSync(bin, 0o755);
  return { bin, cwd: root };
}
