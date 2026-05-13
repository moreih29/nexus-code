/**
 * Unit tests for readExternalHandler.
 */

import { describe, expect, it, mock } from "bun:test";
import { readExternalHandler } from "../../../../src/main/bridge/fs/read-handlers";
import type { FsProvider } from "../../../../src/main/bridge/fs/provider";
import type { FileReadResult } from "../../../../src/shared/types/fs";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";

function makeProvider(readAbsolute: FsProvider["readAbsolute"]): FsProvider {
  return {
    kind: "local",
    readdir: async () => [],
    stat: async () => ({
      type: "file",
      size: 0,
      mtime: "2026-01-01T00:00:00.000Z",
      isSymlink: false,
    }),
    readFile: async () => ({ kind: "missing", reason: "not-found" }),
    readAbsolute,
    writeFile: async () => ({ kind: "ok", mtime: "2026-01-01T00:00:00.000Z", size: 0 }),
    createFile: async () => {},
    mkdir: async () => {},
  };
}

function makeManager(provider: FsProvider) {
  const requireContext = mock((workspaceId: string) => ({ id: workspaceId, fs: provider }));
  return { manager: { requireContext }, requireContext };
}

describe("readExternalHandler", () => {
  it("delegates absolute reads to the workspace provider", async () => {
    const fileResult: FileReadResult = {
      kind: "ok",
      content: "export const x = 1;\n",
      encoding: "utf8",
      sizeBytes: 20,
      isBinary: false,
      mtime: "2026-01-01T00:00:00.000Z",
    };
    const readAbsolute = mock(async () => fileResult);
    const { manager, requireContext } = makeManager(makeProvider(readAbsolute));

    const result = await readExternalHandler(manager as never)({
      workspaceId: WORKSPACE_ID,
      absolutePath: "/external/src/lib.ts",
    });

    expect(result).toBe(fileResult);
    expect(requireContext.mock.calls).toEqual([[WORKSPACE_ID]]);
    expect(readAbsolute.mock.calls).toEqual([["/external/src/lib.ts"]]);
  });

  it("returns provider missing results without wrapping them", async () => {
    const missing: FileReadResult = { kind: "missing", reason: "not-found" };
    const { manager } = makeManager(makeProvider(mock(async () => missing)));

    await expect(
      readExternalHandler(manager as never)({
        workspaceId: WORKSPACE_ID,
        absolutePath: "/external/missing.ts",
      }),
    ).resolves.toBe(missing);
  });

  it("propagates provider errors", async () => {
    const error = new Error("NOT_FOUND: path must be absolute: relative.ts");
    const { manager } = makeManager(
      makeProvider(
        mock(async (): Promise<FileReadResult> => {
          throw error;
        }),
      ),
    );

    await expect(
      readExternalHandler(manager as never)({
        workspaceId: WORKSPACE_ID,
        absolutePath: "relative.ts",
      }),
    ).rejects.toBe(error);
  });

  it("rejects calls without a workspace id", async () => {
    const { manager } = makeManager(makeProvider(mock(async () => ({ kind: "missing", reason: "not-found" }))));

    await expect(
      readExternalHandler(manager as never)({ absolutePath: "/external/src/lib.ts" }),
    ).rejects.toThrow();
  });
});
