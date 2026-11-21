import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { hydrateLayoutSnapshots } from "../../../../../src/renderer/state/persistence";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import type { WriteFileResult } from "../../../../../src/shared/fs/types";

const workspaceId = "591e167a-99b5-4c5f-a759-f5dd9d274a17";
const input = { workspaceId, filePath: "/repo/a.txt" };
const written = { kind: "ok", mtime: "next", size: 10 } satisfies WriteFileResult;
type WriteArgs = { content: string; relPath: string; bytes?: string };
const writeStarted = mock((_args: WriteArgs) => {});
let write: () => Promise<WriteFileResult>;
let disk: string;
let previousWindow: Window & typeof globalThis;
const untitled = { workspaceId, filePath: "Untitled-1", origin: "untitled" } as const;

function createModel(initial: string) {
  let text = initial;
  let version = 1;
  let disposed = false;
  const listeners = new Set<(event: { changes: [] }) => void>();
  return {
    getValue: () => text,
    getAlternativeVersionId: () => version,
    getVersionId: () => version,
    getLanguageId: () => "plaintext",
    isDisposed: () => disposed,
    dispose() {
      disposed = true;
    },
    setValue(value: string) {
      if (text === value) return;
      text = value;
      version++;
      for (const listener of listeners) listener({ changes: [] });
    },
    getFullModelRange: () => ({}),
    pushEditOperations(_selections: unknown, edits: { text: string }[]) {
      this.setValue(edits[0]!.text);
    },
    onDidChangeContent(listener: (event: { changes: [] }) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

mock.module("../../../../../src/renderer/services/editor/runtime/monaco-singleton", () => ({
  requireMonaco: () => ({
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: { getModel: () => null, createModel },
  }),
}));
mock.module("../../../../../src/renderer/components/editor/save-confirm-dialog", () => ({
  showSaveConfirm: async () => "save",
}));

const confirmReplacement = mock(async () => false);
mock.module("../../../../../src/renderer/components/ui/confirm-dialog", () => ({
  showConfirmDialog: confirmReplacement,
}));

const { acquireModel, releaseModel, cacheUriFor, getResolvedModel } = await import(
  "../../../../../src/renderer/services/editor/model/cache"
);
const { isDirty } = await import("../../../../../src/renderer/services/editor/model/dirty-tracker");
const { closeDiffWithConfirm, closeEditorWithConfirm } = await import(
  "../../../../../src/renderer/services/editor/save/close-handler"
);

const { saveModel } = await import("../../../../../src/renderer/services/editor/save/service");
const { saveUntitledModel } = await import(
  "../../../../../src/renderer/services/editor/save/save-untitled-handler"
);

const acquired: Array<Parameters<typeof acquireModel>[0]> = [];
async function openModel(
  file: Parameters<typeof acquireModel>[0] = input,
): Promise<Monaco.editor.ITextModel> {
  const state = await acquireModel(file);
  acquired.push(file);
  if (!state.model) throw new Error("Expected an editable model");
  return state.model;
}

const findTab = (id: string) => useTabsStore.getState().byWorkspace[workspaceId]?.[id];

beforeEach(() => {
  previousWindow = globalThis.window;
  Object.assign(globalThis, {
    window: {
      ...previousWindow,
      ipc: {
        async call(channel: string, method: string, args: WriteArgs) {
          if (channel === "dialog" && method === "showSaveDialog") {
            return { canceled: false, filePath: input.filePath };
          }
          if (channel === "fs" && method === "readFile") {
            return {
              kind: "ok",
              content: disk,
              encoding: "utf8",
              isBinary: false,
              mtime: "before",
              sizeBytes: disk.length,
            };
          }
          if (channel === "fs" && method === "writeFile") {
            writeStarted(args);
            return write();
          }
          return {};
        },
        listen: () => () => {},
        off() {},
      },
    },
  });
  useWorkspacesStore.getState().upsert({
    id: workspaceId,
    rootPath: "/repo",
    name: "Test",
    location: { kind: "local", rootPath: "/repo" },
    color: "auto",
    pinned: false,
    sortOrder: 1,
    pinnedSortOrder: 0,
    tabs: [],
  });
  writeStarted.mockClear();
  confirmReplacement.mockClear();
  write = async () => written;
  disk = "original";
});

afterEach(() => {
  useLayoutStore.getState().closeAllForWorkspace(workspaceId);
  useTabsStore.getState().closeAllForWorkspace(workspaceId);
  for (const file of acquired.splice(0).reverse()) releaseModel(file);
  useWorkspacesStore.getState().remove(workspaceId);
  Object.assign(globalThis, { window: previousWindow });
});

test.each([
  "editor",
  "editor.diff",
] as const)("closing a %s preserves edits made while its save is in flight", async (type) => {
  const tab = useTabsStore.getState().createTab(
    workspaceId,
    type === "editor"
      ? { type, props: input }
      : {
          type,
          props: { workspaceId, relPath: "a.txt", leftRef: "INDEX", rightRef: "WORKING" },
        },
  );
  const model = await openModel();
  model.setValue("first edit");

  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<WriteFileResult>();
  write = () => {
    started.resolve();
    return reply.promise;
  };
  const close = type === "editor" ? closeEditorWithConfirm : closeDiffWithConfirm;
  const closing = close(workspaceId, tab.id);
  await started.promise;
  model.setValue("second edit");
  reply.resolve(written);

  expect(await closing).toBe("cancelled");
  expect(writeStarted).toHaveBeenCalledWith(expect.objectContaining({ content: "first edit" }));
  expect(findTab(tab.id)).toBeDefined();
  expect(isDirty(cacheUriFor(workspaceId, input.filePath))).toBe(true);
  expect(model.getValue()).toBe("second edit");
});

test("first save carries edits made during the write into the saved file's buffer", async () => {
  const tab = useTabsStore.getState().createTab(workspaceId, {
    type: "untitled",
    props: { untitledIndex: 1 },
  });
  const model = await openModel(untitled);
  model.setValue("first edit");
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<WriteFileResult>();
  write = () => {
    started.resolve();
    return reply.promise;
  };
  const saving = saveUntitledModel(workspaceId, tab.id);
  await started.promise;
  model.setValue("second edit");
  disk = "first edit";
  reply.resolve(written);

  expect(await saving).toBe("saved");
  expect(writeStarted).toHaveBeenCalledWith(expect.objectContaining({ content: "first edit" }));
  expect(findTab(tab.id)?.type).toBe("editor");
  const saved = getResolvedModel(input);
  expect(saved?.model.getValue()).toBe("second edit");
  expect(saved && isDirty(saved.cacheUri)).toBe(true);
  releaseModel(input);
});

test("first save asks before replacing a file only the SSH workspace can see", async () => {
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((item) => item.id === workspaceId)!;
  useWorkspacesStore.getState().upsert({
    ...workspace,
    location: { kind: "ssh", host: "example.invalid", remotePath: "/repo" },
  });
  const tab = useTabsStore.getState().createTab(workspaceId, {
    type: "untitled",
    props: { untitledIndex: 1 },
  });
  const model = await openModel(untitled);
  model.setValue("new text");
  write = async () => ({
    kind: "conflict",
    actual: { exists: true, mtime: "remote", size: 16 },
  });

  expect(await saveUntitledModel(workspaceId, tab.id)).toBe("cancelled");
  expect(confirmReplacement).toHaveBeenCalledTimes(1);
  expect(writeStarted).toHaveBeenCalledTimes(1);
  expect(writeStarted).toHaveBeenCalledWith(
    expect.objectContaining({ expected: { exists: false } }),
  );
  expect(findTab(tab.id)?.type).toBe("untitled");
  expect(model.getValue()).toBe("new text");
});

test("a restored background diff retains unsaved edits before its view mounts", async () => {
  const tabs = useTabsStore.getState();
  const props = { workspaceId, relPath: "a.txt", leftRef: "INDEX", rightRef: "WORKING" };
  const first = tabs.createTab(workspaceId, { type: "editor.diff", props });
  const second = tabs.createTab(workspaceId, { type: "editor.diff", props });
  const unrelated = tabs.createTab(workspaceId, {
    type: "editor",
    props: { workspaceId, filePath: "/repo/other.txt" },
  });
  const layout = useLayoutStore.getState();
  layout.ensureLayout(workspaceId);
  const left = useLayoutStore.getState().byWorkspace[workspaceId]!.activeGroupId;
  const right = layout.splitGroup(workspaceId, left, "horizontal", "after");
  layout.attachTab(workspaceId, left, first.id);
  layout.attachTab(workspaceId, right, second.id);
  layout.attachTab(workspaceId, right, unrelated.id);
  const snapshot = {
    ...useLayoutStore.getState().byWorkspace[workspaceId]!,
    tabs: [first, second, unrelated],
  };
  layout.closeAllForWorkspace(workspaceId);
  tabs.closeAllForWorkspace(workspaceId);
  hydrateLayoutSnapshots({ [workspaceId]: snapshot });

  const model = await openModel(); // Only the visible diff has mounted.
  model.setValue("unsaved in first diff");
  expect(await closeDiffWithConfirm(workspaceId, first.id)).toBe("closed");
  releaseModel(input);

  expect(model.isDisposed()).toBe(false);
  expect(await openModel()).toBe(model);
  expect(model.getValue()).toBe("unsaved in first diff");
  expect(isDirty(cacheUriFor(workspaceId, input.filePath))).toBe(true);
});

test("a regular save behind Save with Encoding writes in the new encoding", async () => {
  const model = await openModel();
  model.setValue("café");
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<WriteFileResult>();
  write = () => {
    if (writeStarted.mock.calls.length !== 1) return Promise.resolve(written);
    started.resolve();
    return reply.promise;
  };
  const encodingSave = saveModel(input, { encoding: "windows-1252" });
  await started.promise;
  model.setValue("café!");
  const regularSave = saveModel(input);
  reply.resolve(written);

  expect((await encodingSave).kind).toBe("saved");
  expect((await regularSave).kind).toBe("saved");
  expect(writeStarted.mock.calls.map(([args]) => args.bytes)).toEqual(["Y2Fm6Q==", "Y2Fm6SE="]);
});
