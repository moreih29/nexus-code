import path from "node:path";
import { createRequire } from "node:module";

import type { BrowserWindow, Clipboard, IpcMain, IpcMainInvokeEvent, NativeImage, Shell, WebContents } from "electron";

import { FILE_ACTIONS_INVOKE_CHANNEL } from "../../../../shared/src/contracts/ipc-channels";
import type { TerminalOpenedEvent, TerminalOpenCommand } from "../../../../shared/src/contracts/terminal/terminal-ipc";
import type { WorkspaceId, WorkspaceRegistry } from "../../../../shared/src/contracts/workspace/workspace";
import type {
  FileActionCopyPathRequest,
  FileActionStartFileDragRequest,
  FileActionOpenInTerminalRequest,
  FileActionOpenWithSystemAppRequest,
  FileActionRevealInFinderRequest,
  FileActionStartFileDragResult,
  FileActionsCopyPathResult,
  FileActionsRequest,
  FileActionsResult,
  FileActionsShellResult,
} from "../../common/file-actions";
import { resolveWorkspaceFilePath } from "../workspace/files/workspace-files-paths";
import { ExternalFileDropService, FileClipboardService } from "./clipboard";

const requireElectron = createRequire(import.meta.url);

export interface FileActionsWorkspaceRegistryStore {
  getWorkspaceRegistry(): Promise<WorkspaceRegistry>;
}

export interface FileActionsTerminalOpener {
  openTerminal(command: TerminalOpenCommand): Promise<TerminalOpenedEvent>;
}

export type FileActionsDragStarter = Pick<WebContents, "startDrag">;

export interface FileActionsIpcHandlersOptions {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  mainWindow: BrowserWindow;
  workspaceRegistryStore: FileActionsWorkspaceRegistryStore;
  terminalOpener?: FileActionsTerminalOpener | null;
  shell?: Pick<Shell, "showItemInFolder" | "openPath">;
  clipboard?: Pick<Clipboard, "writeText">;
  clipboardService?: FileClipboardService;
  externalFileDropService?: ExternalFileDropService;
  dragIcon?: NativeImage | string;
}

export interface FileActionsIpcHandlers {
  dispose(): void;
}

export function registerFileActionsIpcHandlers(
  options: FileActionsIpcHandlersOptions,
): FileActionsIpcHandlers {
  const shell = options.shell ?? getElectronShell();
  const clipboard = options.clipboard ?? getElectronClipboard();
  const clipboardService = options.clipboardService ?? new FileClipboardService({
    workspaceRegistryStore: options.workspaceRegistryStore,
  });
  const externalFileDropService = options.externalFileDropService ?? new ExternalFileDropService({
    workspaceRegistryStore: options.workspaceRegistryStore,
  });

  options.ipcMain.handle(
    FILE_ACTIONS_INVOKE_CHANNEL,
    (event: IpcMainInvokeEvent, request: FileActionsRequest): Promise<FileActionsResult> => {
      return invokeFileActionRequest({
        request,
        workspaceRegistryStore: options.workspaceRegistryStore,
        terminalOpener: options.terminalOpener ?? null,
        shell,
        clipboard,
        clipboardService,
        externalFileDropService,
        dragStarter: event.sender,
        dragIcon: options.dragIcon,
      });
    },
  );

  return {
    dispose() {
      options.ipcMain.removeHandler(FILE_ACTIONS_INVOKE_CHANNEL);
    },
  };
}

export interface InvokeFileActionRequestOptions {
  request: FileActionsRequest;
  workspaceRegistryStore: FileActionsWorkspaceRegistryStore;
  terminalOpener?: FileActionsTerminalOpener | null;
  shell?: Pick<Shell, "showItemInFolder" | "openPath">;
  clipboard?: Pick<Clipboard, "writeText">;
  clipboardService?: Pick<FileClipboardService, "paste">;
  externalFileDropService?: Pick<ExternalFileDropService, "copyIntoWorkspace">;
  dragStarter?: FileActionsDragStarter | null;
  dragIcon?: NativeImage | string;
}

export async function invokeFileActionRequest({
  request,
  workspaceRegistryStore,
  terminalOpener = null,
  shell = getElectronShell(),
  clipboard = getElectronClipboard(),
  clipboardService = new FileClipboardService({ workspaceRegistryStore }),
  externalFileDropService = new ExternalFileDropService({ workspaceRegistryStore }),
  dragStarter = null,
  dragIcon,
}: InvokeFileActionRequestOptions): Promise<FileActionsResult> {
  switch (request.type) {
    case "file-actions/reveal-in-finder":
      return revealInFinder(workspaceRegistryStore, shell, request);
    case "file-actions/open-with-system-app":
      return openWithSystemApp(workspaceRegistryStore, shell, request);
    case "file-actions/open-in-terminal":
      return openInTerminal(workspaceRegistryStore, terminalOpener, request);
    case "file-actions/copy-path":
      return copyPath(workspaceRegistryStore, clipboard, request);
    case "file-actions/start-file-drag":
      return startFileDrag(workspaceRegistryStore, dragStarter, dragIcon, request);
    case "file-actions/clipboard/paste":
      return clipboardService.paste(request);
    case "file-actions/external-drag-in":
      return externalFileDropService.copyIntoWorkspace(request);
  }
}

function getElectronShell(): Pick<Shell, "showItemInFolder" | "openPath"> {
  const electronModule = requireElectron("electron") as {
    shell?: Pick<Shell, "showItemInFolder" | "openPath">;
  };
  if (!electronModule.shell) {
    return {
      showItemInFolder() {
        throw new Error("Electron shell is unavailable in this runtime.");
      },
      openPath() {
        throw new Error("Electron shell is unavailable in this runtime.");
      },
    };
  }

  return electronModule.shell;
}

function getElectronClipboard(): Pick<Clipboard, "writeText"> {
  const electronModule = requireElectron("electron") as { clipboard?: Pick<Clipboard, "writeText"> };
  if (!electronModule.clipboard) {
    return {
      writeText() {
        throw new Error("Electron clipboard is unavailable in this runtime.");
      },
    };
  }

  return electronModule.clipboard;
}

function getElectronNativeImage(): { createFromDataURL(dataUrl: string): NativeImage } {
  const electronModule = requireElectron("electron") as {
    nativeImage?: { createFromDataURL(dataUrl: string): NativeImage };
  };
  if (!electronModule.nativeImage) {
    return {
      createFromDataURL() {
        throw new Error("Electron nativeImage is unavailable in this runtime.");
      },
    };
  }

  return electronModule.nativeImage;
}

async function revealInFinder(
  workspaceRegistryStore: FileActionsWorkspaceRegistryStore,
  shell: Pick<Shell, "showItemInFolder">,
  request: FileActionRevealInFinderRequest,
): Promise<FileActionsShellResult> {
  const target = await resolveFileActionPath(workspaceRegistryStore, request.workspaceId, request.path);
  shell.showItemInFolder(target.absolutePath);
  return {
    type: "file-actions/shell/result",
    action: "revealInFinder",
    workspaceId: request.workspaceId,
    path: target.relativePath || null,
    absolutePath: target.absolutePath,
  };
}

async function openWithSystemApp(
  workspaceRegistryStore: FileActionsWorkspaceRegistryStore,
  shell: Pick<Shell, "openPath">,
  request: FileActionOpenWithSystemAppRequest,
): Promise<FileActionsShellResult> {
  const target = await resolveFileActionPath(workspaceRegistryStore, request.workspaceId, request.path);
  const errorMessage = await shell.openPath(target.absolutePath);
  if (errorMessage) {
    throw new Error(errorMessage);
  }

  return {
    type: "file-actions/shell/result",
    action: "openWithSystemApp",
    workspaceId: request.workspaceId,
    path: target.relativePath || null,
    absolutePath: target.absolutePath,
  };
}

async function openInTerminal(
  workspaceRegistryStore: FileActionsWorkspaceRegistryStore,
  terminalOpener: FileActionsTerminalOpener | null,
  request: FileActionOpenInTerminalRequest,
): Promise<FileActionsShellResult> {
  if (!terminalOpener) {
    throw new Error(
      "Open in Terminal is unavailable because the file-actions IPC was registered without the existing terminal bridge.",
    );
  }

  const target = await resolveFileActionPath(workspaceRegistryStore, request.workspaceId, request.path);
  const cwd = request.kind === "file" ? path.dirname(target.absolutePath) : target.absolutePath;
  const openedTerminal = await terminalOpener.openTerminal({
    type: "terminal/open",
    workspaceId: request.workspaceId,
    cwd,
    cols: 120,
    rows: 30,
  });

  return {
    type: "file-actions/shell/result",
    action: "openInTerminal",
    workspaceId: request.workspaceId,
    path: target.relativePath || null,
    absolutePath: cwd,
    openedTerminal,
  };
}

async function copyPath(
  workspaceRegistryStore: FileActionsWorkspaceRegistryStore,
  clipboard: Pick<Clipboard, "writeText">,
  request: FileActionCopyPathRequest,
): Promise<FileActionsCopyPathResult> {
  const target = await resolveFileActionPath(workspaceRegistryStore, request.workspaceId, request.path);
  const pathKind = request.pathKind ?? "absolute";
  const copiedText = pathKind === "relative" ? target.relativePath : target.absolutePath;
  clipboard.writeText(copiedText);
  return {
    type: "file-actions/copy-path/result",
    workspaceId: request.workspaceId,
    path: target.relativePath || null,
    copiedText,
    pathKind,
  };
}

async function startFileDrag(
  workspaceRegistryStore: FileActionsWorkspaceRegistryStore,
  dragStarter: FileActionsDragStarter | null,
  dragIcon: NativeImage | string | undefined,
  request: FileActionStartFileDragRequest,
): Promise<FileActionStartFileDragResult> {
  if (!dragStarter) {
    throw new Error("External file drag is unavailable because no renderer WebContents was provided.");
  }

  const targets = await Promise.all(
    request.paths.map((relativePath) =>
      resolveFileActionPath(workspaceRegistryStore, request.workspaceId, relativePath),
    ),
  );
  const absolutePaths = targets.map((target) => target.absolutePath);
  const firstFile = absolutePaths[0];
  if (!firstFile) {
    throw new Error("External file drag requires at least one path.");
  }

  dragStarter.startDrag({
    file: firstFile,
    files: absolutePaths,
    icon: dragIcon ?? createDefaultDragIcon(),
  });

  return {
    type: "file-actions/start-file-drag/result",
    workspaceId: request.workspaceId,
    paths: targets.map((target) => target.relativePath),
    absolutePaths,
  };
}

async function resolveFileActionPath(
  workspaceRegistryStore: FileActionsWorkspaceRegistryStore,
  workspaceId: WorkspaceId,
  relativePath: string | null,
): Promise<{ workspaceRoot: string; absolutePath: string; relativePath: string }> {
  const registry = await workspaceRegistryStore.getWorkspaceRegistry();
  const workspace = registry.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    throw new Error(`Workspace "${workspaceId}" is not registered.`);
  }

  return resolveWorkspaceFilePath(workspace.absolutePath, relativePath ?? "", {
    allowRoot: true,
    fieldName: "path",
  });
}

function createDefaultDragIcon(): NativeImage {
  return getElectronNativeImage().createFromDataURL(DEFAULT_DRAG_ICON_DATA_URL);
}

const DEFAULT_DRAG_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVR4AWP4//8/AyUYTFhYGJgGJgYqYBqMGjAAAFcUEf8JwqQmAAAAAElFTkSuQmCC";
