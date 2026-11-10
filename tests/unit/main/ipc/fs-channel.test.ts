import { describe, expect, it, mock } from "bun:test";
import {
  clearOutsideGrants,
  setOutsideGrant,
} from "../../../../src/main/features/fs/outside-grants";
import type { FsProvider } from "../../../../src/main/features/fs/bridge/provider";
import {
  readExternalHandler,
  readRangeHandler,
} from "../../../../src/main/features/fs/ipc/read-handlers";
import type {
  DirEntry,
  FileReadBinaryResult,
  FileReadResult,
  FsStat,
  WriteFileResult,
} from "../../../../src/shared/fs/types";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";

function makeProvider(overrides: Partial<FsProvider> = {}) {
  const readdir = mock(async (_relPath: string): Promise<DirEntry[]> => []);
  const stat = mock(
    async (_relPath: string): Promise<FsStat> => ({
      type: "file",
      size: 12,
      mtime: "2026-01-01T00:00:00.000Z",
      isSymlink: false,
    }),
  );
  const readFile = mock(
    async (_relPath: string): Promise<FileReadResult> => ({
      kind: "ok",
      content: "hello",
      encoding: "utf8",
      sizeBytes: 5,
      isBinary: false,
      mtime: "2026-01-01T00:00:00.000Z",
    }),
  );
  const readAbsolute = mock(
    async (_absolutePath: string): Promise<FileReadResult> => ({
      kind: "ok",
      content: "external",
      encoding: "utf8",
      sizeBytes: 8,
      isBinary: false,
      mtime: "2026-01-01T00:00:00.000Z",
    }),
  );
  const writeFile = mock(
    async (): Promise<WriteFileResult> => ({
      kind: "ok",
      mtime: "2026-01-01T00:00:00.000Z",
      size: 5,
    }),
  );
  const createFile = mock(async (): Promise<void> => {});
  const mkdir = mock(async (): Promise<void> => {});
  const unlink = mock(async (): Promise<void> => {});
  const rmdir = mock(async (): Promise<void> => {});
  const rename = mock(async (): Promise<void> => {});
  const provider: FsProvider = {
    kind: "local",
    readdir,
    stat,
    readFile,
    readAbsolute,
    writeFile,
    createFile,
    mkdir,
    unlink,
    rmdir,
    rename,
    ...overrides,
  };

  return {
    provider,
    readdir,
    stat,
    readFile,
    readAbsolute,
    writeFile,
    createFile,
    mkdir,
    unlink,
    rmdir,
    rename,
  };
}

function makeManager(provider: FsProvider) {
  const getFs = mock(async (_id: string) => provider);
  return { manager: { getFs }, getFs };
}

describe("fs read handlers — provider delegation", () => {
  it("readRangeHandler reads a workspace file's range, and a granted file outside by its path", async () => {
    const fileResult: FileReadBinaryResult = {
      kind: "ok",
      base64: "JVBERi0=",
      sizeBytes: 900,
      mtime: "2026-11-05T00:00:00.000Z",
    };
    const readRange = mock(
      async (_relPath: string, _offset: number, _length: number) => fileResult,
    );
    const readAbsoluteRange = mock(
      async (_absolutePath: string, _offset: number, _length: number) => fileResult,
    );
    const { provider } = makeProvider({ kind: "ssh", readRange, readAbsoluteRange });
    const { manager } = makeManager(provider);
    const read = (relPath: string) =>
      readRangeHandler(manager as never)({
        workspaceId: WORKSPACE_ID,
        relPath,
        offset: 100,
        length: 5,
      });

    try {
      expect(await read("docs/paper.pdf")).toBe(fileResult);
      expect(readRange.mock.calls).toEqual([["docs/paper.pdf", 100, 5]]);

      expect(await read("/tmp/shot.pdf")).toEqual({ kind: "missing", reason: "not-found" });
      expect(readAbsoluteRange.mock.calls).toEqual([]);
      setOutsideGrant(WORKSPACE_ID, "tab", ["/tmp/shot.pdf"], []);
      expect(await read("/tmp/shot.pdf")).toBe(fileResult);
      expect(readAbsoluteRange.mock.calls).toEqual([["/tmp/shot.pdf", 100, 5]]);
    } finally {
      clearOutsideGrants();
    }
  });

  it("readExternalHandler rejects calls without a workspace id", async () => {
    const { provider, readAbsolute } = makeProvider();
    const { manager, getFs } = makeManager(provider);

    await expect(
      readExternalHandler(manager as never)({ absolutePath: "/external/lib.ts" }),
    ).rejects.toThrow();
    expect(getFs).not.toHaveBeenCalled();
    expect(readAbsolute).not.toHaveBeenCalled();
  });
});
