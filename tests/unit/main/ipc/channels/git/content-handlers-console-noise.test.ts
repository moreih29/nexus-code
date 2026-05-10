/**
 * Console no-noise verification for content-handlers.ts.
 *
 * Electron's ipcMain.handle will log an unhandled rejection to stderr whenever
 * a handler throws.  The contract fix means handlers should RESOLVE (not throw)
 * for domain-normal "not found" cases.  This test verifies that:
 *
 *   - When repo.getFileContent throws GitError(kind:"missing"), the handler
 *     resolves — its returned Promise fulfills, not rejects.
 *   - No stderr output is produced by the handler itself (stderr capture).
 *
 * The test captures process.stderr.write to detect any accidental console output.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getFileContentHandler } from "../../../../../../src/main/ipc/channels/git/content-handlers";
import { GitError } from "../../../../../../src/main/git/git-error";

// ---------------------------------------------------------------------------
// Stderr capture helpers
// ---------------------------------------------------------------------------

type WriteArgs = Parameters<typeof process.stderr.write>;

let stderrLines: string[] = [];
let originalStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  stderrLines = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: WriteArgs[0], ...rest: WriteArgs[1 extends undefined ? never : any[]]) => {
    stderrLines.push(String(chunk));
    return true;
  };
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
});

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

function makeRegistry(repo: { getFileContent: (...a: unknown[]) => Promise<string> } | null) {
  return {
    getOrDetect: async () => repo,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("content-handlers console no-noise — INDEX missing", () => {
  it("handler resolves (does not reject) when repo throws GitError(kind:missing)", async () => {
    const repo = {
      getFileContent: async () => {
        throw new GitError("missing", "pathspec ':src/foo.ts' did not match any file");
      },
    };

    const handler = getFileContentHandler(makeRegistry(repo) as never);

    // Must resolve, not reject.
    const result = await handler({ workspaceId: VALID_UUID, ref: "INDEX", relPath: "src/foo.ts" });

    expect(result.kind).toBe("missing");
  });

  it("no stderr output is produced when handler catches GitError(kind:missing)", async () => {
    const repo = {
      getFileContent: async () => {
        throw new GitError("missing", "pathspec ':src/foo.ts' did not match any file");
      },
    };

    const handler = getFileContentHandler(makeRegistry(repo) as never);
    await handler({ workspaceId: VALID_UUID, ref: "INDEX", relPath: "src/foo.ts" });

    // No error output should appear — the handler swallowed this as a resolve path.
    const noiseLines = stderrLines.filter((l) =>
      l.includes("GitError") || l.includes("missing") || l.includes("Unhandled"),
    );
    expect(noiseLines).toHaveLength(0);
  });

  it("handler resolves for ORIG_HEAD ref with kind:missing → no stderr", async () => {
    const repo = {
      getFileContent: async () => {
        throw new GitError("missing", "fatal: invalid object name ORIG_HEAD");
      },
    };

    const handler = getFileContentHandler(makeRegistry(repo) as never);
    const result = await handler({
      workspaceId: VALID_UUID,
      ref: "ORIG_HEAD",
      relPath: "src/bar.ts",
    });

    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") return;
    expect(result.reason).toBe("ref");

    const noiseLines = stderrLines.filter((l) =>
      l.includes("GitError") || l.includes("Unhandled"),
    );
    expect(noiseLines).toHaveLength(0);
  });
});

describe("content-handlers console no-noise — non-missing GitError DOES produce stderr", () => {
  it("re-thrown error (kind:unknown) causes Promise rejection (caller sees error)", async () => {
    const repo = {
      getFileContent: async () => {
        throw new GitError("unknown", "disk full");
      },
    };

    const handler = getFileContentHandler(makeRegistry(repo) as never);

    // This SHOULD reject — and Electron would log it to stderr.
    await expect(
      handler({ workspaceId: VALID_UUID, ref: "HEAD", relPath: "src/foo.ts" }),
    ).rejects.toThrow("disk full");
  });
});
