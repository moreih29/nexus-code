/**
 * preAcquireLocationModels — unit tests.
 *
 * Verifies that LSP result locations (definition / references) trigger the
 * correct acquireModel calls and that release is scheduled after
 * PEEK_PREACQUIRE_HOLD_MS so monaco's peek widget can resolve URIs without
 * throwing "Model not found".
 *
 * Uses dependency injection (PreAcquireDeps) rather than mock.module on
 * model-cache. Bun's mock.module is process-global; replacing acquireModel
 * or releaseModel would pollute every other test file that touches
 * model-cache afterward (see Plan 20 lessons).
 */

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: mock(() => () => {}),
}));

const { PEEK_PREACQUIRE_HOLD_MS, preAcquireLocationModels } = await import(
  "../../../../../src/renderer/services/editor/lsp-result-preacquire"
);

import type { PreAcquireDeps } from "../../../../../src/renderer/services/editor/lsp-result-preacquire";
import type { EntryMetadata } from "../../../../../src/renderer/services/editor/model-cache";

const SOURCE_URI = "file:///workspace/src/main.ts";
const SOURCE_META: EntryMetadata = {
  workspaceId: "ws-1",
  filePath: "/workspace/src/main.ts",
  origin: "workspace",
  readOnly: false,
};

function makeLocation(uri: string): { uri: { toString(): string }; range: unknown } {
  return {
    uri: { toString: () => uri },
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
  };
}

let acquireMock: ReturnType<typeof mock>;
let releaseMock: ReturnType<typeof mock>;
let getEntryMetadataMock: ReturnType<typeof mock>;
let workspaceRootMock: ReturnType<typeof mock>;
let deps: PreAcquireDeps;

beforeEach(() => {
  acquireMock = mock((_input: unknown) =>
    Promise.resolve({ phase: "ready", model: null, readOnly: false }),
  );
  releaseMock = mock((_input: unknown) => {});
  getEntryMetadataMock = mock((_uri: string) => SOURCE_META as EntryMetadata | null);
  workspaceRootMock = mock((_id: string) => "/workspace" as string | null);
  deps = {
    acquireModel: acquireMock as unknown as PreAcquireDeps["acquireModel"],
    releaseModel: releaseMock as unknown as PreAcquireDeps["releaseModel"],
    getEntryMetadata: getEntryMetadataMock as unknown as PreAcquireDeps["getEntryMetadata"],
    workspaceRootForId: workspaceRootMock as unknown as PreAcquireDeps["workspaceRootForId"],
  };
});

afterEach(() => {
  // Ensure no scheduled timers leak between tests.
  jest.useRealTimers();
});

describe("preAcquireLocationModels", () => {
  test("returns early when locations array is empty", async () => {
    await preAcquireLocationModels([] as any, SOURCE_URI, deps);
    expect(acquireMock).not.toHaveBeenCalled();
    expect(getEntryMetadataMock).not.toHaveBeenCalled();
  });

  test("returns early when source model is not tracked in cache", async () => {
    getEntryMetadataMock.mockImplementation(() => null);
    await preAcquireLocationModels(
      [makeLocation("file:///workspace/lib.ts")] as any,
      SOURCE_URI,
      deps,
    );
    expect(acquireMock).not.toHaveBeenCalled();
  });

  test("acquires workspace-internal target with default origin/readOnly", async () => {
    await preAcquireLocationModels(
      [makeLocation("file:///workspace/src/lib.ts")] as any,
      SOURCE_URI,
      deps,
    );
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(acquireMock.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      filePath: "/workspace/src/lib.ts",
    });
  });

  test("acquires external target with origin=external, readOnly=true", async () => {
    await preAcquireLocationModels(
      [makeLocation("file:///external/typeshed/pathlib.pyi")] as any,
      SOURCE_URI,
      deps,
    );
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(acquireMock.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      filePath: "/external/typeshed/pathlib.pyi",
      origin: "external",
      readOnly: true,
    });
  });

  test("treats target as external when workspace root is null", async () => {
    workspaceRootMock.mockImplementation(() => null);
    await preAcquireLocationModels(
      [makeLocation("file:///workspace/src/lib.ts")] as any,
      SOURCE_URI,
      deps,
    );
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(acquireMock.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      filePath: "/workspace/src/lib.ts",
      origin: "external",
      readOnly: true,
    });
  });

  test("filters out self-references", async () => {
    await preAcquireLocationModels(
      [makeLocation(SOURCE_URI), makeLocation("file:///workspace/src/lib.ts")] as any,
      SOURCE_URI,
      deps,
    );
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect((acquireMock.mock.calls[0]?.[0] as { filePath: string }).filePath).toBe(
      "/workspace/src/lib.ts",
    );
  });

  test("dedupes multiple locations in the same file", async () => {
    const sameFile = "file:///workspace/src/lib.ts";
    await preAcquireLocationModels(
      [makeLocation(sameFile), makeLocation(sameFile), makeLocation(sameFile)] as any,
      SOURCE_URI,
      deps,
    );
    expect(acquireMock).toHaveBeenCalledTimes(1);
  });

  test("skips locations whose URI does not parse to a file path", async () => {
    await preAcquireLocationModels(
      [makeLocation("inmemory://model/1"), makeLocation("file:///workspace/src/lib.ts")] as any,
      SOURCE_URI,
      deps,
    );
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect((acquireMock.mock.calls[0]?.[0] as { filePath: string }).filePath).toBe(
      "/workspace/src/lib.ts",
    );
  });

  test("schedules release after PEEK_PREACQUIRE_HOLD_MS", async () => {
    jest.useFakeTimers();
    await preAcquireLocationModels(
      [makeLocation("file:///workspace/src/lib.ts")] as any,
      SOURCE_URI,
      deps,
    );
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(PEEK_PREACQUIRE_HOLD_MS - 1);
    expect(releaseMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      filePath: "/workspace/src/lib.ts",
    });
  });

  test("does not schedule release when acquireModel rejects", async () => {
    jest.useFakeTimers();
    acquireMock.mockImplementationOnce(() => Promise.reject(new Error("ENOENT")));
    await preAcquireLocationModels(
      [makeLocation("file:///workspace/src/missing.ts")] as any,
      SOURCE_URI,
      deps,
    );
    jest.advanceTimersByTime(PEEK_PREACQUIRE_HOLD_MS + 1);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  test("acquires multiple distinct targets in parallel", async () => {
    await preAcquireLocationModels(
      [
        makeLocation("file:///workspace/src/a.ts"),
        makeLocation("file:///workspace/src/b.ts"),
        makeLocation("file:///external/typeshed/c.pyi"),
      ] as any,
      SOURCE_URI,
      deps,
    );
    expect(acquireMock).toHaveBeenCalledTimes(3);
    const inputs = acquireMock.mock.calls.map((c) => c[0] as { filePath: string; origin?: string });
    expect(inputs.find((i) => i.filePath === "/workspace/src/a.ts")?.origin).toBeUndefined();
    expect(inputs.find((i) => i.filePath === "/workspace/src/b.ts")?.origin).toBeUndefined();
    expect(inputs.find((i) => i.filePath === "/external/typeshed/c.pyi")?.origin).toBe("external");
  });
});
