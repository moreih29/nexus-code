import { describe, expect, test } from "bun:test";

import type {
  LspCompletionItem,
  LspDiagnostic,
  LspDocumentSymbolItem,
  LspStatus,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { createLspService, type LspCompletionProviderRequest } from "./lsp-service";

const workspaceId = "ws_lsp" as WorkspaceId;
const path = "src/index.ts";
const otherPath = "src/other.ts";

const diagnostic: LspDiagnostic = {
  path,
  language: "typescript",
  range: createRange(),
  severity: "warning",
  message: "Check this symbol.",
};

const otherDiagnostic: LspDiagnostic = {
  path: otherPath,
  language: "typescript",
  range: createRange(),
  severity: "error",
  message: "Other symbol failed.",
};

const completionItem: LspCompletionItem = {
  label: "console",
  kind: "variable",
  insertText: "console",
  insertTextFormat: "plain-text",
  additionalTextEdits: [],
};

const symbolItem: LspDocumentSymbolItem = {
  type: "document-symbol",
  name: "main",
  detail: "entrypoint",
  kind: "function",
  tags: [],
  range: createRange(),
  selectionRange: createRange(),
  children: [],
};

const readyStatus: LspStatus = {
  language: "typescript",
  state: "ready",
  serverName: "typescript-language-server",
  message: "ready",
  updatedAt: "2026-04-28T00:00:00.000Z",
};

const pythonStatus: LspStatus = {
  language: "python",
  state: "starting",
  serverName: "pyright",
  message: "starting",
  updatedAt: "2026-04-28T00:00:01.000Z",
};

describe("lsp-service", () => {
  test("manages diagnostics by setter, read result, event, getter, and clear", () => {
    const store = createLspService();

    store.getState().setDiagnostics(workspaceId, path, [diagnostic]);
    expect(store.getState().getDiagnostics(workspaceId, path)).toEqual([diagnostic]);

    store.getState().applyDiagnosticsResult({
      type: "lsp-diagnostics/read/result",
      workspaceId,
      diagnostics: [diagnostic, otherDiagnostic],
      readAt: "2026-04-28T00:00:00.000Z",
    });
    expect(store.getState().getDiagnostics(workspaceId, otherPath)).toEqual([otherDiagnostic]);
    expect(store.getState().diagnosticsReadAtByDocument[`${workspaceId}:${path}`]).toBe(
      "2026-04-28T00:00:00.000Z",
    );

    store.getState().applyDiagnosticsEvent({
      type: "lsp-diagnostics/changed",
      workspaceId,
      path,
      language: "typescript",
      diagnostics: [],
      version: "2",
      publishedAt: "2026-04-28T00:00:01.000Z",
    });
    expect(store.getState().getDiagnostics(workspaceId, path)).toEqual([]);
    expect(store.getState().diagnosticsReadAtByDocument[`${workspaceId}:${path}`]).toBe(
      "2026-04-28T00:00:01.000Z",
    );

    store.getState().clearDiagnostics(workspaceId, path);
    expect(store.getState().diagnosticsByDocument[`${workspaceId}:${path}`]).toBeUndefined();
    expect(store.getState().diagnosticsReadAtByDocument[`${workspaceId}:${path}`]).toBeUndefined();
  });

  test("manages completion and document symbols from setters and provider result adapters", () => {
    const store = createLspService();
    const request: LspCompletionProviderRequest = {
      type: "lsp-completion/complete",
      workspaceId,
      path,
      language: "typescript",
      position: { line: 0, character: 0 },
      triggerKind: "invoked",
      triggerCharacter: null,
    };
    expect(request.type).toBe("lsp-completion/complete");

    store.getState().setCompletionItems(workspaceId, path, [completionItem]);
    expect(store.getState().getCompletionItems(workspaceId, path)).toEqual([completionItem]);
    expect(store.getState().getCompletionState(workspaceId, path)).toEqual({
      items: [completionItem],
      isIncomplete: false,
      completedAt: null,
    });

    store.getState().applyCompletionResult({
      type: "lsp-completion/complete/result",
      workspaceId,
      path,
      language: "typescript",
      isIncomplete: true,
      items: [],
      completedAt: "2026-04-28T00:00:00.000Z",
    });
    expect(store.getState().getCompletionItems(workspaceId, path)).toEqual([]);
    expect(store.getState().getCompletionState(workspaceId, path)).toEqual({
      items: [],
      isIncomplete: true,
      completedAt: "2026-04-28T00:00:00.000Z",
    });

    store.getState().setSymbols(workspaceId, path, [symbolItem]);
    expect(store.getState().getSymbols(workspaceId, path)).toEqual([symbolItem]);

    store.getState().applySymbolsResult({
      type: "lsp-document-symbols/read/result",
      workspaceId,
      path,
      language: "typescript",
      symbols: [],
      readAt: "2026-04-28T00:00:01.000Z",
    });
    expect(store.getState().getSymbols(workspaceId, path)).toEqual([]);
    expect(store.getState().symbolsReadAtByDocument[`${workspaceId}:${path}`]).toBe(
      "2026-04-28T00:00:01.000Z",
    );
  });

  test("manages LSP status by setter, status read result, event, and getter", () => {
    const store = createLspService();

    store.getState().setStatus(readyStatus);
    expect(store.getState().getStatus("typescript")).toEqual(readyStatus);

    store.getState().applyStatusResult({
      type: "lsp-status/read/result",
      workspaceId,
      statuses: [pythonStatus],
      readAt: "2026-04-28T00:00:00.000Z",
    });
    expect(store.getState().getStatus("python")).toEqual(pythonStatus);

    const stoppedStatus: LspStatus = {
      ...readyStatus,
      state: "stopped",
      updatedAt: "2026-04-28T00:00:02.000Z",
    };
    store.getState().applyStatusEvent({
      type: "lsp-status/changed",
      workspaceId,
      status: stoppedStatus,
    });
    expect(store.getState().getStatus("typescript")).toEqual(stoppedStatus);
    expect(store.getState().getStatus("go")).toBeNull();
  });

  test("manages document open/change/close lifecycle and clears document caches", () => {
    const store = createLspService();

    store.getState().openDocument({
      workspaceId,
      path,
      language: "typescript",
      version: 1,
      content: "const value = 1;\n",
      openedAt: "2026-04-28T00:00:00.000Z",
    });
    expect(store.getState().isDocumentOpen(workspaceId, path)).toBe(true);
    expect(store.getState().getOpenDocument(workspaceId, path)).toMatchObject({
      version: 1,
      content: "const value = 1;\n",
    });

    store.getState().setDiagnostics(workspaceId, path, [diagnostic]);
    store.getState().setCompletionItems(workspaceId, path, [completionItem]);
    store.getState().setSymbols(workspaceId, path, [symbolItem]);
    store.getState().changeDocument({
      workspaceId,
      path,
      language: "typescript",
      version: 2,
      content: "const value = 2;\n",
      changedAt: "2026-04-28T00:00:01.000Z",
    });
    expect(store.getState().getOpenDocument(workspaceId, path)).toMatchObject({
      version: 2,
      content: "const value = 2;\n",
      changedAt: "2026-04-28T00:00:01.000Z",
    });
    expect(store.getState().getDiagnostics(workspaceId, path)).toEqual([diagnostic]);

    store.getState().changeDocument({
      workspaceId,
      path,
      language: "python",
      version: 3,
      content: "print('value')\n",
      changedAt: "2026-04-28T00:00:02.000Z",
    });
    expect(store.getState().getOpenDocument(workspaceId, path)).toMatchObject({ language: "python" });
    expect(store.getState().getDiagnostics(workspaceId, path)).toEqual([]);
    expect(store.getState().getCompletionItems(workspaceId, path)).toEqual([]);
    expect(store.getState().getSymbols(workspaceId, path)).toEqual([]);

    store.getState().applyDocumentOpenResult(
      {
        type: "lsp-document/open/result",
        workspaceId,
        path: otherPath,
        language: "typescript",
        status: readyStatus,
        openedAt: "2026-04-28T00:00:03.000Z",
      },
      { version: 1, content: "export {};\n" },
    );
    expect(store.getState().getOpenDocument(workspaceId, otherPath)).toMatchObject({
      version: 1,
      content: "export {};\n",
      openedAt: "2026-04-28T00:00:03.000Z",
    });
    expect(store.getState().getStatus("typescript")).toEqual(readyStatus);

    store.getState().applyDocumentChangeResult(
      {
        type: "lsp-document/change/result",
        workspaceId,
        path: otherPath,
        language: "typescript",
        status: { ...readyStatus, message: "changed" },
        changedAt: "2026-04-28T00:00:04.000Z",
      },
      { version: 2, content: "export const value = 1;\n" },
    );
    expect(store.getState().getOpenDocument(workspaceId, otherPath)).toMatchObject({
      version: 2,
      content: "export const value = 1;\n",
      changedAt: "2026-04-28T00:00:04.000Z",
    });
    expect(store.getState().getStatus("typescript")?.message).toBe("changed");

    store.getState().closeDocument(workspaceId, path);
    expect(store.getState().isDocumentOpen(workspaceId, path)).toBe(false);

    store.getState().setDiagnostics(workspaceId, otherPath, [diagnostic]);
    store.getState().setCompletionItems(workspaceId, otherPath, [completionItem]);
    store.getState().setSymbols(workspaceId, otherPath, [symbolItem]);
    store.getState().applyDocumentCloseResult({
      type: "lsp-document/close/result",
      workspaceId,
      path: otherPath,
      language: "typescript",
      closedAt: "2026-04-28T00:00:05.000Z",
    });
    expect(store.getState().getOpenDocument(workspaceId, otherPath)).toBeNull();
    expect(store.getState().getDiagnostics(workspaceId, otherPath)).toEqual([]);
    expect(store.getState().getCompletionState(workspaceId, otherPath)).toBeNull();
    expect(store.getState().getSymbols(workspaceId, otherPath)).toEqual([]);
  });
});

function createRange() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
  };
}
