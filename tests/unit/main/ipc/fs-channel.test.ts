import { describe, expect, it, mock } from "bun:test";
import type { FsProvider } from "../../../../src/main/features/fs/bridge/provider";
import {
  grantOutsideHandler,
  outsideExistsHandler,
  readBinaryHandler,
  readExternalHandler,
  readRangeHandler,
} from "../../../../src/main/features/fs/ipc/read-handlers";
import {
  clearOutsideGrants,
  isOutsideGranted,
  rememberPickedNetworkFile,
  setOutsideGrant,
} from "../../../../src/main/features/fs/outside-grants";
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

  it("outsideExistsHandler tells a file is there without a grant, reading none of it", async () => {
    const readAbsoluteRange = mock(
      async (): Promise<FileReadBinaryResult> => ({
        kind: "ok",
        base64: "",
        sizeBytes: 3,
        mtime: "m",
      }),
    );
    const { provider } = makeProvider({ readAbsoluteRange });
    const { manager } = makeManager(provider);
    const exists = outsideExistsHandler(manager as never);
    expect(await exists({ workspaceId: WORKSPACE_ID, absolutePath: "/tmp/shot.png" })).toBe(true);
    expect(readAbsoluteRange.mock.calls).toEqual([["/tmp/shot.png", 0, 0]]);
  });

  it("outsideExistsHandler never reaches for a share, a device or a relative path", async () => {
    const readAbsoluteRange = mock(
      async (): Promise<FileReadBinaryResult> => ({
        kind: "ok",
        base64: "",
        sizeBytes: 3,
        mtime: "m",
      }),
    );
    const { provider } = makeProvider({ readAbsoluteRange });
    const { manager, getFs } = makeManager(provider);
    const exists = outsideExistsHandler(manager as never);
    for (const absolutePath of [
      "//evil.test/share/a.png",
      "\\\\evil.test\\share\\a.png",
      String.raw`/\server/share/a.png`,
      "\\\\?\\C:\\a.png",
      "\\\\.\\pipe\\x",
      String.raw`\\?\UNC\server\share\a.png`,
      "relative/a.png",
    ]) {
      expect(await exists({ workspaceId: WORKSPACE_ID, absolutePath })).toBe(false);
    }
    expect(getFs).not.toHaveBeenCalled();
    expect(readAbsoluteRange).not.toHaveBeenCalled();
  });

  it.if(process.platform === "win32")(
    "rejects network and device paths before getting a filesystem or using an outside grant",
    async () => {
      const { provider, readAbsolute } = makeProvider();
      const { manager, getFs } = makeManager(provider);
      const binary = readBinaryHandler(manager as never);
      const range = readRangeHandler(manager as never);
      const external = readExternalHandler(manager as never);
      const missing = { kind: "missing", reason: "not-found" };
      const paths = [
        "//server/share/a.txt",
        String.raw`\\server\share\a.txt`,
        String.raw`/\server\share/a.txt`,
        String.raw`\\?\UNC\server\share\a.txt`,
        String.raw`\\?\C:\a.txt`,
        String.raw`\\.\C:\a.txt`,
      ];

      try {
        await grantOutsideHandler()({
          workspaceId: WORKSPACE_ID,
          owner: "tab",
          files: paths,
          dirs: [],
        });
        for (const path of paths) {
          expect(isOutsideGranted(WORKSPACE_ID, path)).toBe(false);
          expect(await binary({ workspaceId: WORKSPACE_ID, relPath: path })).toEqual(missing);
          expect(
            await range({ workspaceId: WORKSPACE_ID, relPath: path, offset: 0, length: 1 }),
          ).toEqual(missing);
          expect(await external({ workspaceId: WORKSPACE_ID, absolutePath: path })).toEqual(
            missing,
          );
        }
        expect(isOutsideGranted(WORKSPACE_ID, "/server/share/a.txt")).toBe(false);
        expect(getFs).not.toHaveBeenCalled();
        expect(readAbsolute).not.toHaveBeenCalled();
      } finally {
        clearOutsideGrants();
      }
    },
  );

  it.if(process.platform === "win32")("reads the specific file picked on a share", async () => {
    const picked = String.raw`\\server\share\chosen.txt`;
    rememberPickedNetworkFile(picked);
    const { provider, readAbsolute } = makeProvider();
    const { manager } = makeManager(provider);
    const read = readExternalHandler(manager as never);
    expect(
      await read({ workspaceId: WORKSPACE_ID, absolutePath: "//SERVER/share/chosen.txt" }),
    ).toMatchObject({ kind: "ok" });
    expect(
      await read({ workspaceId: WORKSPACE_ID, absolutePath: "//server/share/other.txt" }),
    ).toMatchObject({ kind: "missing" });
    expect(readAbsolute.mock.calls).toEqual([[picked]]);
  });

  it("readExternalHandler reads no device path", async () => {
    const { provider, readAbsolute } = makeProvider();
    const { manager } = makeManager(provider);
    const read = readExternalHandler(manager as never);
    for (const absolutePath of ["\\\\?\\C:\\a.txt", "//./pipe/x"]) {
      expect(await read({ workspaceId: WORKSPACE_ID, absolutePath })).toEqual({
        kind: "missing",
        reason: "not-found",
      });
    }
    expect(readAbsolute).not.toHaveBeenCalled();
  });
});
