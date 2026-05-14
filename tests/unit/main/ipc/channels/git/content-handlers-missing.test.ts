/**
 * Verification tests for content-handlers.ts — agent-backed path.
 *
 * The legacy GitRepository fallback has been removed; getFileContentHandler
 * now requires a WorkspaceManager with an agent-backed provider.
 *
 * Remaining scenarios:
 *   (a) WORKING ref → throws immediately (before agent call)
 *   (b) Missing manager → throws immediately
 *   (c) Non-agent-backed provider → throws immediately
 *   (d) Agent-backed production path → calls git.getFileContent on the agent
 */

import { describe, expect, it } from "bun:test";
import { GitError } from "../../../../../../src/main/features/git/domain/git-error";
import { getFileContentHandler } from "../../../../../../src/main/features/git/ipc/content-handlers";

// ---------------------------------------------------------------------------
// Minimal stub helpers
// ---------------------------------------------------------------------------

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

/** Builds a minimal registry stub (legacy path removed; registry is now unused in handler). */
function makeRegistry() {
  return {};
}

function makeManager(provider: unknown) {
  return {
    requireContext: () => ({ fs: provider }),
  };
}

/** Agent-backed provider stub that records calls. */
function makeAgentProvider(returnValue: unknown = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    provider: {
      kind: "local" as const,
      callAgentMethod: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return returnValue;
      },
      onAgentEvent: () => () => {},
    },
  };
}

// ---------------------------------------------------------------------------
// (a) WORKING ref → throws immediately, agent is NOT called
// ---------------------------------------------------------------------------

describe("content-handlers — WORKING ref throws without calling agent", () => {
  it("throws GitError(kind:'unknown') for WORKING ref", async () => {
    const { provider } = makeAgentProvider();
    const handler = getFileContentHandler(makeRegistry() as never, makeManager(provider) as never);

    await expect(
      handler({ workspaceId: VALID_UUID, ref: "WORKING", relPath: "src/foo.ts" }),
    ).rejects.toThrow(/does not support WORKING/);
  });
});

// ---------------------------------------------------------------------------
// (b) Missing manager → throws immediately
// ---------------------------------------------------------------------------

describe("content-handlers — missing manager throws", () => {
  it("throws when manager is not provided", async () => {
    const handler = getFileContentHandler(makeRegistry() as never);

    await expect(
      handler({ workspaceId: VALID_UUID, ref: "HEAD", relPath: "src/foo.ts" }),
    ).rejects.toThrow(/workspace manager/);
  });
});

// ---------------------------------------------------------------------------
// (c) Non-agent-backed provider → throws
// ---------------------------------------------------------------------------

describe("content-handlers — non-agent-backed provider throws", () => {
  it("throws when provider does not have callAgentMethod", async () => {
    const nonAgentProvider = { kind: "local" };
    const handler = getFileContentHandler(
      makeRegistry() as never,
      makeManager(nonAgentProvider) as never,
    );

    await expect(
      handler({ workspaceId: VALID_UUID, ref: "HEAD", relPath: "src/foo.ts" }),
    ).rejects.toThrow(/agent-backed/);
  });
});

// ---------------------------------------------------------------------------
// (d) Agent-backed production path
// ---------------------------------------------------------------------------

describe("content-handlers — agent-backed production path", () => {
  it("uses git.getFileContent on the workspace agent", async () => {
    const { calls, provider } = makeAgentProvider({
      kind: "ok",
      content: "agent content",
      encoding: "utf8",
      sizeBytes: 13,
      isBinary: false,
      mtime: "2026-01-01T00:00:00.000Z",
    });
    const handler = getFileContentHandler(makeRegistry() as never, makeManager(provider) as never);

    const result = await handler({
      workspaceId: VALID_UUID,
      ref: "HEAD",
      relPath: "src/x.ts",
    });

    expect(result).toMatchObject({ kind: "ok", content: "agent content" });
    expect(calls).toEqual([
      { method: "git.getFileContent", params: { ref: "HEAD", relPath: "src/x.ts" } },
    ]);
  });

  it("passes ref and relPath verbatim to the agent", async () => {
    const sha = "a".repeat(40);
    const { calls, provider } = makeAgentProvider({
      kind: "missing",
      reason: "ref",
    });
    const handler = getFileContentHandler(makeRegistry() as never, makeManager(provider) as never);

    await handler({ workspaceId: VALID_UUID, ref: sha, relPath: "deep/file.ts" });

    expect(calls[0]).toMatchObject({ method: "git.getFileContent", params: { ref: sha, relPath: "deep/file.ts" } });
  });
});
