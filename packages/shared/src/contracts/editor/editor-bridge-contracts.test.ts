import { describe, expect, test } from "bun:test";

import {
  EDITOR_BRIDGE_EVENT_CHANNEL,
  EDITOR_BRIDGE_INVOKE_CHANNEL,
} from "../ipc-channels";
import type {
  LspDiagnostic,
  EditorBridgeEvent,
  EditorBridgeRequest,
  EditorBridgeResult,
  EditorBridgeResultFor,
  WorkspaceFileReadRequest,
  LspLanguage,
} from "./editor-bridge";
import type { WorkspaceId } from "../workspace/workspace";

function assertNever(value: never): never {
  throw new Error(`Unhandled editor bridge contract variant: ${JSON.stringify(value)}`);
}

function visitRequest(request: EditorBridgeRequest): EditorBridgeRequest["type"] {
  switch (request.type) {
    case "workspace-files/tree/read":
    case "workspace-files/file/create":
    case "workspace-files/file/delete":
    case "workspace-files/file/rename":
    case "workspace-files/file/read":
    case "workspace-files/file/write":
    case "workspace-git-badges/read":
    case "lsp-diagnostics/read":
    case "lsp-status/read":
    case "lsp-completion/complete":
    case "lsp-hover/read":
    case "lsp-definition/read":
    case "lsp-references/read":
    case "lsp-document-symbols/read":
    case "lsp-rename/prepare":
    case "lsp-rename/rename":
    case "lsp-formatting/document":
    case "lsp-formatting/range":
    case "lsp-signature-help/get":
    case "lsp-code-action/list":
    case "lsp-document/open":
    case "lsp-document/change":
    case "lsp-document/close":
      return request.type;
    default:
      return assertNever(request);
  }
}

function visitResult(result: EditorBridgeResult): EditorBridgeResult["type"] {
  switch (result.type) {
    case "workspace-files/tree/read/result":
    case "workspace-files/file/create/result":
    case "workspace-files/file/delete/result":
    case "workspace-files/file/rename/result":
    case "workspace-files/file/read/result":
    case "workspace-files/file/write/result":
    case "workspace-git-badges/read/result":
    case "lsp-diagnostics/read/result":
    case "lsp-status/read/result":
    case "lsp-completion/complete/result":
    case "lsp-hover/read/result":
    case "lsp-definition/read/result":
    case "lsp-references/read/result":
    case "lsp-document-symbols/read/result":
    case "lsp-rename/prepare/result":
    case "lsp-rename/rename/result":
    case "lsp-formatting/document/result":
    case "lsp-formatting/range/result":
    case "lsp-signature-help/get/result":
    case "lsp-code-action/list/result":
    case "lsp-document/open/result":
    case "lsp-document/change/result":
    case "lsp-document/close/result":
      return result.type;
    default:
      return assertNever(result);
  }
}

function visitEvent(event: EditorBridgeEvent): EditorBridgeEvent["type"] {
  switch (event.type) {
    case "workspace-files/watch":
    case "workspace-git-badges/changed":
    case "lsp-diagnostics/changed":
    case "lsp-status/changed":
      return event.type;
    default:
      return assertNever(event);
  }
}

const workspaceId = "ws_editor_alpha" as WorkspaceId;
const now = "2026-04-27T00:00:00.000Z";

const diagnostic: LspDiagnostic = {
  path: "src/index.ts",
  language: "typescript",
  range: {
    start: {
      line: 0,
      character: 7,
    },
    end: {
      line: 0,
      character: 14,
    },
  },
  severity: "error",
  message: "Cannot find name 'value'.",
  source: "tsserver",
  code: 2304,
};

describe("Editor bridge shared contracts", () => {
  test("declares IPC channels for editor invoke and event traffic", () => {
    expect(EDITOR_BRIDGE_INVOKE_CHANNEL).toBe("editor-bridge:invoke");
    expect(EDITOR_BRIDGE_EVENT_CHANNEL).toBe("editor-bridge:event");
  });

  test("accepts representative valid request payload shapes", () => {
    const requests: EditorBridgeRequest[] = [
      {
        type: "workspace-files/tree/read",
        workspaceId,
        rootPath: "src",
      },
      {
        type: "workspace-files/file/create",
        workspaceId,
        path: "src/new-file.ts",
        kind: "file",
        content: "export {};",
      },
      {
        type: "workspace-files/file/delete",
        workspaceId,
        path: "src/old-file.ts",
      },
      {
        type: "workspace-files/file/rename",
        workspaceId,
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
      {
        type: "workspace-files/file/read",
        workspaceId,
        path: "src/index.ts",
      },
      {
        type: "workspace-files/file/write",
        workspaceId,
        path: "src/index.ts",
        content: "export const value = 1;\n",
        expectedVersion: "v1",
      },
      {
        type: "workspace-git-badges/read",
        workspaceId,
        paths: ["src/index.ts"],
      },
      {
        type: "lsp-diagnostics/read",
        workspaceId,
        language: "typescript",
        path: "src/index.ts",
      },
      {
        type: "lsp-status/read",
        workspaceId,
        languages: ["typescript", "python", "go"],
      },
      {
        type: "lsp-completion/complete",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        position: {
          line: 0,
          character: 13,
        },
        triggerKind: "invoked",
      },
      {
        type: "lsp-hover/read",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        position: {
          line: 0,
          character: 13,
        },
      },
      {
        type: "lsp-definition/read",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        position: {
          line: 0,
          character: 13,
        },
      },
      {
        type: "lsp-references/read",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        position: {
          line: 0,
          character: 13,
        },
        includeDeclaration: true,
      },
      {
        type: "lsp-document-symbols/read",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
      },
      {
        type: "lsp-rename/prepare",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        position: {
          line: 0,
          character: 13,
        },
      },
      {
        type: "lsp-rename/rename",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        position: {
          line: 0,
          character: 13,
        },
        newName: "nextValue",
      },
      {
        type: "lsp-formatting/document",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        options: {
          tabSize: 2,
          insertSpaces: true,
        },
      },
      {
        type: "lsp-formatting/range",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 23 },
        },
        options: {
          tabSize: 2,
          insertSpaces: true,
        },
      },
      {
        type: "lsp-signature-help/get",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        position: {
          line: 0,
          character: 13,
        },
        triggerKind: "trigger-character",
        triggerCharacter: "(",
      },
      {
        type: "lsp-code-action/list",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 23 },
        },
        diagnostics: [diagnostic],
        only: "quickfix",
      },
      {
        type: "lsp-document/open",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        content: "export const value = missing;\n",
        version: 1,
      },
      {
        type: "lsp-document/change",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        content: "export const value = 1;\n",
        version: 2,
      },
      {
        type: "lsp-document/close",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
      },
    ];

    expect(requests.map(visitRequest)).toEqual([
      "workspace-files/tree/read",
      "workspace-files/file/create",
      "workspace-files/file/delete",
      "workspace-files/file/rename",
      "workspace-files/file/read",
      "workspace-files/file/write",
      "workspace-git-badges/read",
      "lsp-diagnostics/read",
      "lsp-status/read",
      "lsp-completion/complete",
      "lsp-hover/read",
      "lsp-definition/read",
      "lsp-references/read",
      "lsp-document-symbols/read",
      "lsp-rename/prepare",
      "lsp-rename/rename",
      "lsp-formatting/document",
      "lsp-formatting/range",
      "lsp-signature-help/get",
      "lsp-code-action/list",
      "lsp-document/open",
      "lsp-document/change",
      "lsp-document/close",
    ]);
  });

  test("accepts representative valid result payload shapes", () => {
    const fileReadResult: EditorBridgeResultFor<WorkspaceFileReadRequest> = {
      type: "workspace-files/file/read/result",
      workspaceId,
      path: "src/index.ts",
      content: "export const value = 1;\n",
      encoding: "utf8",
      version: "v2",
      readAt: now,
    };
    const lspLanguages: LspLanguage[] = ["typescript", "python", "go"];

    const results: EditorBridgeResult[] = [
      {
        type: "workspace-files/tree/read/result",
        workspaceId,
        rootPath: "",
        readAt: now,
        nodes: [
          {
            name: "src",
            path: "src",
            kind: "directory",
            gitBadge: "modified",
            children: [
              {
                name: "index.ts",
                path: "src/index.ts",
                kind: "file",
                sizeBytes: 128,
                modifiedAt: now,
                gitBadge: "modified",
              },
            ],
          },
        ],
      },
      {
        type: "workspace-files/file/create/result",
        workspaceId,
        path: "src/new-file.ts",
        kind: "file",
        createdAt: now,
      },
      {
        type: "workspace-files/file/delete/result",
        workspaceId,
        path: "src/old-file.ts",
        deletedAt: now,
      },
      {
        type: "workspace-files/file/rename/result",
        workspaceId,
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
        renamedAt: now,
      },
      fileReadResult,
      {
        type: "workspace-files/file/write/result",
        workspaceId,
        path: "src/index.ts",
        encoding: "utf8",
        version: "v3",
        writtenAt: now,
      },
      {
        type: "workspace-git-badges/read/result",
        workspaceId,
        readAt: now,
        badges: [
          {
            path: "src/index.ts",
            status: "modified",
          },
          {
            path: "src/new-file.ts",
            status: "untracked",
          },
        ],
      },
      {
        type: "lsp-diagnostics/read/result",
        workspaceId,
        diagnostics: [diagnostic],
        readAt: now,
      },
      {
        type: "lsp-status/read/result",
        workspaceId,
        readAt: now,
        statuses: lspLanguages.map((language) => ({
          language,
          state: language === "python" ? "unavailable" : "ready",
          serverName:
            language === "typescript"
              ? "tsserver"
              : language === "go"
                ? "gopls"
                : null,
          updatedAt: now,
        })),
      },
      {
        type: "lsp-completion/complete/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        isIncomplete: false,
        items: [
          {
            label: "console",
            kind: "variable",
            insertText: "console",
            insertTextFormat: "plain-text",
            additionalTextEdits: [],
          },
        ],
        completedAt: now,
      },
      {
        type: "lsp-hover/read/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        contents: [
          {
            kind: "markdown",
            value: "**value**: number",
          },
        ],
        range: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 18 },
        },
        readAt: now,
      },
      {
        type: "lsp-definition/read/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        targets: [
          {
            type: "location",
            uri: "file:///workspace/src/value.ts",
            path: "src/value.ts",
            range: {
              start: { line: 2, character: 0 },
              end: { line: 2, character: 12 },
            },
          },
          {
            type: "location-link",
            targetUri: "file:///workspace/src/value.ts",
            targetPath: "src/value.ts",
            targetRange: {
              start: { line: 2, character: 0 },
              end: { line: 5, character: 1 },
            },
            targetSelectionRange: {
              start: { line: 2, character: 13 },
              end: { line: 2, character: 18 },
            },
            originSelectionRange: {
              start: { line: 0, character: 13 },
              end: { line: 0, character: 18 },
            },
          },
        ],
        readAt: now,
      },
      {
        type: "lsp-references/read/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        locations: [
          {
            uri: "file:///workspace/src/index.ts",
            path: "src/index.ts",
            range: {
              start: { line: 0, character: 13 },
              end: { line: 0, character: 18 },
            },
          },
        ],
        readAt: now,
      },
      {
        type: "lsp-document-symbols/read/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        symbols: [
          {
            type: "document-symbol",
            name: "value",
            detail: "const",
            kind: "constant",
            tags: [],
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 23 },
            },
            selectionRange: {
              start: { line: 0, character: 13 },
              end: { line: 0, character: 18 },
            },
            children: [],
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
              range: {
                start: { line: 2, character: 0 },
                end: { line: 4, character: 1 },
              },
            },
          },
        ],
        readAt: now,
      },
      {
        type: "lsp-rename/prepare/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        canRename: true,
        range: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 18 },
        },
        placeholder: "value",
        defaultBehavior: false,
        preparedAt: now,
      },
      {
        type: "lsp-rename/rename/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        workspaceEdit: {
          changes: [
            {
              path: "src/index.ts",
              edits: [
                {
                  range: {
                    start: { line: 0, character: 13 },
                    end: { line: 0, character: 18 },
                  },
                  newText: "nextValue",
                },
              ],
            },
          ],
        },
        renamedAt: now,
      },
      {
        type: "lsp-formatting/document/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        edits: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 23 },
            },
            newText: "export const value = 1;\n",
          },
        ],
        formattedAt: now,
      },
      {
        type: "lsp-formatting/range/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        edits: [],
        formattedAt: now,
      },
      {
        type: "lsp-signature-help/get/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        signatureHelp: {
          signatures: [
            {
              label: "fn(value: string): void",
              documentation: "Calls fn.",
              parameters: [
                {
                  label: "value",
                  documentation: "Input value.",
                },
              ],
              activeParameter: 0,
            },
          ],
          activeSignature: 0,
          activeParameter: 0,
        },
        resolvedAt: now,
      },
      {
        type: "lsp-code-action/list/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        actions: [
          {
            title: "Add import",
            kind: "quickfix",
            diagnostics: [diagnostic],
            edit: {
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
            command: null,
            isPreferred: true,
          },
        ],
        listedAt: now,
      },
      {
        type: "lsp-document/open/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        status: {
          language: "typescript",
          state: "ready",
          serverName: "typescript-language-server",
          updatedAt: now,
        },
        openedAt: now,
      },
      {
        type: "lsp-document/change/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        status: {
          language: "typescript",
          state: "ready",
          serverName: "typescript-language-server",
          updatedAt: now,
        },
        changedAt: now,
      },
      {
        type: "lsp-document/close/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        closedAt: now,
      },
    ];

    expect(results.map(visitResult)).toEqual([
      "workspace-files/tree/read/result",
      "workspace-files/file/create/result",
      "workspace-files/file/delete/result",
      "workspace-files/file/rename/result",
      "workspace-files/file/read/result",
      "workspace-files/file/write/result",
      "workspace-git-badges/read/result",
      "lsp-diagnostics/read/result",
      "lsp-status/read/result",
      "lsp-completion/complete/result",
      "lsp-hover/read/result",
      "lsp-definition/read/result",
      "lsp-references/read/result",
      "lsp-document-symbols/read/result",
      "lsp-rename/prepare/result",
      "lsp-rename/rename/result",
      "lsp-formatting/document/result",
      "lsp-formatting/range/result",
      "lsp-signature-help/get/result",
      "lsp-code-action/list/result",
      "lsp-document/open/result",
      "lsp-document/change/result",
      "lsp-document/close/result",
    ]);
    expect(fileReadResult.encoding).toBe("utf8");
  });

  test("accepts representative valid event payload shapes", () => {
    const events: EditorBridgeEvent[] = [
      {
        type: "workspace-files/watch",
        workspaceId,
        path: "src/new-name.ts",
        oldPath: "src/old-name.ts",
        kind: "file",
        change: "renamed",
        occurredAt: now,
      },
      {
        type: "workspace-git-badges/changed",
        workspaceId,
        badges: [
          {
            path: "src/index.ts",
            status: "staged",
          },
        ],
        changedAt: now,
      },
      {
        type: "lsp-diagnostics/changed",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        diagnostics: [diagnostic],
        version: "v3",
        publishedAt: now,
      },
      {
        type: "lsp-status/changed",
        workspaceId,
        status: {
          language: "go",
          state: "ready",
          serverName: "gopls",
          updatedAt: now,
        },
      },
    ];

    expect(events.map(visitEvent)).toEqual([
      "workspace-files/watch",
      "workspace-git-badges/changed",
      "lsp-diagnostics/changed",
      "lsp-status/changed",
    ]);
  });
});
