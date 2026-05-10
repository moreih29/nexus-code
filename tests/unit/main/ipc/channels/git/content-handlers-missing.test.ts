/**
 * Verification tests for content-handlers.ts — FileReadResult round-trip.
 *
 * Focus:
 *   (a) GitError(kind:"missing") catch → {kind:"missing"} resolve, NOT re-throw
 *   (b) Other GitError kinds (unknown, not-repo, output-too-large) → still throw
 *   (c) WORKING ref → throws immediately (does not call repo.getFileContent)
 *   (d) missingReasonForRef logic: INDEX→"index", HEAD→"ref", SHA→"ref", other→"not-found"
 *
 * ISOLATION: getFileContentHandler accepts a GitRegistry object.  We use
 * minimal duck-typed stubs (DI-first per pattern-bun-mock-conventions Rule 1).
 */

import { describe, expect, it } from "bun:test";
import { getFileContentHandler } from "../../../../../../src/main/ipc/channels/git/content-handlers";
import { GitError } from "../../../../../../src/main/git/git-error";

// ---------------------------------------------------------------------------
// Minimal stub helpers
// ---------------------------------------------------------------------------

/** Builds a registry stub where getOrDetect returns a repo stub. */
function makeRegistry(repo: { getFileContent: (ref: string, relPath: string, signal?: AbortSignal) => Promise<string> } | null) {
  return {
    getOrDetect: async (_workspaceId: string, _signal?: AbortSignal) => repo,
  };
}

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

function callHandler(registry: ReturnType<typeof makeRegistry>, args: unknown) {
  const handler = getFileContentHandler(registry as never);
  return handler(args);
}

// ---------------------------------------------------------------------------
// (a) GitError(kind:"missing") → resolves {kind:"missing"}, does NOT throw
// ---------------------------------------------------------------------------

describe("content-handlers — GitError(kind:missing) is caught → resolves missing", () => {
  it("resolves {kind:'missing', reason:'index'} for INDEX ref", async () => {
    const repo = {
      getFileContent: async () => {
        throw new GitError("missing", "pathspec did not match any file");
      },
    };
    const result = await callHandler(makeRegistry(repo), {
      workspaceId: VALID_UUID,
      ref: "INDEX",
      relPath: "src/foo.ts",
    });
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") return;
    expect(result.reason).toBe("index");
  });

  it("resolves {kind:'missing', reason:'ref'} for HEAD ref", async () => {
    const repo = {
      getFileContent: async () => {
        throw new GitError("missing", "invalid object name HEAD");
      },
    };
    const result = await callHandler(makeRegistry(repo), {
      workspaceId: VALID_UUID,
      ref: "HEAD",
      relPath: "src/bar.ts",
    });
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") return;
    expect(result.reason).toBe("ref");
  });

  it("resolves {kind:'missing', reason:'ref'} for a 40-char SHA", async () => {
    const repo = {
      getFileContent: async () => {
        throw new GitError("missing", "invalid object name");
      },
    };
    const sha = "a".repeat(40);
    const result = await callHandler(makeRegistry(repo), {
      workspaceId: VALID_UUID,
      ref: sha,
      relPath: "README.md",
    });
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") return;
    expect(result.reason).toBe("ref");
  });

  it("resolves {kind:'missing', reason:'ref'} for a short SHA (4+ hex chars)", async () => {
    const repo = {
      getFileContent: async () => {
        throw new GitError("missing", "invalid object name");
      },
    };
    const result = await callHandler(makeRegistry(repo), {
      workspaceId: VALID_UUID,
      ref: "abcd",
      relPath: "file.ts",
    });
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") return;
    expect(result.reason).toBe("ref");
  });

  it("resolves {kind:'missing', reason:'not-found'} for an unrecognised ref", async () => {
    const repo = {
      getFileContent: async () => {
        throw new GitError("missing", "unknown");
      },
    };
    const result = await callHandler(makeRegistry(repo), {
      workspaceId: VALID_UUID,
      ref: "my-custom-tag",
      relPath: "file.ts",
    });
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") return;
    expect(result.reason).toBe("not-found");
  });
});

// ---------------------------------------------------------------------------
// (b) Other GitError kinds must still throw (not silently swallowed)
// ---------------------------------------------------------------------------

describe("content-handlers — non-missing GitError still throws", () => {
  it("re-throws GitError(kind:'unknown')", async () => {
    const repo = {
      getFileContent: async () => {
        throw new GitError("unknown", "something went wrong");
      },
    };
    await expect(
      callHandler(makeRegistry(repo), {
        workspaceId: VALID_UUID,
        ref: "HEAD",
        relPath: "src/foo.ts",
      }),
    ).rejects.toThrow("something went wrong");
  });

  it("re-throws GitError(kind:'output-too-large')", async () => {
    const repo = {
      getFileContent: async () => {
        throw new GitError("output-too-large", "Git output exceeded 50 MB limit");
      },
    };
    await expect(
      callHandler(makeRegistry(repo), {
        workspaceId: VALID_UUID,
        ref: "HEAD",
        relPath: "large-file.bin",
      }),
    ).rejects.toThrow(/exceeded/);
  });

  it("re-throws arbitrary Error (not a GitError)", async () => {
    const repo = {
      getFileContent: async () => {
        throw new Error("disk full");
      },
    };
    await expect(
      callHandler(makeRegistry(repo), {
        workspaceId: VALID_UUID,
        ref: "HEAD",
        relPath: "file.ts",
      }),
    ).rejects.toThrow("disk full");
  });
});

// ---------------------------------------------------------------------------
// (c) WORKING ref → throws immediately, repo.getFileContent is NOT called
// ---------------------------------------------------------------------------

describe("content-handlers — WORKING ref throws without calling repo", () => {
  it("throws GitError(kind:'unknown') for WORKING ref", async () => {
    let callCount = 0;
    const repo = {
      getFileContent: async () => {
        callCount++;
        return "content";
      },
    };
    await expect(
      callHandler(makeRegistry(repo), {
        workspaceId: VALID_UUID,
        ref: "WORKING",
        relPath: "src/foo.ts",
      }),
    ).rejects.toThrow(/does not support WORKING/);
    expect(callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (d) not-repo case: registry returns null → throws GitError(kind:'not-repo')
// ---------------------------------------------------------------------------

describe("content-handlers — no repo detected → throws not-repo", () => {
  it("throws when registry returns null", async () => {
    await expect(
      callHandler(makeRegistry(null), {
        workspaceId: VALID_UUID,
        ref: "HEAD",
        relPath: "src/foo.ts",
      }),
    ).rejects.toThrow(/Not a Git repository/);
  });
});

// ---------------------------------------------------------------------------
// (e) Happy-path: repo.getFileContent returns plain utf-8 → ok result
// ---------------------------------------------------------------------------

describe("content-handlers — happy path: utf-8 content → {kind:'ok'}", () => {
  it("returns ok variant with correct fields", async () => {
    const content = "export const x = 1;\n";
    const repo = {
      getFileContent: async () => content,
    };
    const result = await callHandler(makeRegistry(repo), {
      workspaceId: VALID_UUID,
      ref: "HEAD",
      relPath: "src/x.ts",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.content).toBe(content);
    expect(result.encoding).toBe("utf8");
    expect(result.isBinary).toBe(false);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(typeof result.mtime).toBe("string");
  });
});
