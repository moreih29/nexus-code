import { describe, expect, it, mock } from "bun:test";
import type { FsProvider } from "../../../../src/main/features/fs/bridge/provider";
import {
  readdirHandler,
  readExternalHandler,
  readFileHandler,
  statHandler,
} from "../../../../src/main/features/fs/ipc/read-handlers";
import {
  createFileHandler,
  mkdirHandler,
  renameHandler,
  rmdirHandler,
  unlinkHandler,
  writeFileHandler,
} from "../../../../src/main/features/fs/ipc/write-handlers";
import type {
  DirEntry,
  FileReadResult,
  FsStat,
  WriteFileResult,
} from "../../../../src/shared/types/fs";

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
  const requireContext = mock((id: string) => ({ fs: provider, id }));
  return { manager: { requireContext }, requireContext };
}

describe("fs read handlers — provider delegation", () => {
  it("readdirHandler passes the workspace id to requireContext and relPath to the provider", async () => {
    const entries: DirEntry[] = [{ name: "src", type: "dir" }];
    const readdir = mock(async (_relPath: string) => entries);
    const { provider } = makeProvider({ readdir });
    const { manager, requireContext } = makeManager(provider);

    const result = await readdirHandler(manager as never)({
      workspaceId: WORKSPACE_ID,
      relPath: "src",
    });

    expect(result).toBe(entries);
    expect(requireContext.mock.calls).toEqual([[WORKSPACE_ID]]);
    expect(readdir.mock.calls).toEqual([["src"]]);
  });

  it("statHandler passes the workspace id to requireContext and relPath to the provider", async () => {
    const fsStat: FsStat = {
      type: "symlink",
      size: 7,
      mtime: "2026-01-02T00:00:00.000Z",
      isSymlink: true,
    };
    const stat = mock(async (_relPath: string) => fsStat);
    const { provider } = makeProvider({ stat });
    const { manager, requireContext } = makeManager(provider);

    const result = await statHandler(manager as never)({
      workspaceId: WORKSPACE_ID,
      relPath: "linked",
    });

    expect(result).toBe(fsStat);
    expect(requireContext.mock.calls).toEqual([[WORKSPACE_ID]]);
    expect(stat.mock.calls).toEqual([["linked"]]);
  });

  it("readFileHandler passes the workspace id to requireContext and relPath to the provider", async () => {
    const fileResult: FileReadResult = { kind: "missing", reason: "not-found" };
    const readFile = mock(async (_relPath: string) => fileResult);
    const { provider } = makeProvider({ readFile });
    const { manager, requireContext } = makeManager(provider);

    const result = await readFileHandler(manager as never)({
      workspaceId: WORKSPACE_ID,
      relPath: "missing.ts",
    });

    expect(result).toBe(fileResult);
    expect(requireContext.mock.calls).toEqual([[WORKSPACE_ID]]);
    expect(readFile.mock.calls).toEqual([["missing.ts"]]);
  });

  it("propagates provider errors without wrapping them", async () => {
    const error = new Error("provider read failed");
    const readFile = mock(async (_relPath: string): Promise<FileReadResult> => {
      throw error;
    });
    const { provider } = makeProvider({ readFile });
    const { manager } = makeManager(provider);

    await expect(
      readFileHandler(manager as never)({ workspaceId: WORKSPACE_ID, relPath: "broken.ts" }),
    ).rejects.toBe(error);
    expect(readFile.mock.calls).toEqual([["broken.ts"]]);
  });

  it("readExternalHandler passes the workspace id and absolute path to the provider", async () => {
    const fileResult: FileReadResult = { kind: "missing", reason: "not-found" };
    const readAbsolute = mock(async (_absolutePath: string) => fileResult);
    const { provider } = makeProvider({ readAbsolute });
    const { manager, requireContext } = makeManager(provider);

    const result = await readExternalHandler(manager as never)({
      workspaceId: WORKSPACE_ID,
      absolutePath: "/external/lib.ts",
    });

    expect(result).toBe(fileResult);
    expect(requireContext.mock.calls).toEqual([[WORKSPACE_ID]]);
    expect(readAbsolute.mock.calls).toEqual([["/external/lib.ts"]]);
  });
});

describe("fs write handlers — provider delegation", () => {
  it("writeFileHandler delegates to the workspace provider", async () => {
    const writeResult: WriteFileResult = {
      kind: "ok",
      mtime: "2026-01-01T00:00:00.000Z",
      size: 5,
    };
    const writeFile = mock(async () => writeResult);
    const { provider } = makeProvider({ writeFile });
    const { manager, requireContext } = makeManager(provider);

    const result = await writeFileHandler(manager as never)({
      workspaceId: WORKSPACE_ID,
      relPath: "a.txt",
      content: "hello",
      expected: { exists: false },
    });

    expect(result).toBe(writeResult);
    expect(requireContext.mock.calls).toEqual([[WORKSPACE_ID]]);
    expect(writeFile.mock.calls).toEqual([["a.txt", "hello", { exists: false }]]);
  });

  it("createFileHandler and mkdirHandler delegate to the workspace provider", async () => {
    const createFile = mock(async () => {});
    const mkdir = mock(async () => {});
    const { provider } = makeProvider({ createFile, mkdir });
    const { manager } = makeManager(provider);

    await createFileHandler(manager as never)({ workspaceId: WORKSPACE_ID, relPath: "new.txt" });
    await mkdirHandler(manager as never)({ workspaceId: WORKSPACE_ID, relPath: "src" });

    expect(createFile.mock.calls).toEqual([["new.txt"]]);
    expect(mkdir.mock.calls).toEqual([["src"]]);
  });

  it("unlinkHandler delegates workspace-relative paths to the workspace provider", async () => {
    const unlink = mock(async () => {});
    const { provider } = makeProvider({ unlink });
    const { manager, requireContext } = makeManager(provider);

    await unlinkHandler(manager as never)({ workspaceId: WORKSPACE_ID, relPath: "old.txt" });

    expect(requireContext.mock.calls).toEqual([[WORKSPACE_ID]]);
    expect(unlink.mock.calls).toEqual([["old.txt"]]);
  });

  it("rmdirHandler delegates workspace-relative paths to the workspace provider", async () => {
    const rmdir = mock(async () => {});
    const { provider } = makeProvider({ rmdir });
    const { manager, requireContext } = makeManager(provider);

    await rmdirHandler(manager as never)({ workspaceId: WORKSPACE_ID, relPath: "empty" });

    expect(requireContext.mock.calls).toEqual([[WORKSPACE_ID]]);
    expect(rmdir.mock.calls).toEqual([["empty"]]);
  });

  it("renameHandler delegates workspace-relative source and target paths to the provider", async () => {
    const rename = mock(async () => {});
    const { provider } = makeProvider({ rename });
    const { manager, requireContext } = makeManager(provider);

    await renameHandler(manager as never)({
      workspaceId: WORKSPACE_ID,
      fromRelPath: "old.txt",
      toRelPath: "new.txt",
    });

    expect(requireContext.mock.calls).toEqual([[WORKSPACE_ID]]);
    expect(rename.mock.calls).toEqual([["old.txt", "new.txt"]]);
  });
});
