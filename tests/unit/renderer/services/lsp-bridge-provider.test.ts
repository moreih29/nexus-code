import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type * as Monaco from "monaco-editor";

const ipcCalls: Array<{
  channel: string;
  method: string;
  args: unknown;
  opts: unknown;
}> = [];
const ipcResults = new Map<string, unknown>();

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock((channel: string, method: string, args: unknown, opts?: unknown) => {
    ipcCalls.push({ channel, method, args, opts });
    return Promise.resolve(ipcResults.get(method));
  }),
  ipcListen: mock(() => () => {}),
}));

const { ensureProvidersFor, initializeLspBridge, provideWorkspaceSymbols } = await import(
  "../../../../src/renderer/services/editor/lsp-bridge"
);

interface FakeUri {
  raw: string;
  toString(): string;
}

type ReferenceProvider = Monaco.languages.ReferenceProvider;
type HoverProvider = Monaco.languages.HoverProvider;
type DefinitionProvider = Monaco.languages.DefinitionProvider;
type CompletionItemProvider = Monaco.languages.CompletionItemProvider;
type DocumentHighlightProvider = Monaco.languages.DocumentHighlightProvider;
type DocumentSymbolProvider = Monaco.languages.DocumentSymbolProvider;

interface FixtureSnapshot {
  request: {
    params: unknown;
  };
  response: {
    result?: unknown;
  };
}

function createToken(): Monaco.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  } as Monaco.CancellationToken;
}

function createModel(
  uri: string,
  languageId = "typescript",
  word = { startColumn: 1, endColumn: 1, word: "" },
): Monaco.editor.ITextModel {
  return {
    uri: { raw: uri, toString: () => uri },
    getLanguageId: () => languageId,
    getWordUntilPosition: () => word,
  } as unknown as Monaco.editor.ITextModel;
}

function createFakeMonaco(): typeof Monaco & {
  providers: {
    hover: HoverProvider[];
    definition: DefinitionProvider[];
    completion: CompletionItemProvider[];
    reference: ReferenceProvider[];
    documentHighlight: DocumentHighlightProvider[];
    documentSymbol: DocumentSymbolProvider[];
  };
} {
  const providers = {
    hover: [] as HoverProvider[],
    definition: [] as DefinitionProvider[],
    completion: [] as CompletionItemProvider[],
    reference: [] as ReferenceProvider[],
    documentHighlight: [] as DocumentHighlightProvider[],
    documentSymbol: [] as DocumentSymbolProvider[],
  };

  return {
    Uri: {
      parse: (raw: string) => ({ raw, toString: () => raw }) as unknown as Monaco.Uri,
    },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    MarkerTag: { Unnecessary: 1, Deprecated: 2 },
    editor: {
      getModel: () => null,
      setModelMarkers: () => {},
    },
    languages: {
      CompletionItemKind: { Text: 1 },
      registerHoverProvider: (_languageId: string, provider: HoverProvider) => {
        providers.hover.push(provider);
        return { dispose: () => {} };
      },
      registerDefinitionProvider: (_languageId: string, provider: DefinitionProvider) => {
        providers.definition.push(provider);
        return { dispose: () => {} };
      },
      registerCompletionItemProvider: (_languageId: string, provider: CompletionItemProvider) => {
        providers.completion.push(provider);
        return { dispose: () => {} };
      },
      registerReferenceProvider: (_languageId: string, provider: ReferenceProvider) => {
        providers.reference.push(provider);
        return { dispose: () => {} };
      },
      registerDocumentHighlightProvider: (
        _languageId: string,
        provider: DocumentHighlightProvider,
      ) => {
        providers.documentHighlight.push(provider);
        return { dispose: () => {} };
      },
      registerDocumentSymbolProvider: (_languageId: string, provider: DocumentSymbolProvider) => {
        providers.documentSymbol.push(provider);
        return { dispose: () => {} };
      },
    },
    providers,
  } as unknown as typeof Monaco & {
    providers: {
      hover: HoverProvider[];
      definition: DefinitionProvider[];
      completion: CompletionItemProvider[];
      reference: ReferenceProvider[];
      documentHighlight: DocumentHighlightProvider[];
      documentSymbol: DocumentSymbolProvider[];
    };
  };
}

const lspRange = {
  start: { line: 1, character: 2 },
  end: { line: 1, character: 6 },
};

const monacoRange = {
  startLineNumber: 2,
  startColumn: 3,
  endLineNumber: 2,
  endColumn: 7,
};

const RESPONSE_DIR = resolve(import.meta.dir, "../../../fixtures/lsp/pyright/responses");

function loadFixture(name: string): FixtureSnapshot {
  return JSON.parse(readFileSync(resolve(RESPONSE_DIR, `${name}.json`), "utf8")) as FixtureSnapshot;
}

function fixtureTextDocumentUri(fixture: FixtureSnapshot): string {
  const params = fixture.request.params;
  if (typeof params !== "object" || params === null || !("textDocument" in params)) {
    throw new Error("Fixture params missing textDocument");
  }
  const textDocument = params.textDocument;
  if (typeof textDocument !== "object" || textDocument === null || !("uri" in textDocument)) {
    throw new Error("Fixture textDocument missing uri");
  }
  if (typeof textDocument.uri !== "string") throw new Error("Fixture uri must be a string");
  return textDocument.uri;
}

function fixturePosition(fixture: FixtureSnapshot): Monaco.Position {
  const params = fixture.request.params;
  if (typeof params !== "object" || params === null || !("position" in params)) {
    throw new Error("Fixture params missing position");
  }
  const position = params.position;
  if (
    typeof position !== "object" ||
    position === null ||
    !("line" in position) ||
    !("character" in position) ||
    typeof position.line !== "number" ||
    typeof position.character !== "number"
  ) {
    throw new Error("Fixture position must have line and character numbers");
  }
  return { lineNumber: position.line + 1, column: position.character + 1 } as Monaco.Position;
}

function completionItemsFromFixture(result: unknown): Array<{ label: string; kind?: number }> {
  const rawItems =
    Array.isArray(result) || typeof result !== "object" || result === null || !("items" in result)
      ? result
      : result.items;
  if (!Array.isArray(rawItems)) throw new Error("Fixture completion result missing items");
  return rawItems.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("label" in item) ||
      typeof item.label !== "string"
    ) {
      throw new Error("Fixture completion item missing label");
    }
    return {
      label: item.label,
      ...("kind" in item && typeof item.kind === "number" ? { kind: item.kind } : {}),
    };
  });
}

describe("LSP bridge navigation providers", () => {
  beforeEach(() => {
    ipcCalls.length = 0;
    ipcResults.clear();
  });

  test("provideHover maps Pyright hover fixture contents and range", async () => {
    const monaco = createFakeMonaco();
    initializeLspBridge(monaco);
    ensureProvidersFor("python");
    const fixture = loadFixture("hover-module_a-greet");
    ipcResults.set("hover", fixture.response.result);

    const result = await monaco.providers.hover[0].provideHover(
      createModel(fixtureTextDocumentUri(fixture), "python"),
      fixturePosition(fixture),
      createToken(),
    );

    expect(ipcCalls[0]).toMatchObject({
      channel: "lsp",
      method: "hover",
      args: {
        uri: "file:///__PYRIGHT_FIXTURE_WORKSPACE__/module_a.py",
        line: 7,
        character: 10,
      },
    });
    expect(result?.contents[0].value).toContain("def greet");
    expect(result?.contents[0].value).toContain("\\(method\\)");
    expect(result?.range).toEqual({
      startLineNumber: 8,
      startColumn: 9,
      endLineNumber: 8,
      endColumn: 14,
    });
  });

  test("provideDefinition maps Pyright definition fixture locations", async () => {
    const monaco = createFakeMonaco();
    initializeLspBridge(monaco);
    ensureProvidersFor("python");
    const fixture = loadFixture("definition-module_b-greeter");
    ipcResults.set("definition", fixture.response.result);

    const result = await monaco.providers.definition[0].provideDefinition(
      createModel(fixtureTextDocumentUri(fixture), "python"),
      fixturePosition(fixture),
      createToken(),
    );

    expect(ipcCalls[0]).toMatchObject({
      channel: "lsp",
      method: "definition",
      args: {
        uri: "file:///__PYRIGHT_FIXTURE_WORKSPACE__/module_b.py",
        line: 8,
        character: 26,
      },
    });
    expect(result).toEqual([
      {
        uri: {
          raw: "file:///__PYRIGHT_FIXTURE_WORKSPACE__/module_a.py",
          toString: expect.any(Function),
        } satisfies FakeUri,
        range: {
          startLineNumber: 4,
          startColumn: 7,
          endLineNumber: 4,
          endColumn: 14,
        },
      },
    ]);
  });

  test("provideCompletionItems maps Pyright completion fixture items without resolve fields", async () => {
    const monaco = createFakeMonaco();
    initializeLspBridge(monaco);
    ensureProvidersFor("python");
    const fixture = loadFixture("completion-module_a-context");
    const completionItems = completionItemsFromFixture(fixture.response.result);
    ipcResults.set("completion", completionItems);
    const position = fixturePosition(fixture);

    const result = await monaco.providers.completion[0].provideCompletionItems(
      createModel(fixtureTextDocumentUri(fixture), "python", {
        startColumn: position.column,
        endColumn: position.column,
        word: "",
      }),
      position,
      {} as Monaco.languages.CompletionContext,
      createToken(),
    );

    expect(ipcCalls[0]).toMatchObject({
      channel: "lsp",
      method: "completion",
      args: {
        uri: "file:///__PYRIGHT_FIXTURE_WORKSPACE__/module_a.py",
        line: 8,
        character: 36,
      },
    });
    expect(result.suggestions).toHaveLength(completionItems.length);
    expect(result.suggestions).toContainEqual({
      label: "prefix",
      kind: 6,
      insertText: "prefix",
      range: {
        startLineNumber: 9,
        startColumn: 37,
        endLineNumber: 9,
        endColumn: 37,
      },
    });
    expect(result.suggestions).toContainEqual({
      label: "greet",
      kind: 2,
      insertText: "greet",
      range: {
        startLineNumber: 9,
        startColumn: 37,
        endLineNumber: 9,
        endColumn: 37,
      },
    });
  });

  test("provideReferences sends includeDeclaration and maps LSP locations", async () => {
    const monaco = createFakeMonaco();
    initializeLspBridge(monaco);
    ensureProvidersFor("typescript");
    ipcResults.set("references", [{ uri: "file:///workspace/ref.ts", range: lspRange }]);

    const result = await monaco.providers.reference[0].provideReferences(
      createModel("file:///workspace/main.ts"),
      { lineNumber: 3, column: 5 } as Monaco.Position,
      { includeDeclaration: false },
      createToken(),
    );

    expect(ipcCalls[0]).toMatchObject({
      channel: "lsp",
      method: "references",
      args: {
        uri: "file:///workspace/main.ts",
        line: 2,
        character: 4,
        includeDeclaration: false,
      },
    });
    expect(result).toEqual([
      {
        uri: { raw: "file:///workspace/ref.ts", toString: expect.any(Function) } satisfies FakeUri,
        range: monacoRange,
      },
    ]);
  });

  test("provideDocumentHighlights maps LSP highlight ranges and kinds", async () => {
    const monaco = createFakeMonaco();
    initializeLspBridge(monaco);
    ensureProvidersFor("typescript");
    ipcResults.set("documentHighlight", [
      { range: lspRange, kind: 1 },
      { range: lspRange, kind: 2 },
      { range: lspRange, kind: 3 },
      { range: lspRange },
    ]);

    const result = await monaco.providers.documentHighlight[0].provideDocumentHighlights(
      createModel("file:///workspace/main.ts"),
      { lineNumber: 3, column: 5 } as Monaco.Position,
      createToken(),
    );

    expect(ipcCalls[0]).toMatchObject({
      channel: "lsp",
      method: "documentHighlight",
      args: { uri: "file:///workspace/main.ts", line: 2, character: 4 },
    });
    expect(result).toEqual([
      { range: monacoRange, kind: 0 },
      { range: monacoRange, kind: 1 },
      { range: monacoRange, kind: 2 },
      { range: monacoRange, kind: undefined },
    ]);
  });

  test("provideDocumentSymbols maps hierarchical LSP document symbols", async () => {
    const monaco = createFakeMonaco();
    initializeLspBridge(monaco);
    ensureProvidersFor("typescript");
    ipcResults.set("documentSymbol", [
      {
        name: "ClassName",
        detail: "class detail",
        kind: 5,
        tags: [1],
        range: lspRange,
        selectionRange: lspRange,
        children: [{ name: "method", kind: 6, range: lspRange, selectionRange: lspRange }],
      },
    ]);

    const result = await monaco.providers.documentSymbol[0].provideDocumentSymbols(
      createModel("file:///workspace/main.ts"),
      createToken(),
    );

    expect(ipcCalls[0]).toMatchObject({
      channel: "lsp",
      method: "documentSymbol",
      args: { uri: "file:///workspace/main.ts" },
    });
    expect(result).toEqual([
      {
        name: "ClassName",
        detail: "class detail",
        kind: 4,
        tags: [1],
        range: monacoRange,
        selectionRange: monacoRange,
        children: [
          {
            name: "method",
            detail: "",
            kind: 5,
            tags: [],
            range: monacoRange,
            selectionRange: monacoRange,
            children: undefined,
          },
        ],
      },
    ]);
  });

  test("provideWorkspaceSymbols maps workspace symbols and short-circuits empty queries", async () => {
    const monaco = createFakeMonaco();
    ipcResults.set("workspaceSymbol", [
      {
        name: "WorkspaceClass",
        kind: 5,
        location: { uri: "file:///workspace/main.ts", range: lspRange },
        containerName: "module",
      },
    ]);

    const empty = await provideWorkspaceSymbols(monaco, "ws-1", "   ");
    expect(empty).toEqual([]);
    expect(ipcCalls).toHaveLength(0);

    const result = await provideWorkspaceSymbols(monaco, "ws-1", "Class");

    expect(ipcCalls[0]).toMatchObject({
      channel: "lsp",
      method: "workspaceSymbol",
      args: { workspaceId: "ws-1", query: "Class" },
    });
    expect(result).toEqual([
      {
        name: "WorkspaceClass",
        kind: 4,
        tags: undefined,
        containerName: "module",
        location: {
          uri: {
            raw: "file:///workspace/main.ts",
            toString: expect.any(Function),
          } satisfies FakeUri,
          range: monacoRange,
        },
      },
    ]);
  });
});
