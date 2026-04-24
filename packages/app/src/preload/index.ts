import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_INVOKE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type {
  TerminalIpcCommand,
  TerminalIpcEvent,
} from "../../../shared/src/contracts/terminal-ipc";
import {
  createNexusWorkspaceApi,
  type NexusPreloadDisposable,
  type NexusWorkspaceApi,
} from "./nexus-workspace-api";

export interface NexusTerminalApi {
  invoke(command: TerminalIpcCommand): Promise<unknown>;
  onEvent(listener: (event: TerminalIpcEvent) => void): NexusPreloadDisposable;
}

const nexusTerminal: NexusTerminalApi = {
  invoke(command) {
    return ipcRenderer.invoke(TERMINAL_INVOKE_CHANNEL, command);
  },
  onEvent(listener) {
    const wrappedListener = (_event: IpcRendererEvent, payload: TerminalIpcEvent): void => {
      listener(payload);
    };

    ipcRenderer.on(TERMINAL_EVENT_CHANNEL, wrappedListener);

    return {
      dispose: () => {
        ipcRenderer.removeListener(TERMINAL_EVENT_CHANNEL, wrappedListener);
      },
    };
  },
};

const nexusWorkspace: NexusWorkspaceApi = createNexusWorkspaceApi(ipcRenderer);

contextBridge.exposeInMainWorld("nexusTerminal", nexusTerminal);
contextBridge.exposeInMainWorld("nexusWorkspace", nexusWorkspace);
