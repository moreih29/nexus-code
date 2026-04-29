import { describe, expect, test } from "bun:test";

import type {
  EditorBridgeRequest,
  LspDiagnostic,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { createEditorDocumentsService } from "./editor-documents-service";
import {
  diffTabIdFor,
  tabIdFor,
  type EditorBridge,
} from "./editor-types";

const workspaceId = "ws_docs" as WorkspaceId;
const otherWorkspaceId = "ws_other" as WorkspaceId;
const indexPath = "src/index.ts";
const closedPath = "src/closed.ts";

const diagnostic: LspDiagnostic = {
  path: indexPath,
  language: "typescript",
  range: createRange(),
  severity: "warning",
  message: "Check this symbol.",
};

describe("IEditorDocumentsService", () => {
  test("opens documents, reads and edits content, marks dirty, saves, and closes", async () => {
    const calls: EditorBridgeRequest[] = [];
    const store = createEditorDocumentsService(createFakeBridge(calls, {
      fileContents: {
        [indexPath]: "const value = 1;\n",
      },
    }));

    const document = await store.getState().openDocument(workspaceId, indexPath);

    expect(document).toMatchObject({
      kind: "file",
      id: tabIdFor(workspaceId, indexPath),
      title: "index.ts",
      content: "const value = 1;\n",
      dirty: false,
      language: "typescript",
      monacoLanguage: "typescript",
    });
    expect(store.getState().activeDocumentId).toBe(document.id);
    expect(store.getState().getContent(document.id)).toBe("const value = 1;\n");

    store.getState().setContent(document.id, "const value = 2;\n");
    expect(store.getState().documentsById[document.id]).toMatchObject({
      content: "const value = 2;\n",
      dirty: true,
      lspDocumentVersion: 2,
    });

    store.getState().markDirty(document.id, false);
    expect(store.getState().documentsById[document.id]?.dirty).toBe(false);
    store.getState().markDirty(document.id);
    expect(store.getState().documentsById[document.id]?.dirty).toBe(true);

    await store.getState().saveDocument(document.id);

    expect(store.getState().documentsById[document.id]).toMatchObject({
      content: "const value = 2;\n",
      savedContent: "const value = 2;\n",
      dirty: false,
      saving: false,
      version: "v2",
      errorMessage: null,
    });
    expect(calls.find((call) => call.type === "workspace-files/file/write")).toMatchObject({
      type: "workspace-files/file/write",
      workspaceId,
      path: indexPath,
      content: "const value = 2;\n",
      expectedVersion: "v1",
    });

    await store.getState().closeDocument(document.id);

    expect(store.getState().documentsById[document.id]).toBeUndefined();
    expect(store.getState().activeDocumentId).toBeNull();
    expect(calls.map((call) => call.type)).toEqual([
      "workspace-files/file/read",
      "lsp-document/open",
      "lsp-diagnostics/read",
      "workspace-files/file/write",
      "lsp-document/close",
    ]);
  });

  test("updates document content through the LSP change lifecycle", async () => {
    const calls: EditorBridgeRequest[] = [];
    const store = createEditorDocumentsService(createFakeBridge(calls, {
      fileContents: {
        [indexPath]: "const value = 1;\n",
      },
    }));

    const document = await store.getState().openDocument(workspaceId, indexPath);
    await store.getState().updateDocumentContent(document.id, "const value = 3;\n");

    expect(store.getState().documentsById[document.id]).toMatchObject({
      content: "const value = 3;\n",
      dirty: true,
      lspDocumentVersion: 2,
      errorMessage: null,
    });
    expect(calls.find((call) => call.type === "lsp-document/change")).toMatchObject({
      workspaceId,
      path: indexPath,
      content: "const value = 3;\n",
      version: 2,
    });
  });

  test("accepts diagnostics pushed across the ILspService boundary and exposes them by document", async () => {
    const calls: EditorBridgeRequest[] = [];
    const store = createEditorDocumentsService(createFakeBridge(calls));

    store.getState().setDiagnostics(workspaceId, indexPath, [diagnostic]);
    expect(store.getState().getDiagnostics(workspaceId, indexPath)).toEqual([diagnostic]);

    const document = await store.getState().openDocument(workspaceId, indexPath);
    expect(store.getState().documentsById[document.id]?.diagnostics).toEqual([diagnostic]);

    store.getState().setDiagnostics(workspaceId, indexPath, []);
    expect(store.getState().getDiagnostics(workspaceId, indexPath)).toEqual([]);
    expect(store.getState().documentsById[document.id]?.diagnostics).toEqual([]);

    await store.getState().closeDocument(document.id);
    expect(store.getState().getDiagnostics(workspaceId, indexPath)).toEqual([]);
  });

  test("opens read-only diff documents without editing or saving them", async () => {
    const calls: EditorBridgeRequest[] = [];
    const store = createEditorDocumentsService(createFakeBridge(calls, {
      fileContents: {
        "README.md": "# right\n",
      },
    }));

    const document = await store.getState().openDiff(
      {
        workspaceId: otherWorkspaceId,
        path: "src/left.ts",
        title: "left.ts",
        content: "const left = 1;\n",
      },
      { workspaceId, path: "README.md" },
      { source: "compare" },
    );
    const beforeMutation = store.getState().documentsById[document.id];

    expect(document).toMatchObject({
      kind: "diff",
      title: "left.ts ↔ README.md",
      dirty: false,
      readOnly: true,
      diff: {
        source: "compare",
        left: {
          workspaceId: otherWorkspaceId,
          path: "src/left.ts",
          content: "const left = 1;\n",
          monacoLanguage: "typescript",
        },
        right: {
          workspaceId,
          path: "README.md",
          content: "# right\n",
          monacoLanguage: "markdown",
        },
      },
    });
    expect(document.id).toBe(diffTabIdFor(workspaceId, document.diff!.left, document.diff!.right, "compare"));

    store.getState().setContent(document.id, "ignored");
    store.getState().markDirty(document.id);
    await store.getState().saveDocument(document.id);

    expect(store.getState().documentsById[document.id]).toEqual(beforeMutation);
    expect(calls.map((call) => call.type)).toEqual(["workspace-files/file/read"]);
  });

  test("applies WorkspaceEdit changes to open and closed documents without writing to disk", async () => {
    const calls: EditorBridgeRequest[] = [];
    const store = createEditorDocumentsService(createFakeBridge(calls, {
      fileContents: {
        [indexPath]: "const value = missing;\n",
        [closedPath]: "const value = missing;\n",
      },
    }));
    const openDocument = await store.getState().openDocument(workspaceId, indexPath);
    const activeDocumentId = store.getState().activeDocumentId;

    const result = await store.getState().applyWorkspaceEdit(workspaceId, {
      changes: [
        {
          path: indexPath,
          edits: [replaceMissingWith("openValue")],
        },
        {
          path: closedPath,
          edits: [replaceMissingWith("closedValue")],
        },
      ],
    });

    expect(result).toEqual({
      applied: true,
      appliedPaths: [indexPath, closedPath],
      skippedClosedPaths: [],
      skippedReadFailures: [],
      skippedUnsupportedPaths: [],
    });
    expect(store.getState().activeDocumentId).toBe(activeDocumentId);
    expect(store.getState().getContent(openDocument.id)).toBe("const value = openValue;\n");
    expect(store.getState().documentsById[openDocument.id]).toMatchObject({
      dirty: true,
      savedContent: "const value = missing;\n",
      lspDocumentVersion: 2,
    });
    expect(store.getState().documentsById[tabIdFor(workspaceId, closedPath)]).toMatchObject({
      content: "const value = closedValue;\n",
      savedContent: "const value = missing;\n",
      dirty: true,
      lspDocumentVersion: 2,
    });
    expect(calls.map((call) => call.type)).not.toContain("workspace-files/file/write");
  });

  test("reports WorkspaceEdit read failures and unsupported text edits", async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const calls: EditorBridgeRequest[] = [];
      const store = createEditorDocumentsService(createFakeBridge(calls, {
        readFailures: new Set(["src/missing.ts"]),
      }));
      await store.getState().openDocument(workspaceId, indexPath);

      const result = await store.getState().applyWorkspaceEdit(workspaceId, {
        changes: [
          {
            path: "src/missing.ts",
            edits: [replaceMissingWith("missingValue")],
          },
          {
            path: indexPath,
            edits: overlappingEdits(),
          },
        ],
      });

      expect(result).toEqual({
        applied: false,
        appliedPaths: [],
        skippedClosedPaths: [],
        skippedReadFailures: ["src/missing.ts"],
        skippedUnsupportedPaths: [indexPath],
      });
      expect(store.getState().documentsById[tabIdFor(workspaceId, "src/missing.ts")]).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[0])).toContain("failed to read closed file");
    } finally {
      console.warn = originalWarn;
    }
  });
});

interface FakeBridgeOptions {
  fileContents?: Record<string, string>;
  readFailures?: ReadonlySet<string>;
  writeFailures?: ReadonlySet<string>;
}

function createFakeBridge(calls: EditorBridgeRequest[], options: FakeBridgeOptions = {}): EditorBridge {
  return {
    async invoke(request) {
      calls.push(request);
      switch (request.type) {
        case "workspace-files/file/read":
          if (options.readFailures?.has(request.path)) {
            throw new Error(`Unable to read ${request.path}.`);
          }
          return {
            type: "workspace-files/file/read/result",
            workspaceId: request.workspaceId,
            path: request.path,
            content: options.fileContents?.[request.path] ?? "const value = missing;\n",
            encoding: "utf8",
            version: "v1",
            readAt: "2026-04-29T00:00:00.000Z",
          } as never;
        case "workspace-files/file/write":
          if (options.writeFailures?.has(request.path)) {
            throw new Error(`Unable to write ${request.path}.`);
          }
          return {
            type: "workspace-files/file/write/result",
            workspaceId: request.workspaceId,
            path: request.path,
            encoding: "utf8",
            version: "v2",
            writtenAt: "2026-04-29T00:00:00.000Z",
          } as never;
        case "lsp-document/open":
          return {
            type: "lsp-document/open/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            status: {
              language: request.language,
              state: "ready",
              serverName: `${request.language}-server`,
              message: null,
              updatedAt: "2026-04-29T00:00:00.000Z",
            },
            openedAt: "2026-04-29T00:00:00.000Z",
          } as never;
        case "lsp-document/change":
          return {
            type: "lsp-document/change/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            status: {
              language: request.language,
              state: "ready",
              serverName: `${request.language}-server`,
              message: null,
              updatedAt: "2026-04-29T00:00:00.000Z",
            },
            changedAt: "2026-04-29T00:00:00.000Z",
          } as never;
        case "lsp-document/close":
          return {
            type: "lsp-document/close/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            closedAt: "2026-04-29T00:00:00.000Z",
          } as never;
        case "lsp-diagnostics/read":
          return {
            type: "lsp-diagnostics/read/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            diagnostics: request.path === indexPath ? [diagnostic] : [],
            readAt: "2026-04-29T00:00:00.000Z",
          } as never;
        default:
          throw new Error(`Unexpected request ${(request as EditorBridgeRequest).type}.`);
      }
    },
  };
}

function replaceMissingWith(newText: string) {
  return {
    range: {
      start: { line: 0, character: 14 },
      end: { line: 0, character: 21 },
    },
    newText,
  };
}

function overlappingEdits() {
  return [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      newText: "let",
    },
    {
      range: {
        start: { line: 0, character: 3 },
        end: { line: 0, character: 8 },
      },
      newText: "overlap",
    },
  ];
}

function createRange() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
  };
}
