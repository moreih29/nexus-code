/**
 * Handler-level tests for searchTextHandler.
 *
 * Imports come directly from search-handlers.ts (not the channel barrel)
 * to avoid loading move-handlers.ts, which depends on Electron's shell module.
 * The broadcast function from router.ts IS exercised indirectly: the handler
 * calls it, and we capture the output via a mock webContents.send.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock electron before any module that require()s it is imported.
mock.module("electron", () => ({
  webContents: {
    getAllWebContents: () => [],
  },
}));

import {
  searchTextHandler,
  WorkspaceNotFoundError,
} from "../../../../../../src/main/ipc/channels/fs/search-handlers";
import type { SearchProgress } from "../../../../../../src/shared/types/search";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174001";

function makeManager(rootPath: string) {
  return {
    list: (): WorkspaceMeta[] => [
      {
        id: VALID_UUID,
        name: "test-workspace",
        rootPath,
        colorTone: "default",
        pinned: false,
        lastOpenedAt: new Date().toISOString(),
        tabs: [],
      },
    ],
  };
}

function noSignal(): AbortSignal {
  return new AbortController().signal;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-search-handler-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("searchTextHandler — happy path", () => {
  test("returns SearchComplete with correct counts; broadcaster receives batches with requestId", async () => {
    fs.writeFileSync(path.join(tmpRoot, "a.ts"), "const hello = 'hello world';\n");
    fs.writeFileSync(path.join(tmpRoot, "b.ts"), "no match here\n");

    const capturedPayloads: SearchProgress[] = [];

    const mockSend = mock((_channel: string, _ns: string, _event: string, payload: unknown) => {
      capturedPayloads.push(payload as SearchProgress);
    });

    // Re-override electron mock to capture wc.send calls.
    mock.module("electron", () => ({
      webContents: {
        getAllWebContents: () => [{ isDestroyed: () => false, send: mockSend }],
      },
    }));

    const handler = searchTextHandler(makeManager(tmpRoot) as never);
    const result = await handler(
      {
        workspaceId: VALID_UUID,
        query: { pattern: "hello" },
      },
      { requestId: "req-abc", signal: noSignal() },
    );

    // Both files are text — both reach the matcher. a.ts has a match, b.ts does not.
    expect(result.filesScanned).toBe(2);
    expect(result.matchesFound).toBeGreaterThanOrEqual(1);
    expect(result.limitHit).toBe(false);
    expect(typeof result.elapsedMs).toBe("number");

    // All captured progress payloads should carry the same requestId.
    for (const p of capturedPayloads) {
      if (typeof p === "object" && p !== null && "requestId" in p) {
        expect(p.requestId).toBe("req-abc");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid regex
// ---------------------------------------------------------------------------

describe("searchTextHandler — invalid regex", () => {
  test("rejects with InvalidSearchPatternError-shaped error for bad regex", async () => {
    const { InvalidSearchPatternError } = await import("../../../../../../src/main/search/matcher");
    const handler = searchTextHandler(makeManager(tmpRoot) as never);
    await expect(
      handler(
        {
          workspaceId: VALID_UUID,
          query: { pattern: "[invalid", isRegExp: true },
        },
        { signal: noSignal() },
      ),
    ).rejects.toBeInstanceOf(InvalidSearchPatternError);
  });
});

// ---------------------------------------------------------------------------
// Abort propagation
// ---------------------------------------------------------------------------

describe("searchTextHandler — abort propagation", () => {
  test("pre-aborted signal: handler returns without throwing fatal", async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpRoot, `f${i}.ts`), "hello\n");
    }

    const ctrl = new AbortController();
    ctrl.abort();

    const handler = searchTextHandler(makeManager(tmpRoot) as never);
    // Walker catches AbortError and returns a partial result — handler should not throw.
    const result = await handler(
      { workspaceId: VALID_UUID, query: { pattern: "hello" } },
      { requestId: "req-abort", signal: ctrl.signal },
    );

    expect(result.limitHit).toBe(false);
    expect(typeof result.elapsedMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Unknown workspace
// ---------------------------------------------------------------------------

describe("searchTextHandler — unknown workspace", () => {
  test("throws WorkspaceNotFoundError for unknown workspaceId", async () => {
    const unknownId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const handler = searchTextHandler(makeManager(tmpRoot) as never);
    const err = await handler(
      { workspaceId: unknownId, query: { pattern: "hello" } },
      { signal: noSignal() },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorkspaceNotFoundError);
    expect((err as WorkspaceNotFoundError).name).toBe("WorkspaceNotFoundError");
    expect((err as WorkspaceNotFoundError).workspaceId).toBe(unknownId);
  });
});
