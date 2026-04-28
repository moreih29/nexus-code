import { describe, expect, test } from "bun:test";

import type { LspWorkspaceEdit } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import { registerLspRenameProvider } from "./rename-provider";

describe("Monaco LSP rename provider", () => {
  test("runs prepareRename and applies WorkspaceEdit through editor state", async () => {
    const monaco = createFakeMonaco();
    const model = createFakeModel();
    const requests: unknown[] = [];
    const appliedEdits: LspWorkspaceEdit[] = [];

    registerLspRenameProvider(monaco, {
      workspaceId: "ws_rename" as WorkspaceId,
      path: "src/index.ts",
      language: "typescript",
      languageId: "typescript",
      model: model as never,
      editorApi: {
        async invoke(request) {
          requests.push(request);
          if (request.type === "lsp-rename/prepare") {
            return {
              type: "lsp-rename/prepare/result",
              workspaceId: request.workspaceId,
              path: request.path,
              language: request.language,
              canRename: true,
              range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 11 },
              },
              placeholder: "value",
              defaultBehavior: false,
              preparedAt: "2026-04-27T00:00:00.000Z",
            };
          }
          return {
            type: "lsp-rename/rename/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            workspaceEdit: {
              changes: [
                {
                  path: request.path,
                  edits: [
                    {
                      range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 11 },
                      },
                      newText: request.newName,
                    },
                  ],
                },
              ],
            },
            renamedAt: "2026-04-27T00:00:00.000Z",
          };
        },
      },
      async applyWorkspaceEdit(_workspaceId, edit) {
        appliedEdits.push(edit);
        return {
          applied: true,
          appliedPaths: ["src/index.ts"],
          skippedClosedPaths: [],
          skippedReadFailures: [],
          skippedUnsupportedPaths: [],
        };
      },
    });

    const location = await monaco.renameProvider?.resolveRenameLocation(
      model,
      { lineNumber: 1, column: 8 },
    );
    const edits = await monaco.renameProvider?.provideRenameEdits(
      model,
      { lineNumber: 1, column: 8 },
      "nextValue",
    );

    expect(location).toEqual({
      range: new monaco.Range(1, 7, 1, 12),
      text: "value",
    });
    expect(edits).toEqual({ edits: [] });
    expect(requests).toEqual([
      {
        type: "lsp-rename/prepare",
        workspaceId: "ws_rename",
        path: "src/index.ts",
        language: "typescript",
        position: { line: 0, character: 7 },
      },
      {
        type: "lsp-rename/rename",
        workspaceId: "ws_rename",
        path: "src/index.ts",
        language: "typescript",
        position: { line: 0, character: 7 },
        newName: "nextValue",
      },
    ]);
    expect(appliedEdits).toEqual([
      {
        changes: [
          {
            path: "src/index.ts",
            edits: [
              {
                range: {
                  start: { line: 0, character: 6 },
                  end: { line: 0, character: 11 },
                },
                newText: "nextValue",
              },
            ],
          },
        ],
      },
    ]);
  });
});

function createFakeModel() {
  return {
    getValueInRange() {
      return "value";
    },
    getWordAtPosition() {
      return {
        word: "value",
        startColumn: 7,
        endColumn: 12,
      };
    },
    getWordUntilPosition() {
      return {
        word: "value",
        startColumn: 7,
        endColumn: 12,
      };
    },
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
    renameProvider: null as null | {
      resolveRenameLocation(model: unknown, position: unknown): Promise<unknown>;
      provideRenameEdits(model: unknown, position: unknown, newName: string): Promise<unknown>;
    },
    languages: {
      registerRenameProvider(_languageId: string, provider: unknown) {
        monaco.renameProvider = provider as typeof monaco.renameProvider;
        return { dispose() {} };
      },
    },
  };
  return monaco as never;
}
