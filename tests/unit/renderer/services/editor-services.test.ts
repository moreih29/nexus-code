import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";

const WS_ID = "123e4567-e89b-42d3-a456-426614174000";

type IpcCallRecord = { channel: string; method: string; args: unknown };
type ListenerRecord = { channel: string; event: string; callback: (args: unknown) => void };

const ipcCalls: IpcCallRecord[] = [];
const listeners: ListenerRecord[] = [];
const fileContents = new Map<string, string>();
const eventLog: string[] = [];

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
    if (channel === "lsp" && method === "didOpen") {
      const { languageId } = args as { languageId: string };
      eventLog.push(`didOpen:${languageId}`);
    }

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

    if (channel === "fs" && method === "writeFile") {
      const { relPath, content } = args as { relPath: string; content: string };
      fileContents.set(relPath, content);
      return Promise.resolve({
        kind: "ok",
        mtime: new Date().toISOString(),
        size: content.length,
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

const { ensureProvidersFor, initializeLspBridge } = await import(
  "../../../../src/renderer/services/editor/lsp-bridge"
);
const { acquireModel, initializeModelCache, releaseModel } = await import(
  "../../../../src/renderer/services/editor/model-cache"
);
const { saveModel } = await import("../../../../src/renderer/services/editor/save-service");
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
  getLanguageId: () => string;
  onDidChangeContent: (
    listener: (event: Monaco.editor.IModelContentChangedEvent) => void,
  ) => Monaco.IDisposable;
  isDisposed: () => boolean;
  dispose: () => void;
}

// Mirror the slice of Monaco's basic-languages auto-detect that this
// test surface needs — model-cache now passes `undefined` as the
// language and reads `model.getLanguageId()` post-creation.
const FAKE_LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".json": "json",
};

function fakeLanguageIdForUri(rawUri: string): string {
  const path = rawUri.replace(/^file:\/\//, "");
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = path.slice(dot).toLowerCase();
  return FAKE_LANGUAGE_BY_EXT[ext] ?? "plaintext";
}

function fullRangeForValue(value: string): Monaco.IRange {
  const lines = value.split(/\r\n|\r|\n/);
  const lastLine = lines.at(-1) ?? "";
  return {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: lines.length,
    endColumn: lastLine.length + 1,
  };
}

function contentChangedEvent(
  previousValue: string,
  nextValue: string,
  versionId: number,
): Monaco.editor.IModelContentChangedEvent {
  return {
    changes: [
      {
        range: fullRangeForValue(previousValue),
        rangeOffset: 0,
        rangeLength: previousValue.length,
        text: nextValue,
        forceMoveMarkers: false,
      },
    ],
    eol: "\n",
    versionId,
    isUndoing: false,
    isRedoing: false,
    isFlush: true,
    isEolChange: false,
  } as Monaco.editor.IModelContentChangedEvent;
}

function createFakeMonaco() {
  const models = new Map<string, FakeModel>();
  const providerCalls = {
    hover: [] as string[],
    definition: [] as string[],
    completion: [] as string[],
    reference: [] as string[],
    documentHighlight: [] as string[],
    documentSymbol: [] as string[],
  };

  const uriParse = (raw: string): FakeUri => ({
    path: raw.replace(/^file:\/\//, ""),
    toString: () => raw,
  });

  const monaco = {
    Uri: { parse: uriParse },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    editor: {
      createModel(value: string, languageId: string | undefined, uri: FakeUri) {
        let currentValue = value;
        let altVersionId = 1;
        let disposed = false;
        const changeListeners = new Set<(event: Monaco.editor.IModelContentChangedEvent) => void>();
        const resolvedLanguageId = languageId ?? fakeLanguageIdForUri(uri.toString());
        const model: FakeModel = {
          uri,
          getValue: () => currentValue,
          setValue(nextValue: string) {
            const previousValue = currentValue;
            currentValue = nextValue;
            altVersionId += 1;
            const event = contentChangedEvent(previousValue, nextValue, altVersionId);
            for (const listener of changeListeners) listener(event);
          },
          getAlternativeVersionId: () => altVersionId,
          getLanguageId: () => resolvedLanguageId,
          onDidChangeContent(listener: (event: Monaco.editor.IModelContentChangedEvent) => void) {
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
        eventLog.push(`provider:hover:${languageId}`);
        return { dispose: () => {} };
      },
      registerDefinitionProvider(languageId: string) {
        providerCalls.definition.push(languageId);
        eventLog.push(`provider:definition:${languageId}`);
        return { dispose: () => {} };
      },
      registerCompletionItemProvider(languageId: string) {
        providerCalls.completion.push(languageId);
        eventLog.push(`provider:completion:${languageId}`);
        return { dispose: () => {} };
      },
      registerReferenceProvider(languageId: string) {
        providerCalls.reference.push(languageId);
        eventLog.push(`provider:reference:${languageId}`);
        return { dispose: () => {} };
      },
      registerDocumentHighlightProvider(languageId: string) {
        providerCalls.documentHighlight.push(languageId);
        eventLog.push(`provider:documentHighlight:${languageId}`);
        return { dispose: () => {} };
      },
      registerDocumentSymbolProvider(languageId: string) {
        providerCalls.documentSymbol.push(languageId);
        eventLog.push(`provider:documentSymbol:${languageId}`);
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
    eventLog.length = 0;
    fileContents.clear();
    resetWorkspaceStore();
    const monaco = createFakeMonaco();
    initializeModelCache(monaco);
    initializeLspBridge(monaco);
  });

  test("shares one Monaco model per file URI and sends didClose after the last release", async () => {
    const input = { workspaceId: WS_ID, filePath: "/workspace/src/a.ts" };
    fileContents.set("src/a.ts", "const a = 1;\n");

    const first = await acquireModel(input);
    const second = await acquireModel(input);

    expect(first.phase).toBe("ready");
    expect(first.model).toBe(second.model);
    const didOpenCalls = ipcCalls.filter(
      (call) => call.channel === "lsp" && call.method === "didOpen",
    );
    expect(didOpenCalls).toHaveLength(1);
    expect(didOpenCalls[0]?.args).toEqual({
      workspaceId: WS_ID,
      workspaceRoot: "/workspace",
      uri: "file:///workspace/src/a.ts",
      languageId: "typescript",
      version: 1,
      text: "const a = 1;\n",
    });
    expect(eventLog.slice(0, 7)).toEqual([
      "provider:hover:typescript",
      "provider:definition:typescript",
      "provider:completion:typescript",
      "provider:reference:typescript",
      "provider:documentHighlight:typescript",
      "provider:documentSymbol:typescript",
      "didOpen:typescript",
    ]);

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

  test("saveModel sends didSave with the text that was written", async () => {
    const input = { workspaceId: WS_ID, filePath: "/workspace/src/save.ts" };
    fileContents.set("src/save.ts", "before");

    const acquired = await acquireModel(input);
    const model = acquired.model;
    if (!model) throw new Error("expected ready model");

    model.setValue("after");
    ipcCalls.length = 0;

    const result = await saveModel(input);

    expect(result.kind).toBe("saved");
    expect(ipcCalls.filter((call) => call.channel === "lsp" && call.method === "didSave")).toEqual([
      {
        channel: "lsp",
        method: "didSave",
        args: {
          uri: "file:///workspace/src/save.ts",
          text: "after",
        },
      },
    ]);

    releaseModel(input);
  });

  test("second supported model of the same language does not register providers again", async () => {
    const firstInput = { workspaceId: WS_ID, filePath: "/workspace/src/a.ts" };
    const secondInput = { workspaceId: WS_ID, filePath: "/workspace/src/b.ts" };
    fileContents.set("src/a.ts", "export const a = 1;\n");
    fileContents.set("src/b.ts", "export const b = 2;\n");

    const first = await acquireModel(firstInput);
    const second = await acquireModel(secondInput);

    expect(first.phase).toBe("ready");
    expect(second.phase).toBe("ready");
    expect(
      ipcCalls.filter((call) => call.channel === "lsp" && call.method === "didOpen"),
    ).toHaveLength(2);
    expect(eventLog.filter((entry) => entry === "provider:hover:typescript")).toHaveLength(1);
    expect(eventLog.filter((entry) => entry === "provider:definition:typescript")).toHaveLength(1);
    expect(eventLog.filter((entry) => entry === "provider:completion:typescript")).toHaveLength(1);
    expect(eventLog.filter((entry) => entry === "provider:reference:typescript")).toHaveLength(1);
    expect(
      eventLog.filter((entry) => entry === "provider:documentHighlight:typescript"),
    ).toHaveLength(1);
    expect(eventLog.filter((entry) => entry === "provider:documentSymbol:typescript")).toHaveLength(
      1,
    );

    releaseModel(firstInput);
    releaseModel(secondInput);
  });

  test("python model acquire registers providers and sends didOpen", async () => {
    const input = { workspaceId: WS_ID, filePath: "/workspace/src with space/main file.py" };
    fileContents.set("src with space/main file.py", "value = 1\n");

    const acquired = await acquireModel(input);

    expect(acquired.phase).toBe("ready");
    expect(ipcCalls.filter((call) => call.channel === "lsp" && call.method === "didOpen")).toEqual([
      {
        channel: "lsp",
        method: "didOpen",
        args: {
          workspaceId: WS_ID,
          workspaceRoot: "/workspace",
          uri: "file:///workspace/src%20with%20space/main%20file.py",
          languageId: "python",
          version: 1,
          text: "value = 1\n",
        },
      },
    ]);
    expect(eventLog.slice(0, 7)).toEqual([
      "provider:hover:python",
      "provider:definition:python",
      "provider:completion:python",
      "provider:reference:python",
      "provider:documentHighlight:python",
      "provider:documentSymbol:python",
      "didOpen:python",
    ]);

    releaseModel(input);
  });

  test("plaintext model acquire does not register providers or send didOpen", async () => {
    const input = { workspaceId: WS_ID, filePath: "/workspace/notes/readme.txt" };
    fileContents.set("notes/readme.txt", "plain text\n");

    const acquired = await acquireModel(input);

    expect(acquired.phase).toBe("ready");
    expect(eventLog.filter((entry) => entry.startsWith("provider:"))).toEqual([]);
    expect(
      ipcCalls.filter((call) => call.channel === "lsp" && call.method === "didOpen"),
    ).toHaveLength(0);

    releaseModel(input);
  });
});

describe("services/editor LSP bridge", () => {
  test("registers providers lazily once per supported language", () => {
    const monaco = createFakeMonaco();

    initializeLspBridge(monaco);
    initializeLspBridge(monaco);
    expect(monaco.__providerCalls.hover).toEqual([]);
    expect(monaco.__providerCalls.definition).toEqual([]);
    expect(monaco.__providerCalls.completion).toEqual([]);
    expect(monaco.__providerCalls.reference).toEqual([]);
    expect(monaco.__providerCalls.documentHighlight).toEqual([]);
    expect(monaco.__providerCalls.documentSymbol).toEqual([]);

    ensureProvidersFor("typescript");
    ensureProvidersFor("typescript");
    ensureProvidersFor("javascript");
    ensureProvidersFor("python");

    expect(monaco.__providerCalls.hover).toEqual(["typescript", "javascript", "python"]);
    expect(monaco.__providerCalls.definition).toEqual(["typescript", "javascript", "python"]);
    expect(monaco.__providerCalls.completion).toEqual(["typescript", "javascript", "python"]);
    expect(monaco.__providerCalls.reference).toEqual(["typescript", "javascript", "python"]);
    expect(monaco.__providerCalls.documentHighlight).toEqual([
      "typescript",
      "javascript",
      "python",
    ]);
    expect(monaco.__providerCalls.documentSymbol).toEqual(["typescript", "javascript", "python"]);
  });
});
