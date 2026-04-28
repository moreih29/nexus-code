import { describe, expect, test } from "bun:test";

import type { LspSymbolKind } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  mapLspDocumentSymbolsToMonaco,
  mapSymbolKindToMonaco,
  registerLspDocumentSymbolsProvider,
} from "./document-symbols-provider";

describe("Monaco LSP document symbols provider", () => {
  test("maps shared symbol kinds to Monaco symbol kinds", () => {
    const symbolKind = createSymbolKindMap();
    const kinds: LspSymbolKind[] = [
      "file",
      "module",
      "namespace",
      "package",
      "class",
      "method",
      "property",
      "field",
      "constructor",
      "enum",
      "interface",
      "function",
      "variable",
      "constant",
      "string",
      "number",
      "boolean",
      "array",
      "object",
      "key",
      "null",
      "enum-member",
      "struct",
      "event",
      "operator",
      "type-parameter",
    ];

    expect(kinds.map((kind) => mapSymbolKindToMonaco(kind, symbolKind))).toEqual([
      symbolKind.File,
      symbolKind.Module,
      symbolKind.Namespace,
      symbolKind.Package,
      symbolKind.Class,
      symbolKind.Method,
      symbolKind.Property,
      symbolKind.Field,
      symbolKind.Constructor,
      symbolKind.Enum,
      symbolKind.Interface,
      symbolKind.Function,
      symbolKind.Variable,
      symbolKind.Constant,
      symbolKind.String,
      symbolKind.Number,
      symbolKind.Boolean,
      symbolKind.Array,
      symbolKind.Object,
      symbolKind.Key,
      symbolKind.Null,
      symbolKind.EnumMember,
      symbolKind.Struct,
      symbolKind.Event,
      symbolKind.Operator,
      symbolKind.TypeParameter,
    ]);
  });

  test("maps DocumentSymbol and SymbolInformation items to Monaco document symbols", () => {
    const monaco = createFakeMonaco();
    expect(
      mapLspDocumentSymbolsToMonaco(monaco, {
        type: "lsp-document-symbols/read/result",
        workspaceId: "ws_symbols" as WorkspaceId,
        path: "src/index.ts",
        language: "typescript",
        symbols: [
          {
            type: "document-symbol",
            name: "Outer",
            detail: "class",
            kind: "class",
            tags: ["deprecated"],
            range: lspRange(0, 0, 10, 1),
            selectionRange: lspRange(0, 6, 0, 11),
            children: [
              {
                type: "document-symbol",
                name: "method",
                detail: null,
                kind: "method",
                tags: [],
                range: lspRange(1, 2, 3, 3),
                selectionRange: lspRange(1, 2, 1, 8),
                children: [],
              },
            ],
          },
          {
            type: "symbol-information",
            name: "helper",
            kind: "function",
            tags: ["deprecated"],
            containerName: "module",
            location: {
              uri: "file:///workspace/src/index.ts",
              path: "src/index.ts",
              range: lspRange(12, 0, 14, 1),
            },
          },
        ],
        readAt: "2026-04-27T00:00:00.000Z",
      }),
    ).toEqual([
      {
        name: "Outer",
        detail: "class",
        kind: monaco.languages.SymbolKind.Class,
        tags: [monaco.languages.SymbolTag.Deprecated],
        range: new monaco.Range(1, 1, 11, 2),
        selectionRange: new monaco.Range(1, 7, 1, 12),
        children: [
          {
            name: "method",
            detail: "",
            kind: monaco.languages.SymbolKind.Method,
            tags: [],
            range: new monaco.Range(2, 3, 4, 4),
            selectionRange: new monaco.Range(2, 3, 2, 9),
            children: [],
          },
        ],
      },
      {
        name: "helper",
        detail: "",
        kind: monaco.languages.SymbolKind.Function,
        tags: [monaco.languages.SymbolTag.Deprecated],
        containerName: "module",
        range: new monaco.Range(13, 1, 15, 2),
        selectionRange: new monaco.Range(13, 1, 15, 2),
        children: [],
      },
    ]);
  });

  test("registers a model-scoped provider that invokes the editor bridge", async () => {
    const monaco = createFakeMonaco();
    const model = {};
    const requests: unknown[] = [];
    registerLspDocumentSymbolsProvider(monaco, {
      workspaceId: "ws_symbols" as WorkspaceId,
      path: "src/index.ts",
      language: "typescript",
      languageId: "typescript",
      model: model as never,
      editorApi: {
        async invoke(request) {
          requests.push(request);
          return {
            type: "lsp-document-symbols/read/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            symbols: [],
            readAt: "2026-04-27T00:00:00.000Z",
          };
        },
      },
    });

    await monaco.registeredDocumentSymbolProvider?.provider.provideDocumentSymbols(model);
    expect(requests).toEqual([
      {
        type: "lsp-document-symbols/read",
        workspaceId: "ws_symbols",
        path: "src/index.ts",
        language: "typescript",
      },
    ]);
  });
});

function lspRange(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function createFakeMonaco() {
  class Range {
    public constructor(
      public readonly startLineNumber: number,
      public readonly startColumn: number,
      public readonly endLineNumber: number,
      public readonly endColumn: number,
    ) {}
  }

  const monaco = {
    Range,
    languages: {
      SymbolKind: createSymbolKindMap(),
      SymbolTag: {
        Deprecated: 1,
      },
      registerDocumentSymbolProvider(languageId: string, provider: unknown) {
        monaco.registeredDocumentSymbolProvider = {
          languageId,
          provider: provider as {
            provideDocumentSymbols(model: unknown): Promise<unknown>;
          },
        };
        return { dispose() {} };
      },
    },
    registeredDocumentSymbolProvider: null as null | {
      languageId: string;
      provider: {
        provideDocumentSymbols(model: unknown): Promise<unknown>;
      };
    },
  };
  return monaco as never;
}

function createSymbolKindMap() {
  return {
    File: 0,
    Module: 1,
    Namespace: 2,
    Package: 3,
    Class: 4,
    Method: 5,
    Property: 6,
    Field: 7,
    Constructor: 8,
    Enum: 9,
    Interface: 10,
    Function: 11,
    Variable: 12,
    Constant: 13,
    String: 14,
    Number: 15,
    Boolean: 16,
    Array: 17,
    Object: 18,
    Key: 19,
    Null: 20,
    EnumMember: 21,
    Struct: 22,
    Event: 23,
    Operator: 24,
    TypeParameter: 25,
  };
}
