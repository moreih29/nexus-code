import { describe, expect, test } from "bun:test";

import type { LspCompletionItemKind } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  mapCompletionItemKindToMonaco,
  mapLspCompletionItemToMonaco,
  registerLspCompletionProvider,
} from "./completion-provider";

describe("Monaco LSP completion provider", () => {
  test("maps shared CompletionItemKind values to Monaco kinds", () => {
    const kind = createCompletionItemKindMap();
    const cases: LspCompletionItemKind[] = [
      "text",
      "method",
      "function",
      "constructor",
      "field",
      "variable",
      "class",
      "interface",
      "module",
      "property",
      "unit",
      "value",
      "enum",
      "keyword",
      "snippet",
      "color",
      "file",
      "reference",
      "folder",
      "enum-member",
      "constant",
      "struct",
      "event",
      "operator",
      "type-parameter",
    ];

    expect(cases.map((itemKind) => mapCompletionItemKindToMonaco(itemKind, kind))).toEqual([
      kind.Text,
      kind.Method,
      kind.Function,
      kind.Constructor,
      kind.Field,
      kind.Variable,
      kind.Class,
      kind.Interface,
      kind.Module,
      kind.Property,
      kind.Unit,
      kind.Value,
      kind.Enum,
      kind.Keyword,
      kind.Snippet,
      kind.Color,
      kind.File,
      kind.Reference,
      kind.Folder,
      kind.EnumMember,
      kind.Constant,
      kind.Struct,
      kind.Event,
      kind.Operator,
      kind.TypeParameter,
    ]);
  });

  test("maps snippets and additionalTextEdits to Monaco completion items", () => {
    const monaco = createFakeMonaco();
    const defaultRange = new monaco.Range(1, 3, 1, 7);

    const item = mapLspCompletionItemToMonaco(
      monaco,
      {
        label: "for",
        kind: "snippet",
        detail: "loop",
        documentation: "Loop snippet",
        sortText: "0001",
        filterText: "for",
        insertText: "for (const ${1:item} of ${2:items}) {\n\t$0\n}",
        insertTextFormat: "snippet",
        range: {
          insert: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 7 },
          },
          replace: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 10 },
          },
        },
        additionalTextEdits: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: "import { items } from './items';\n",
          },
        ],
        commitCharacters: [";"],
        preselect: true,
        deprecated: true,
      },
      defaultRange,
    );

    expect(item).toMatchObject({
      label: "for",
      kind: monaco.languages.CompletionItemKind.Snippet,
      detail: "loop",
      documentation: { value: "Loop snippet" },
      insertText: "for (const ${1:item} of ${2:items}) {\n\t$0\n}",
      insertTextRules:
        monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      additionalTextEdits: [
        {
          range: new monaco.Range(1, 1, 1, 1),
          text: "import { items } from './items';\n",
        },
      ],
      commitCharacters: [";"],
      preselect: true,
      tags: [monaco.languages.CompletionItemTag.Deprecated],
    });
    expect(item.range).toEqual({
      insert: new monaco.Range(3, 5, 3, 8),
      replace: new monaco.Range(3, 5, 3, 11),
    });
  });

  test("registers a model-scoped provider that invokes the editor bridge", async () => {
    const monaco = createFakeMonaco();
    const model = createFakeModel();
    const otherModel = createFakeModel();
    const requests: unknown[] = [];
    registerLspCompletionProvider(monaco, {
      workspaceId: "ws_completion" as WorkspaceId,
      path: "src/index.ts",
      language: "typescript",
      languageId: "typescript",
      model,
      editorApi: {
        async invoke(request) {
          requests.push(request);
          return {
            type: "lsp-completion/complete/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            isIncomplete: true,
            completedAt: "2026-04-27T00:00:00.000Z",
            items: [
              {
                label: "console",
                kind: "variable",
                insertText: "console",
                insertTextFormat: "plain-text",
                additionalTextEdits: [],
              },
            ],
          };
        },
      },
    });

    expect(monaco.registeredProvider?.languageId).toBe("typescript");
    await expect(
      monaco.registeredProvider?.provider.provideCompletionItems(
        otherModel,
        { lineNumber: 2, column: 8 },
        { triggerKind: monaco.languages.CompletionTriggerKind.Invoke },
      ),
    ).resolves.toEqual({ suggestions: [] });

    const result = await monaco.registeredProvider?.provider.provideCompletionItems(
      model,
      { lineNumber: 2, column: 8 },
      {
        triggerKind: monaco.languages.CompletionTriggerKind.TriggerCharacter,
        triggerCharacter: ".",
      },
    );

    expect(requests).toEqual([
      {
        type: "lsp-completion/complete",
        workspaceId: "ws_completion",
        path: "src/index.ts",
        language: "typescript",
        position: {
          line: 1,
          character: 7,
        },
        triggerKind: "trigger-character",
        triggerCharacter: ".",
      },
    ]);
    expect(result).toMatchObject({
      incomplete: true,
      suggestions: [
        {
          label: "console",
          insertText: "console",
          range: new monaco.Range(2, 5, 2, 8),
        },
      ],
    });
  });
});

function createFakeModel() {
  return {
    getWordUntilPosition() {
      return {
        startColumn: 5,
        endColumn: 8,
      };
    },
  } as never;
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
      CompletionItemKind: createCompletionItemKindMap(),
      CompletionItemInsertTextRule: {
        InsertAsSnippet: 4,
      },
      CompletionItemTag: {
        Deprecated: 1,
      },
      CompletionTriggerKind: {
        Invoke: 0,
        TriggerCharacter: 1,
        TriggerForIncompleteCompletions: 2,
      },
      registerCompletionItemProvider(languageId: string, provider: unknown) {
        monaco.registeredProvider = {
          languageId,
          provider: provider as {
            provideCompletionItems(
              model: unknown,
              position: { lineNumber: number; column: number },
              context: { triggerKind: number; triggerCharacter?: string },
            ): Promise<unknown>;
          },
        };
        return {
          dispose() {
            monaco.disposed = true;
          },
        };
      },
    },
    disposed: false,
    registeredProvider: null as null | {
      languageId: string;
      provider: {
        provideCompletionItems(
          model: unknown,
          position: { lineNumber: number; column: number },
          context: { triggerKind: number; triggerCharacter?: string },
        ): Promise<unknown>;
      };
    },
  };
  return monaco as never;
}

function createCompletionItemKindMap() {
  return {
    Text: 1,
    Method: 2,
    Function: 3,
    Constructor: 4,
    Field: 5,
    Variable: 6,
    Class: 7,
    Interface: 8,
    Module: 9,
    Property: 10,
    Unit: 11,
    Value: 12,
    Enum: 13,
    Keyword: 14,
    Snippet: 15,
    Color: 16,
    File: 17,
    Reference: 18,
    Folder: 19,
    EnumMember: 20,
    Constant: 21,
    Struct: 22,
    Event: 23,
    Operator: 24,
    TypeParameter: 25,
  };
}
