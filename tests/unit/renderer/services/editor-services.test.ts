import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";

const WS_ID = "123e4567-e89b-42d3-a456-426614174000";

type IpcCallRecord = { channel: string; method: string; args: unknown };
type ListenerRecord = { channel: string; event: string; callback: (args: unknown) => void };

const ipcCalls: IpcCallRecord[] = [];
const listeners: ListenerRecord[] = [];
const fileContents = new Map<string, string>();

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock((channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });

    if (channel === "fs" && method === "readFile") {
      const { relPath } = args as { relPath: string };
      const content = fileContents.get(relPath) ?? "";
      return Promise.resolve({
        content,
        encoding: "utf8",
        sizeBytes: content.length,
        isBinary: false,
        mtime: new Date().toISOString(),
      });
    }

    return Promise.resolve(undefined);
  }),
  ipcListen: mock((channel: string, event: string, callback: (args: unknown) => void) => {
    const record = { channel, event, callback };
    listeners.push(record);
    return () => {
      const index = listeners.indexOf(record);
      if (index >= 0) listeners.splice(index, 1);
    };
  }),
}));

const { initializeLspBridge } = await import("../../../../src/renderer/services/editor/lsp-bridge");
const { acquireModel, initializeModelCache, releaseModel } = await import(
  "../../../../src/renderer/services/editor/model-cache"
);
const { useWorkspacesStore } = await import("../../../../src/renderer/state/stores/workspaces");

interface FakeUri {
  path: string;
  toString: () => string;
}

interface FakeModel {
  uri: FakeUri;
  getValue: () => string;
  setValue: (nextValue: string) => void;
  getAlternativeVersionId: () => number;
  onDidChangeContent: (listener: () => void) => Monaco.IDisposable;
  isDisposed: () => boolean;
  dispose: () => void;
}

function createFakeMonaco() {
  const models = new Map<string, FakeModel>();
  const providerCalls = {
    hover: [] as string[],
    definition: [] as string[],
    completion: [] as string[],
  };

  const uriParse = (raw: string): FakeUri => ({
    path: raw.replace(/^file:\/\//, ""),
    toString: () => raw,
  });

  const monaco = {
    Uri: { parse: uriParse },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    editor: {
      createModel(value: string, _languageId: string, uri: FakeUri) {
        let currentValue = value;
        let altVersionId = 1;
        let disposed = false;
        const changeListeners = new Set<() => void>();
        const model: FakeModel = {
          uri,
          getValue: () => currentValue,
          setValue(nextValue: string) {
            currentValue = nextValue;
            altVersionId += 1;
            for (const listener of changeListeners) listener();
          },
          getAlternativeVersionId: () => altVersionId,
          onDidChangeContent(listener: () => void) {
            changeListeners.add(listener);
            return { dispose: () => changeListeners.delete(listener) };
          },
          isDisposed: () => disposed,
          dispose() {
            disposed = true;
            models.delete(uri.toString());
          },
        };
        models.set(uri.toString(), model);
        return model as unknown as Monaco.editor.ITextModel;
      },
      getModel(uri: FakeUri) {
        return (models.get(uri.toString()) ?? null) as Monaco.editor.ITextModel | null;
      },
      getModels() {
        return [...models.values()] as unknown as Monaco.editor.ITextModel[];
      },
      setModelMarkers: () => {},
    },
    languages: {
      CompletionItemKind: { Text: 1 },
      registerHoverProvider(languageId: string) {
        providerCalls.hover.push(languageId);
        return { dispose: () => {} };
      },
      registerDefinitionProvider(languageId: string) {
        providerCalls.definition.push(languageId);
        return { dispose: () => {} };
      },
      registerCompletionItemProvider(languageId: string) {
        providerCalls.completion.push(languageId);
        return { dispose: () => {} };
      },
    },
    __providerCalls: providerCalls,
  };

  return monaco as unknown as typeof Monaco & { __providerCalls: typeof providerCalls };
}

function resetWorkspaceStore(): void {
  useWorkspacesStore.setState({
    workspaces: [
      {
        id: WS_ID,
        name: "Workspace",
        rootPath: "/workspace",
        colorTone: "default",
        pinned: false,
        tabs: [],
      },
    ],
  });
}

function emit(channel: string, event: string, args: unknown): void {
  for (const listener of listeners) {
    if (listener.channel === channel && listener.event === event) {
      listener.callback(args);
    }
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("services/editor model cache", () => {
  beforeEach(() => {
    ipcCalls.length = 0;
    listeners.length = 0;
    fileContents.clear();
    resetWorkspaceStore();
    initializeModelCache(createFakeMonaco());
  });

  test("shares one Monaco model per file URI and sends didClose after the last release", async () => {
    const input = { workspaceId: WS_ID, filePath: "/workspace/src/a.ts" };
    fileContents.set("src/a.ts", "const a = 1;\n");

    const first = await acquireModel(input);
    const second = await acquireModel(input);

    expect(first.phase).toBe("ready");
    expect(first.model).toBe(second.model);
    expect(
      ipcCalls.filter((call) => call.channel === "lsp" && call.method === "didOpen"),
    ).toHaveLength(1);

    releaseModel(input);
    expect(first.model?.isDisposed()).toBe(false);
    expect(
      ipcCalls.filter((call) => call.channel === "lsp" && call.method === "didClose"),
    ).toHaveLength(0);

    releaseModel(input);
    expect(first.model?.isDisposed()).toBe(true);
    expect(
      ipcCalls.filter((call) => call.channel === "lsp" && call.method === "didClose"),
    ).toHaveLength(1);
  });

  test("applies external fs changes only while the shared model is clean", async () => {
    const input = { workspaceId: WS_ID, filePath: "/workspace/src/a.ts" };
    fileContents.set("src/a.ts", "one");

    const acquired = await acquireModel(input);
    const model = acquired.model;
    if (!model) throw new Error("expected ready model");

    fileContents.set("src/a.ts", "two");
    emit("fs", "changed", {
      workspaceId: WS_ID,
      changes: [{ relPath: "src/a.ts", kind: "modified" }],
    });
    await flushAsyncWork();

    expect(model.getValue()).toBe("two");

    model.setValue("dirty");
    fileContents.set("src/a.ts", "three");
    emit("fs", "changed", {
      workspaceId: WS_ID,
      changes: [{ relPath: "src/a.ts", kind: "modified" }],
    });
    await flushAsyncWork();

    expect(model.getValue()).toBe("dirty");
    releaseModel(input);
  });
});

describe("services/editor LSP bridge", () => {
  test("registers providers once per supported language", () => {
    const monaco = createFakeMonaco();

    initializeLspBridge(monaco);
    initializeLspBridge(monaco);

    expect(monaco.__providerCalls.hover).toEqual(["typescript", "javascript"]);
    expect(monaco.__providerCalls.definition).toEqual(["typescript", "javascript"]);
    expect(monaco.__providerCalls.completion).toEqual(["typescript", "javascript"]);
  });
});
