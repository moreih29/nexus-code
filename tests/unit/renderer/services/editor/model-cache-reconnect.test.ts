import { expect, mock, test } from "bun:test";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import { untitledCacheUriFor } from "../../../../../src/shared/fs/workspace-uri";

const workspaceId = "model-cache-reconnect";
const rootPath = "/remote";
const file = { workspaceId, filePath: "/remote/file.txt" };
const untitled = { workspaceId, filePath: "Untitled-1", origin: "untitled" as const };
const disk = {
  content: "disk",
  encoding: "utf8" as const,
  isBinary: false,
  mtime: "T1",
  sizeBytes: 4,
};

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: async (channel: string, method: string) => {
    if (channel === "fs" && method === "readFile") {
      return { ok: true, value: { kind: "text", ...disk } };
    }
    if (channel === "fs" && method === "stat") {
      return { ok: true, value: { mtime: disk.mtime, size: disk.sizeBytes } };
    }
    throw new Error(`Unexpected IPC: ${channel}.${method}`);
  },
  ipcListen: () => () => {},
}));

/** Simulates a model instance with edits and undo surviving view disposal. */
function makeModel(content: string) {
  const history = [content];
  const listeners = new Set<(event: { changes: [] }) => void>();
  let disposed = false;
  return {
    getValue: () => history.at(-1),
    getLanguageId: () => "plaintext",
    getAlternativeVersionId: () => history.length,
    onDidChangeContent(listener: (event: { changes: [] }) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    isDisposed: () => disposed,
    dispose() {
      disposed = true;
      history.length = 0;
    },
    edit(text: string) {
      history.push(text);
      for (const listener of listeners) listener({ changes: [] });
    },
    undo() {
      history.pop();
      for (const listener of listeners) listener({ changes: [] });
    },
  };
}

mock.module("../../../../../src/renderer/services/editor/runtime/monaco-singleton", () => ({
  requireMonaco: () => ({
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: { getModel: () => null, createModel: makeModel },
  }),
}));

const { acquireModel, cacheUriFor, getModelSnapshot, releaseModel } = await import(
  "../../../../../src/renderer/services/editor/model/cache"
);
const { isDirty } = await import("../../../../../src/renderer/services/editor/model/dirty-tracker");

test("open SSH file and Untitled models keep dirty edits and Undo across session expiry", async () => {
  const workspaces = useWorkspacesStore.getState();
  const tabs = useTabsStore.getState();
  workspaces.upsert({
    id: workspaceId,
    rootPath,
    name: "Remote",
    location: { kind: "ssh", host: "example.invalid", remotePath: rootPath },
    colorTone: "default",
    pinned: false,
    sortOrder: 1,
    pinnedSortOrder: 0,
    tabs: [],
  });
  tabs.createTab(workspaceId, { type: "editor", props: file });
  tabs.createTab(workspaceId, { type: "untitled", props: { untitledIndex: 1 } });

  try {
    workspaces.setConnectionStatus(workspaceId, "connected");
    const fileModel = (await acquireModel(file)).model as unknown as ReturnType<typeof makeModel>;
    const untitledModel = (await acquireModel(untitled)).model as unknown as ReturnType<
      typeof makeModel
    >;
    fileModel.edit("dirty file");
    untitledModel.edit("dirty untitled");

    // Simulate ContentPool unmounting and releasing its last references.
    workspaces.setConnectionStatus(workspaceId, "held-then-expired");
    releaseModel(file);
    releaseModel(untitled);
    expect(isDirty(cacheUriFor(workspaceId, file.filePath))).toBe(true);
    expect(isDirty(untitledCacheUriFor(workspaceId, 1))).toBe(true);

    workspaces.setConnectionStatus(workspaceId, "connected");
    expect((await acquireModel(file)).model).toBe(fileModel as never);
    expect((await acquireModel(untitled)).model).toBe(untitledModel as never);
    expect(fileModel.getValue()).toBe("dirty file");
    expect(untitledModel.getValue()).toBe("dirty untitled");
    fileModel.undo();
    untitledModel.undo();
    expect(fileModel.getValue()).toBe(disk.content);
    expect(untitledModel.getValue()).toBe("");

    workspaces.setConnectionStatus(workspaceId, "held-then-expired");
    releaseModel(file);
    releaseModel(untitled);
    tabs.closeAllForWorkspace(workspaceId);
    expect(getModelSnapshot(file)).toBeNull();
    expect(getModelSnapshot(untitled)).toBeNull();
    expect(fileModel.isDisposed()).toBe(true);
    expect(untitledModel.isDisposed()).toBe(true);
  } finally {
    tabs.closeAllForWorkspace(workspaceId);
    releaseModel(file);
    releaseModel(untitled);
    workspaces.remove(workspaceId);
  }
});
