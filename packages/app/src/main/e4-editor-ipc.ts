import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import {
  E4_EDITOR_EVENT_CHANNEL,
  E4_EDITOR_INVOKE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type {
  E4EditorEvent,
  E4EditorRequest,
  E4EditorResult,
} from "../../../shared/src/contracts/e4-editor";
import type { E4EditorFileService } from "./e4-editor-file-service";
import type { E4LspService } from "./e4-lsp-service";

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;

type E4EditorService = Pick<
  E4EditorFileService,
  | "readFileTree"
  | "createFile"
  | "deleteFile"
  | "renameFile"
  | "readFile"
  | "writeFile"
  | "readGitBadges"
  | "onEvent"
>;

type E4LspEditorService = Pick<
  E4LspService,
  | "readDiagnostics"
  | "readStatus"
  | "openDocument"
  | "changeDocument"
  | "closeDocument"
  | "onEvent"
>;

export interface E4EditorIpcHandlersOptions {
  ipcMain: IpcMainLike;
  mainWindow: BrowserWindow;
  editorService: E4EditorService;
  lspService: E4LspEditorService;
}

export interface E4EditorIpcHandlers {
  dispose(): void;
}

export function registerE4EditorIpcHandlers(
  options: E4EditorIpcHandlersOptions,
): E4EditorIpcHandlers {
  const eventSubscriptions = [
    options.editorService.onEvent((event) => {
      emitE4EditorEvent(options.mainWindow, event);
    }),
    options.lspService.onEvent((event) => {
      emitE4EditorEvent(options.mainWindow, event);
    }),
  ];

  options.ipcMain.handle(
    E4_EDITOR_INVOKE_CHANNEL,
    (_event: IpcMainInvokeEvent, request: E4EditorRequest): Promise<E4EditorResult> => {
      return invokeE4EditorRequest(options.editorService, options.lspService, request);
    },
  );

  return {
    dispose() {
      for (const subscription of eventSubscriptions) {
        subscription.dispose();
      }
      options.ipcMain.removeHandler(E4_EDITOR_INVOKE_CHANNEL);
    },
  };
}

export async function invokeE4EditorRequest(
  editorService: E4EditorService,
  lspService: E4LspEditorService,
  request: E4EditorRequest,
): Promise<E4EditorResult> {
  switch (request.type) {
    case "e4/file-tree/read":
      return editorService.readFileTree(request);
    case "e4/file/create":
      return editorService.createFile(request);
    case "e4/file/delete":
      return editorService.deleteFile(request);
    case "e4/file/rename":
      return editorService.renameFile(request);
    case "e4/file/read":
      return editorService.readFile(request);
    case "e4/file/write":
      return editorService.writeFile(request);
    case "e4/git-badges/read":
      return editorService.readGitBadges(request);
    case "e4/lsp-diagnostics/read":
      return lspService.readDiagnostics(request);
    case "e4/lsp-status/read":
      return lspService.readStatus(request);
    case "e4/lsp-document/open":
      return lspService.openDocument(request);
    case "e4/lsp-document/change":
      return lspService.changeDocument(request);
    case "e4/lsp-document/close":
      return lspService.closeDocument(request);
  }
}

export function emitE4EditorEvent(
  mainWindow: BrowserWindow,
  event: E4EditorEvent,
): void {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(E4_EDITOR_EVENT_CHANNEL, event);
}
