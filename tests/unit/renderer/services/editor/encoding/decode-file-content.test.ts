import { expect, test } from "bun:test";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";

(globalThis as Record<string, unknown>).window ??= {
  ipc: { call: () => Promise.resolve(null), listen: () => {}, off: () => {} },
};

const { decodeFileContent, readFileForModel, setEncodingOverride } = await import(
  "../../../../../../src/renderer/services/editor/model/file-loader"
);
const { useWorkspacesStore } = await import(
  "../../../../../../src/renderer/state/stores/workspaces"
);
const { initializeWorkspaceLifecycle } = await import(
  "../../../../../../src/renderer/state/workspace-cleanup"
);

const read = { sizeBytes: 4, isBinary: false, mtime: "T" };

test("UTF-8 comes through as it was read", () => {
  expect(decodeFileContent({ ...read, content: "hi", encoding: "utf8" })).toEqual({
    ...read,
    content: "hi",
    encoding: "utf8",
  });
});

test("bytes are decoded in the encoding they are valid in", () => {
  const latin = decodeFileContent({ ...read, content: "", encoding: "bytes", bytes: "Y2Fm6Q==" });
  expect(latin).toEqual({ ...read, content: "café", encoding: "windows-1252" });
  const utf16 = decodeFileContent({ ...read, content: "", encoding: "bytes", bytes: "//5oAGkA" });
  expect(utf16).toMatchObject({ content: "hi", encoding: "utf-16le" });
});

test("a file reopened in an encoding is read in it, UTF-8 too", () => {
  const korean = decodeFileContent(
    { ...read, content: "", encoding: "bytes", bytes: "x9Gx2w==" },
    "euc-kr",
  );
  expect(korean).toMatchObject({ content: "한글", encoding: "euc-kr" });
  const utf8 = decodeFileContent({ ...read, content: "é", encoding: "utf8" }, "windows-1252");
  expect(utf8).toMatchObject({ content: "Ã©", encoding: "windows-1252" });
});

test("workspace removal clears its file encoding overrides only", async () => {
  const originalWindow = globalThis.window;
  const originalState = useWorkspacesStore.getState();
  const workspaces: WorkspaceMeta[] = [crypto.randomUUID(), crypto.randomUUID()].map((id) => ({
    id,
    name: id,
    rootPath: "/project",
    location: { kind: "local", rootPath: "/project" },
    pinned: false,
    color: "auto",
    tabs: [],
  }));
  const [removed, retained] = workspaces.map(({ id }) => ({
    workspaceId: id,
    filePath: "/project/text.txt",
  }));
  let onRemoved: ((event: { id: string }) => void) | undefined;
  Object.assign(globalThis, {
    window: {
      ipc: {
        call: async () => ({ ...read, kind: "file", content: "é", encoding: "utf8" }),
        listen: (_channel: string, _event: string, handler: typeof onRemoved) => {
          onRemoved = handler;
          return () => {};
        },
      },
    },
  });
  try {
    initializeWorkspaceLifecycle();
    useWorkspacesStore.getState().setAll(workspaces);
    for (const input of [removed, retained]) setEncodingOverride(input, "windows-1252");
    expect((await readFileForModel(removed)).encoding).toBe("windows-1252");
    if (!onRemoved) throw new Error("missing workspace removal listener");
    onRemoved({ id: removed.workspaceId });
    setEncodingOverride(removed, "windows-1252");

    useWorkspacesStore.getState().setAll(workspaces);
    expect((await readFileForModel(removed)).encoding).toBe("utf8");
    expect((await readFileForModel(retained)).encoding).toBe("windows-1252");
    onRemoved({ id: retained.workspaceId });
  } finally {
    useWorkspacesStore.setState(originalState);
    Object.assign(globalThis, { window: originalWindow });
  }
});
