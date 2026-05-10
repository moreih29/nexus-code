/**
 * Unit tests for the EMPTY_TREE short-circuit in readSideContent.
 *
 * When the repository is unborn (no commits yet), files-panel passes
 * EMPTY_TREE as leftRef so that diff-content-loader returns empty content
 * immediately without issuing a git.getFileContent IPC call.  This avoids
 * the "fatal: invalid object name HEAD" error that git emits before the
 * first commit exists.
 *
 * ISOLATION: `ipc/client` is a leaf module (IPC boundary) — mock.module is
 * permitted per pattern-bun-mock-conventions Rule 1.  We spread real exports
 * (Rule 2) and declare the mock before importing the module under test.
 *
 * SCOPE:
 *   1. EMPTY_TREE ref → ipcCall is NOT called, returns empty content.
 *   2. Normal git ref ("HEAD") → ipcCall IS called exactly once.
 *   3. AbortSignal already-aborted → ipcCall never called (abort before flight).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock ipc/client BEFORE the module under test is imported (Rule 1).
// ---------------------------------------------------------------------------
const realIpcClient = await import("../../../../../src/renderer/ipc/client");

const ipcCallMock = mock(() =>
  Promise.resolve({
    kind: "ok" as const,
    content: "file content",
    encoding: "utf8" as const,
    sizeBytes: 12,
    isBinary: false,
    mtime: "2024-01-01T00:00:00.000Z",
  }),
);

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpcClient,
  ipcCall: ipcCallMock,
  ipcListen: () => () => {},
}));

// ---------------------------------------------------------------------------
// Module under test — imported AFTER mock.module (Rule 1).
// ---------------------------------------------------------------------------
import { EMPTY_TREE } from "../../../../../src/renderer/components/editor/diff-refs";
import {
  readSideContent,
  type DiffSideRequest,
} from "../../../../../src/renderer/components/editor/diff-content-loader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(ref: string, source: DiffSideRequest["source"] = "git"): DiffSideRequest {
  return {
    side: "left",
    workspaceId: "ws-test",
    relPath: "src/foo.ts",
    ref,
    source,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readSideContent — EMPTY_TREE short-circuit", () => {
  beforeEach(() => {
    ipcCallMock.mockClear();
  });

  test("returns empty content immediately when ref is EMPTY_TREE — ipcCall not called", async () => {
    const request = makeRequest(EMPTY_TREE);
    const controller = new AbortController();

    const result = await readSideContent(request, controller.signal);

    // No IPC call should be issued for the empty-tree sentinel.
    expect(ipcCallMock).not.toHaveBeenCalled();

    // Content must be empty with deterministic shape.
    expect(result.content).toBe("");
    expect(result.encoding).toBe("utf8");
    expect(result.sizeBytes).toBe(0);
    expect(result.isBinary).toBe(false);
  });

  test("calls ipcCall exactly once when ref is a normal git ref ('HEAD')", async () => {
    const request = makeRequest("HEAD");
    const controller = new AbortController();

    const result = await readSideContent(request, controller.signal);

    expect(ipcCallMock).toHaveBeenCalledTimes(1);
    // Verify it was called with the git channel and correct args.
    const [channel, method, args] = ipcCallMock.mock.calls[0] as [string, string, unknown];
    expect(channel).toBe("git");
    expect(method).toBe("getFileContent");
    expect((args as { ref: string }).ref).toBe("HEAD");

    expect(result.content).toBe("file content");
  });

  test("calls ipcCall exactly once when ref is INDEX (working-tree fs source)", async () => {
    // INDEX ref with source=git → goes through git.getFileContent
    const request = makeRequest("INDEX", "git");
    const controller = new AbortController();

    await readSideContent(request, controller.signal);

    expect(ipcCallMock).toHaveBeenCalledTimes(1);
  });

  test("EMPTY_TREE result isBinary=false so diff renderer shows a text empty panel", async () => {
    const request = makeRequest(EMPTY_TREE);
    const controller = new AbortController();

    const result = await readSideContent(request, controller.signal);

    expect(result.isBinary).toBe(false);
    expect(result.sizeBytes).toBe(0);
  });
});
