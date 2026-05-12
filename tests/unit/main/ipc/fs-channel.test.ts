import { describe, expect, it, mock } from "bun:test";
import type { FsReadProvider } from "../../../../src/main/fs/provider/types";
import {
  readdirHandler,
  readFileHandler,
  statHandler,
} from "../../../../src/main/ipc/channels/fs/read-handlers";
import type { DirEntry, FileReadResult, FsStat } from "../../../../src/shared/types/fs";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";

function makeProvider(overrides: Partial<FsReadProvider> = {}) {
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
  const provider: FsReadProvider = {
    kind: "local",
    readdir,
    stat,
    readFile,
    ...overrides,
  };

  return { provider, readdir, stat, readFile };
}

function makeManager(provider: FsReadProvider) {
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
});
