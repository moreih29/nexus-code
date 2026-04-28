import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  lspTextEditToMonaco,
  registerLspFormattingProviders,
} from "./formatting-provider";

describe("Monaco LSP formatting providers", () => {
  test("maps shared text edits to Monaco text edits", () => {
    const monaco = createFakeMonaco();

    expect(
      lspTextEditToMonaco(monaco, {
        range: {
          start: { line: 0, character: 2 },
          end: { line: 0, character: 6 },
        },
        newText: "value",
      }),
    ).toEqual({
      range: new monaco.Range(1, 3, 1, 7),
      text: "value",
    });
  });

  test("registers document and range formatting providers that invoke the editor bridge", async () => {
    const monaco = createFakeMonaco();
    const model = {};
    const requests: unknown[] = [];

    registerLspFormattingProviders(monaco, {
      workspaceId: "ws_formatting" as WorkspaceId,
      path: "src/index.ts",
      language: "typescript",
      languageId: "typescript",
      model: model as never,
      editorApi: {
        async invoke(request) {
          requests.push(request);
          return {
            type: request.type === "lsp-formatting/document"
              ? "lsp-formatting/document/result"
              : "lsp-formatting/range/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            edits: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                newText: "const",
              },
            ],
            formattedAt: "2026-04-27T00:00:00.000Z",
          } as never;
        },
      },
    });

    const documentEdits = await monaco.documentProvider?.provideDocumentFormattingEdits(
      model,
      { tabSize: 2, insertSpaces: true },
    );
    const rangeEdits = await monaco.rangeProvider?.provideDocumentRangeFormattingEdits(
      model,
      new monaco.Range(1, 1, 2, 1),
      { tabSize: 4, insertSpaces: false },
    );

    expect(requests).toEqual([
      {
        type: "lsp-formatting/document",
        workspaceId: "ws_formatting",
        path: "src/index.ts",
        language: "typescript",
        options: { tabSize: 2, insertSpaces: true },
      },
      {
        type: "lsp-formatting/range",
        workspaceId: "ws_formatting",
        path: "src/index.ts",
        language: "typescript",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 1, character: 0 },
        },
        options: { tabSize: 4, insertSpaces: false },
      },
    ]);
    expect(documentEdits).toEqual([{ range: new monaco.Range(1, 1, 1, 6), text: "const" }]);
    expect(rangeEdits).toEqual([{ range: new monaco.Range(1, 1, 1, 6), text: "const" }]);
  });
});

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
    documentProvider: null as null | {
      provideDocumentFormattingEdits(model: unknown, options: unknown): Promise<unknown>;
    },
    rangeProvider: null as null | {
      provideDocumentRangeFormattingEdits(
        model: unknown,
        range: Range,
        options: unknown,
      ): Promise<unknown>;
    },
    languages: {
      registerDocumentFormattingEditProvider(_languageId: string, provider: unknown) {
        monaco.documentProvider = provider as typeof monaco.documentProvider;
        return { dispose() {} };
      },
      registerDocumentRangeFormattingEditProvider(_languageId: string, provider: unknown) {
        monaco.rangeProvider = provider as typeof monaco.rangeProvider;
        return { dispose() {} };
      },
    },
  };
  return monaco as never;
}
