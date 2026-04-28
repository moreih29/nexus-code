import { describe, expect, test } from "bun:test";

import type { LspCodeAction, LspWorkspaceEdit } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  mapLspCodeActionToMonaco,
  registerLspCodeActionProvider,
} from "./code-action-provider";

describe("Monaco LSP code action provider", () => {
  test("maps quickfix/source code actions and disables command-only actions", () => {
    const monaco = createFakeMonaco();
    const action: LspCodeAction = {
      title: "Fix all",
      kind: "source.fixAll",
      diagnostics: [],
      edit: {
        changes: [
          {
            path: "src/index.ts",
            edits: [],
          },
        ],
      },
      command: null,
      isPreferred: true,
    };
    const commandOnly: LspCodeAction = {
      title: "Organize Imports",
      diagnostics: [],
      command: {
        title: "Organize Imports",
        command: "source.organizeImports",
        arguments: [],
      },
    };

    expect(mapLspCodeActionToMonaco(monaco, action, "cmd.apply")).toMatchObject({
      title: "Fix all",
      kind: "source.fixAll",
      isPreferred: true,
      command: {
        id: "cmd.apply",
        title: "Fix all",
        arguments: [action],
      },
    });
    expect(mapLspCodeActionToMonaco(monaco, commandOnly, "cmd.apply")).toMatchObject({
      title: "Organize Imports",
      disabled: "LSP command execution is not supported yet.",
    });
  });

  test("registers provider that requests actions and applies WorkspaceEdit through state", async () => {
    const monaco = createFakeMonaco();
    const model = {};
    const requests: unknown[] = [];
    const appliedEdits: LspWorkspaceEdit[] = [];

    registerLspCodeActionProvider(monaco, {
      workspaceId: "ws_code_action" as WorkspaceId,
      path: "src/index.ts",
      language: "typescript",
      languageId: "typescript",
      model: model as never,
      editorApi: {
        async invoke(request) {
          requests.push(request);
          return {
            type: "lsp-code-action/list/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            actions: [
              {
                title: "Add import",
                kind: "quickfix",
                diagnostics: [],
                edit: {
                  changes: [
                    {
                      path: request.path,
                      edits: [
                        {
                          range: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 0 },
                          },
                          newText: "import { value } from './value';\n",
                        },
                      ],
                    },
                  ],
                },
                command: null,
                isPreferred: true,
              },
            ],
            listedAt: "2026-04-27T00:00:00.000Z",
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

    const result = await monaco.codeActionProvider?.provideCodeActions(
      model,
      new monaco.Range(1, 1, 1, 6),
      {
        markers: [
          {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 6,
            severity: monaco.MarkerSeverity.Error,
            message: "Missing import.",
          },
        ],
        only: "quickfix",
      },
    );
    const action = result?.actions[0];
    monaco.commands.get(action?.command?.id ?? "")?.({}, ...(action?.command?.arguments ?? []));

    expect(requests).toEqual([
      {
        type: "lsp-code-action/list",
        workspaceId: "ws_code_action",
        path: "src/index.ts",
        language: "typescript",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        diagnostics: [
          {
            path: "src/index.ts",
            language: "typescript",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            severity: "error",
            message: "Missing import.",
            source: null,
            code: null,
          },
        ],
        only: "quickfix",
      },
    ]);
    expect(action).toMatchObject({
      title: "Add import",
      kind: "quickfix",
      isPreferred: true,
    });
    expect(appliedEdits).toEqual([
      {
        changes: [
          {
            path: "src/index.ts",
            edits: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
                newText: "import { value } from './value';\n",
              },
            ],
          },
        ],
      },
    ]);
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
    MarkerSeverity: {
      Hint: 1,
      Info: 2,
      Warning: 4,
      Error: 8,
    },
    commands: new Map<string, (accessor: unknown, ...args: unknown[]) => void>(),
    codeActionProvider: null as null | {
      provideCodeActions(model: unknown, range: Range, context: unknown): Promise<{
        actions: Array<{
          command?: {
            id: string;
            arguments?: unknown[];
          };
        }>;
      }>;
    },
    editor: {
      registerCommand(id: string, handler: (accessor: unknown, ...args: unknown[]) => void) {
        monaco.commands.set(id, handler);
        return { dispose() { monaco.commands.delete(id); } };
      },
    },
    languages: {
      registerCodeActionProvider(_languageId: string, provider: unknown) {
        monaco.codeActionProvider = provider as typeof monaco.codeActionProvider;
        return { dispose() {} };
      },
    },
  };
  return monaco as never;
}
