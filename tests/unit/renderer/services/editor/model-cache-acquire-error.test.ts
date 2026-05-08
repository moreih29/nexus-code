import { beforeEach, describe, expect, mock, test } from "bun:test";

const INPUT = {
  workspaceId: "ws-err",
  filePath: "/external/reject.py",
  origin: "external",
  readOnly: true,
} as const;

type ExternalInput = typeof INPUT;

function makeEntry(input: ExternalInput, loadPromise: Promise<void> = Promise.resolve()) {
  const uri = `file://${input.filePath}`;
  return {
    input: { ...input },
    cacheUri: uri,
    lspUri: uri,
    languageId: "python",
    refCount: 0,
    phase: "ready" as const,
    model: null,
    loadPromise,
    disposed: false,
    subscribers: new Set<() => void>(),
    readOnly: true,
  };
}

const realLoadExternalEntry = await import(
  "../../../../../src/renderer/services/editor/load-external-entry"
);
const loadExternalEntryMock = mock(async (input: ExternalInput) => makeEntry(input));
mock.module("../../../../../src/renderer/services/editor/load-external-entry", () => ({
  ...realLoadExternalEntry,
  loadExternalEntry: loadExternalEntryMock,
}));

const { acquireModel, getModelSnapshot, releaseModel } = await import(
  "../../../../../src/renderer/services/editor/model-cache"
);

beforeEach(() => {
  releaseModel(INPUT);
  releaseModel(INPUT);
  loadExternalEntryMock.mockClear();
  loadExternalEntryMock.mockImplementation(async (input: ExternalInput) => makeEntry(input));
});

describe("acquireModel — load rejection rollback", () => {
  test("removes an ipc-rejecting external entry and makes later releases no-ops", async () => {
    const ipcReject = new Error("ipc reject");
    loadExternalEntryMock.mockImplementationOnce(async (input: ExternalInput) =>
      makeEntry(input, Promise.reject(ipcReject)),
    );

    await expect(acquireModel(INPUT)).rejects.toThrow("ipc reject");

    expect(getModelSnapshot(INPUT)).toBeNull();
    releaseModel(INPUT);
    releaseModel(INPUT);

    await acquireModel(INPUT);
    expect(loadExternalEntryMock).toHaveBeenCalledTimes(2);
    releaseModel(INPUT);
  });
});
