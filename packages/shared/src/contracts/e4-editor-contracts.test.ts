import { describe, expect, test } from "bun:test";

import {
  E4_EDITOR_EVENT_CHANNEL,
  E4_EDITOR_INVOKE_CHANNEL,
} from "./ipc-channels";
import type {
  E4Diagnostic,
  E4EditorEvent,
  E4EditorRequest,
  E4EditorResult,
  E4EditorResultFor,
  E4FileReadRequest,
  E4LspLanguage,
} from "./e4-editor";
import type { WorkspaceId } from "./workspace";

function assertNever(value: never): never {
  throw new Error(`Unhandled E4 contract variant: ${JSON.stringify(value)}`);
}

function visitRequest(request: E4EditorRequest): E4EditorRequest["type"] {
  switch (request.type) {
    case "e4/file-tree/read":
    case "e4/file/create":
    case "e4/file/delete":
    case "e4/file/rename":
    case "e4/file/read":
    case "e4/file/write":
    case "e4/git-badges/read":
    case "e4/lsp-diagnostics/read":
    case "e4/lsp-status/read":
    case "e4/lsp-document/open":
    case "e4/lsp-document/change":
    case "e4/lsp-document/close":
      return request.type;
    default:
      return assertNever(request);
  }
}

function visitResult(result: E4EditorResult): E4EditorResult["type"] {
  switch (result.type) {
    case "e4/file-tree/read/result":
    case "e4/file/create/result":
    case "e4/file/delete/result":
    case "e4/file/rename/result":
    case "e4/file/read/result":
    case "e4/file/write/result":
    case "e4/git-badges/read/result":
    case "e4/lsp-diagnostics/read/result":
    case "e4/lsp-status/read/result":
    case "e4/lsp-document/open/result":
    case "e4/lsp-document/change/result":
    case "e4/lsp-document/close/result":
      return result.type;
    default:
      return assertNever(result);
  }
}

function visitEvent(event: E4EditorEvent): E4EditorEvent["type"] {
  switch (event.type) {
    case "e4/file/watch":
    case "e4/git-badges/changed":
    case "e4/lsp-diagnostics/changed":
    case "e4/lsp-status/changed":
      return event.type;
    default:
      return assertNever(event);
  }
}

const workspaceId = "ws_e4_alpha" as WorkspaceId;
const now = "2026-04-27T00:00:00.000Z";

const diagnostic: E4Diagnostic = {
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

describe("E4 editor shared contracts", () => {
  test("declares IPC channels for editor invoke and event traffic", () => {
    expect(E4_EDITOR_INVOKE_CHANNEL).toBe("e4-editor:invoke");
    expect(E4_EDITOR_EVENT_CHANNEL).toBe("e4-editor:event");
  });

  test("accepts representative valid request payload shapes", () => {
    const requests: E4EditorRequest[] = [
      {
        type: "e4/file-tree/read",
        workspaceId,
        rootPath: "src",
      },
      {
        type: "e4/file/create",
        workspaceId,
        path: "src/new-file.ts",
        kind: "file",
        content: "export {};",
      },
      {
        type: "e4/file/delete",
        workspaceId,
        path: "src/old-file.ts",
      },
      {
        type: "e4/file/rename",
        workspaceId,
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
      {
        type: "e4/file/read",
        workspaceId,
        path: "src/index.ts",
      },
      {
        type: "e4/file/write",
        workspaceId,
        path: "src/index.ts",
        content: "export const value = 1;\n",
        expectedVersion: "v1",
      },
      {
        type: "e4/git-badges/read",
        workspaceId,
        paths: ["src/index.ts"],
      },
      {
        type: "e4/lsp-diagnostics/read",
        workspaceId,
        language: "typescript",
        path: "src/index.ts",
      },
      {
        type: "e4/lsp-status/read",
        workspaceId,
        languages: ["typescript", "python", "go"],
      },
      {
        type: "e4/lsp-document/open",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        content: "export const value = missing;\n",
        version: 1,
      },
      {
        type: "e4/lsp-document/change",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        content: "export const value = 1;\n",
        version: 2,
      },
      {
        type: "e4/lsp-document/close",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
      },
    ];

    expect(requests.map(visitRequest)).toEqual([
      "e4/file-tree/read",
      "e4/file/create",
      "e4/file/delete",
      "e4/file/rename",
      "e4/file/read",
      "e4/file/write",
      "e4/git-badges/read",
      "e4/lsp-diagnostics/read",
      "e4/lsp-status/read",
      "e4/lsp-document/open",
      "e4/lsp-document/change",
      "e4/lsp-document/close",
    ]);
  });

  test("accepts representative valid result payload shapes", () => {
    const fileReadResult: E4EditorResultFor<E4FileReadRequest> = {
      type: "e4/file/read/result",
      workspaceId,
      path: "src/index.ts",
      content: "export const value = 1;\n",
      encoding: "utf8",
      version: "v2",
      readAt: now,
    };
    const lspLanguages: E4LspLanguage[] = ["typescript", "python", "go"];

    const results: E4EditorResult[] = [
      {
        type: "e4/file-tree/read/result",
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
        type: "e4/file/create/result",
        workspaceId,
        path: "src/new-file.ts",
        kind: "file",
        createdAt: now,
      },
      {
        type: "e4/file/delete/result",
        workspaceId,
        path: "src/old-file.ts",
        deletedAt: now,
      },
      {
        type: "e4/file/rename/result",
        workspaceId,
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
        renamedAt: now,
      },
      fileReadResult,
      {
        type: "e4/file/write/result",
        workspaceId,
        path: "src/index.ts",
        encoding: "utf8",
        version: "v3",
        writtenAt: now,
      },
      {
        type: "e4/git-badges/read/result",
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
        type: "e4/lsp-diagnostics/read/result",
        workspaceId,
        diagnostics: [diagnostic],
        readAt: now,
      },
      {
        type: "e4/lsp-status/read/result",
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
        type: "e4/lsp-document/open/result",
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
        type: "e4/lsp-document/change/result",
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
        type: "e4/lsp-document/close/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        closedAt: now,
      },
    ];

    expect(results.map(visitResult)).toEqual([
      "e4/file-tree/read/result",
      "e4/file/create/result",
      "e4/file/delete/result",
      "e4/file/rename/result",
      "e4/file/read/result",
      "e4/file/write/result",
      "e4/git-badges/read/result",
      "e4/lsp-diagnostics/read/result",
      "e4/lsp-status/read/result",
      "e4/lsp-document/open/result",
      "e4/lsp-document/change/result",
      "e4/lsp-document/close/result",
    ]);
    expect(fileReadResult.encoding).toBe("utf8");
  });

  test("accepts representative valid event payload shapes", () => {
    const events: E4EditorEvent[] = [
      {
        type: "e4/file/watch",
        workspaceId,
        path: "src/new-name.ts",
        oldPath: "src/old-name.ts",
        kind: "file",
        change: "renamed",
        occurredAt: now,
      },
      {
        type: "e4/git-badges/changed",
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
        type: "e4/lsp-diagnostics/changed",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        diagnostics: [diagnostic],
        version: "v3",
        publishedAt: now,
      },
      {
        type: "e4/lsp-status/changed",
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
      "e4/file/watch",
      "e4/git-badges/changed",
      "e4/lsp-diagnostics/changed",
      "e4/lsp-status/changed",
    ]);
  });
});
