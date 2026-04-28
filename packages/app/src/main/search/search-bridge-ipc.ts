import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import {
  SEARCH_BRIDGE_EVENT_CHANNEL,
  SEARCH_BRIDGE_INVOKE_CHANNEL,
} from "../../../../shared/src/contracts/ipc-channels";
import type {
  SearchCancelCommand,
  SearchCanceledEvent,
  SearchCompletedEvent,
  SearchFailedEvent,
  SearchStartedReply,
  SearchStartCommand,
} from "../../../../shared/src/contracts/generated/search-lifecycle";
import type { SearchResultChunkMessage } from "../../../../shared/src/contracts/generated/search-relay";
import type {
  SidecarStartCommand,
  SidecarStartedEvent,
} from "../../../../shared/src/contracts/sidecar/sidecar";
import type { WorkspaceRegistry } from "../../../../shared/src/contracts/workspace/workspace";

export type SearchBridgeRequest = SearchStartCommand | SearchCancelCommand;
export type SearchBridgeResult = SearchStartedReply | SearchFailedEvent | null;
export type SearchBridgeEvent =
  | SearchStartedReply
  | SearchFailedEvent
  | SearchCompletedEvent
  | SearchCanceledEvent
  | SearchResultChunkMessage;

export interface SearchBridgeDisposable {
  dispose(): void;
}

export interface SearchBridgeClient {
  start(command: SidecarStartCommand): Promise<SidecarStartedEvent>;
  startSearch(command: SearchStartCommand): Promise<SearchStartedReply | SearchFailedEvent>;
  cancelSearch(command: SearchCancelCommand): Promise<void>;
  onSearchEvent(listener: (event: SearchBridgeEvent) => void): SearchBridgeDisposable;
}

export interface SearchWorkspaceRegistryStore {
  getWorkspaceRegistry(): Promise<WorkspaceRegistry>;
}

export interface SearchBridgeIpcHandlersOptions {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  mainWindow: BrowserWindow;
  searchClient: SearchBridgeClient;
  workspaceRegistryStore: SearchWorkspaceRegistryStore;
}

export interface SearchBridgeIpcHandlers {
  dispose(): void;
}

export function registerSearchBridgeIpcHandlers(
  options: SearchBridgeIpcHandlersOptions,
): SearchBridgeIpcHandlers {
  const subscription = options.searchClient.onSearchEvent((event) => {
    emitSearchBridgeEvent(options.mainWindow, event);
  });

  options.ipcMain.handle(
    SEARCH_BRIDGE_INVOKE_CHANNEL,
    (_event: IpcMainInvokeEvent, request: SearchBridgeRequest): Promise<SearchBridgeResult> => {
      return invokeSearchBridgeRequest(
        options.searchClient,
        options.workspaceRegistryStore,
        request,
      );
    },
  );

  return {
    dispose() {
      subscription.dispose();
      options.ipcMain.removeHandler(SEARCH_BRIDGE_INVOKE_CHANNEL);
    },
  };
}

export async function invokeSearchBridgeRequest(
  searchClient: SearchBridgeClient,
  workspaceRegistryStore: SearchWorkspaceRegistryStore,
  request: SearchBridgeRequest,
): Promise<SearchBridgeResult> {
  switch (request.action) {
    case "start": {
      const workspacePath = await resolveSearchWorkspacePath(workspaceRegistryStore, request);
      const command: SearchStartCommand = {
        ...request,
        cwd: workspacePath,
      };
      await searchClient.start({
        type: "sidecar/start",
        workspaceId: command.workspaceId,
        workspacePath,
        reason: "workspace-open",
      });
      return searchClient.startSearch(command);
    }
    case "cancel":
      await searchClient.cancelSearch(request);
      return null;
  }
}

async function resolveSearchWorkspacePath(
  workspaceRegistryStore: SearchWorkspaceRegistryStore,
  request: SearchStartCommand,
): Promise<string> {
  const registry = await workspaceRegistryStore.getWorkspaceRegistry();
  const workspace = registry.workspaces.find((entry) => entry.id === request.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace "${request.workspaceId}" is not registered.`);
  }

  return workspace.absolutePath;
}

export function emitSearchBridgeEvent(
  mainWindow: BrowserWindow,
  event: SearchBridgeEvent,
): void {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(SEARCH_BRIDGE_EVENT_CHANNEL, event);
}
