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
