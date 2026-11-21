import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import type { WriteFileResult } from "../../../../../src/shared/fs/types";

const workspaceId = "591e167a-99b5-4c5f-a759-f5dd9d274a17";
const input = { workspaceId, filePath: "/repo/a.txt" };
const written = { kind: "ok", mtime: "next", size: 10 } satisfies WriteFileResult;
const writeStarted = mock((_args: { content: string; relPath: string }) => {});
let write: () => Promise<WriteFileResult>;
let disk: string;
let previousWindow: Window & typeof globalThis;

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

const { acquireModel, releaseModel, cacheUriFor } = await import(
  "../../../../../src/renderer/services/editor/model/cache"
);
const { isDirty } = await import("../../../../../src/renderer/services/editor/model/dirty-tracker");
const { closeDiffWithConfirm, closeEditorWithConfirm } = await import(
  "../../../../../src/renderer/services/editor/save/close-handler"
);

const acquired: Array<Parameters<typeof acquireModel>[0]> = [];
async function openModel(file = input): Promise<Monaco.editor.ITextModel> {
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
        async call(channel: string, method: string, args: { content: string; relPath: string }) {
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
  write = async () => written;
  disk = "original";
});

afterEach(() => {
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
