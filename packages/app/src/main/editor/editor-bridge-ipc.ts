import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import {
  EDITOR_BRIDGE_EVENT_CHANNEL,
  EDITOR_BRIDGE_INVOKE_CHANNEL,
} from "../../../../shared/src/contracts/ipc-channels";
import type {
  EditorBridgeEvent,
  EditorBridgeRequest,
  EditorBridgeResult,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceFilesService } from "../workspace/files/workspace-files-service";
import type { LspService } from "../lsp/lsp-service";

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;

type EditorBridgeWorkspaceFilesService = Pick<
  WorkspaceFilesService,
  | "readFileTree"
  | "createFile"
  | "deleteFile"
  | "renameFile"
  | "readFile"
  | "writeFile"
  | "readGitBadges"
  | "onEvent"
>;

type EditorBridgeLspService = Pick<
  LspService,
  | "readDiagnostics"
  | "readStatus"
  | "complete"
  | "hover"
  | "definition"
  | "references"
  | "documentSymbols"
  | "prepareRename"
  | "renameSymbol"
  | "formatDocument"
  | "formatRange"
  | "getSignatureHelp"
  | "codeActions"
  | "openDocument"
  | "changeDocument"
  | "closeDocument"
  | "onEvent"
>;

export interface EditorBridgeIpcHandlersOptions {
  ipcMain: IpcMainLike;
  mainWindow: BrowserWindow;
  editorService: EditorBridgeWorkspaceFilesService;
  lspService: EditorBridgeLspService;
}

export interface EditorBridgeIpcHandlers {
  dispose(): void;
}

export function registerEditorBridgeIpcHandlers(
  options: EditorBridgeIpcHandlersOptions,
): EditorBridgeIpcHandlers {
  const eventSubscriptions = [
    options.editorService.onEvent((event) => {
      emitEditorBridgeEvent(options.mainWindow, event);
    }),
    options.lspService.onEvent((event) => {
      emitEditorBridgeEvent(options.mainWindow, event);
    }),
  ];

  options.ipcMain.handle(
    EDITOR_BRIDGE_INVOKE_CHANNEL,
    (_event: IpcMainInvokeEvent, request: EditorBridgeRequest): Promise<EditorBridgeResult> => {
      return invokeEditorBridgeRequest(options.editorService, options.lspService, request);
    },
  );

  return {
    dispose() {
      for (const subscription of eventSubscriptions) {
        subscription.dispose();
      }
      options.ipcMain.removeHandler(EDITOR_BRIDGE_INVOKE_CHANNEL);
    },
  };
}

export async function invokeEditorBridgeRequest(
  editorService: EditorBridgeWorkspaceFilesService,
  lspService: EditorBridgeLspService,
  request: EditorBridgeRequest,
): Promise<EditorBridgeResult> {
  switch (request.type) {
    case "workspace-files/tree/read":
      return editorService.readFileTree(request);
    case "workspace-files/file/create":
      return editorService.createFile(request);
    case "workspace-files/file/delete":
      return editorService.deleteFile(request);
    case "workspace-files/file/rename":
      return editorService.renameFile(request);
    case "workspace-files/file/read":
      return editorService.readFile(request);
    case "workspace-files/file/write":
      return editorService.writeFile(request);
    case "workspace-git-badges/read":
      return editorService.readGitBadges(request);
    case "lsp-diagnostics/read":
      return lspService.readDiagnostics(request);
    case "lsp-status/read":
      return lspService.readStatus(request);
    case "lsp-completion/complete":
      return lspService.complete(request);
    case "lsp-hover/read":
      return lspService.hover(request);
    case "lsp-definition/read":
      return lspService.definition(request);
    case "lsp-references/read":
      return lspService.references(request);
    case "lsp-document-symbols/read":
      return lspService.documentSymbols(request);
    case "lsp-rename/prepare":
      return lspService.prepareRename(request);
    case "lsp-rename/rename":
      return lspService.renameSymbol(request);
    case "lsp-formatting/document":
      return lspService.formatDocument(request);
    case "lsp-formatting/range":
      return lspService.formatRange(request);
    case "lsp-signature-help/get":
      return lspService.getSignatureHelp(request);
    case "lsp-code-action/list":
      return lspService.codeActions(request);
    case "lsp-document/open":
      return lspService.openDocument(request);
    case "lsp-document/change":
      return lspService.changeDocument(request);
    case "lsp-document/close":
      return lspService.closeDocument(request);
  }
}

export function emitEditorBridgeEvent(
  mainWindow: BrowserWindow,
  event: EditorBridgeEvent,
): void {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(EDITOR_BRIDGE_EVENT_CHANNEL, event);
}
