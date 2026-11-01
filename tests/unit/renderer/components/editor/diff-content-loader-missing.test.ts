/**
 * Verification tests for diff-content-loader.ts — result.kind dispatch.
 *
 * Focus:
 *   (a) When IPC returns {kind:"missing"} → readSideContent resolves with
 *       placeholder:"missing" and empty content (NOT throws).
 *   (b) When IPC returns {kind:"ok"} → readSideContent resolves with content.
 *
 * ISOLATION: ipc/client is a leaf module. mock.module is permitted per
 * pattern-bun-mock-conventions Rule 1. Real exports spread (Rule 2).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock ipc/client BEFORE importing the module under test (Rule 1).
// ---------------------------------------------------------------------------
const realIpcClient = await import("../../../../../src/renderer/ipc/client");

const ipcCallMock = mock(async () => ({
  ok: true as const,
  value: {
    kind: "ok" as const,
    content: "default content",
    encoding: "utf8" as const,
    sizeBytes: 15,
    isBinary: false,
    mtime: "2024-01-01T00:00:00.000Z",
  },
}));

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpcClient,
  ipcCallResult: ipcCallMock,
  ipcListen: () => () => {},
}));

// ---------------------------------------------------------------------------
// Module under test — imported AFTER mock.module.
// ---------------------------------------------------------------------------
import {
  type DiffSideRequest,
  readSideContent,
} from "../../../../../src/renderer/components/editor/diff-content-loader";

function makeGitRequest(ref: string): DiffSideRequest {
  return {
    side: "left",
    workspaceId: "ws-test",
    relPath: "src/foo.ts",
    ref,
    source: "git",
  };
}

function makeFsRequest(): DiffSideRequest {
  return {
    side: "right",
    workspaceId: "ws-test",
    relPath: "src/foo.ts",
    ref: "WORKING",
    source: "fs",
  };
}

// ---------------------------------------------------------------------------
// (a) IPC returns {kind:"missing"} → placeholder:"missing", no throw
// ---------------------------------------------------------------------------

describe("readSideContent — kind:missing IPC response → placeholder missing, no throw", () => {
  beforeEach(() => ipcCallMock.mockClear());

  test("git source: {kind:'missing'} resolves with placeholder:'missing' and empty content", async () => {
    ipcCallMock.mockImplementationOnce(async () => ({
      ok: true as const,
      value: { kind: "missing" as const, reason: "index" as const },
    }));

    const request = makeGitRequest("INDEX");
    const controller = new AbortController();

    const result = await readSideContent(request, controller.signal);

    expect(result.content).toBe("");
    expect(result.sizeBytes).toBe(0);
    expect(result.isBinary).toBe(false);
    expect(result.placeholder).toBe("missing");
  });

  test("fs source: {kind:'missing'} resolves with placeholder:'missing' and empty content", async () => {
    ipcCallMock.mockImplementationOnce(async () => ({
      ok: true as const,
      value: { kind: "missing" as const, reason: "not-found" as const },
    }));

    const request = makeFsRequest();
    const controller = new AbortController();

    const result = await readSideContent(request, controller.signal);

    expect(result.content).toBe("");
    expect(result.placeholder).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// (b) IPC returns {kind:"ok"} → normal content forwarded
// ---------------------------------------------------------------------------

describe("readSideContent — kind:ok IPC response → content forwarded", () => {
  beforeEach(() => ipcCallMock.mockClear());

  test("git source: {kind:'ok'} resolves with correct content and no placeholder", async () => {
    const okPayload = {
      kind: "ok" as const,
      content: "const x = 42;\n",
      encoding: "utf8" as const,
      sizeBytes: 15,
      isBinary: false,
      mtime: "2024-05-01T00:00:00.000Z",
    };
    ipcCallMock.mockImplementationOnce(async () => ({ ok: true as const, value: okPayload }));

    const request = makeGitRequest("HEAD");
    const controller = new AbortController();

    const result = await readSideContent(request, controller.signal);

    expect(result.content).toBe("const x = 42;\n");
    expect(result.encoding).toBe("utf8");
    expect(result.isBinary).toBe(false);
    expect(result.placeholder).toBeUndefined();
  });

  test("utf8-bom encoding is passed through unchanged", async () => {
    ipcCallMock.mockImplementationOnce(async () => ({
      ok: true as const,
      value: {
        kind: "ok" as const,
        content: "// BOM file\n",
        encoding: "utf8-bom" as const,
        sizeBytes: 12,
        isBinary: false,
        mtime: "2024-05-01T00:00:00.000Z",
      },
    }));

    const request = makeGitRequest("HEAD");
    const controller = new AbortController();

    const result = await readSideContent(request, controller.signal);

    expect(result.encoding).toBe("utf8-bom");
  });
});
