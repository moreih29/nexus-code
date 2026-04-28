import type { IpcRenderer, IpcRendererEvent } from "electron";

import {
  GIT_BRIDGE_EVENT_CHANNEL,
  GIT_BRIDGE_INVOKE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type { GitBridgeEvent, GitBridgeRequest, GitBridgeResult } from "../main/git/git-bridge-ipc";
import type { NexusPreloadDisposable } from "./nexus-workspace-api";

type IpcRendererLike = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export type NexusGitEvent = GitBridgeEvent;

export interface NexusGitApi {
  invoke(request: GitBridgeRequest): Promise<GitBridgeResult>;
  onEvent(listener: (event: NexusGitEvent) => void): NexusPreloadDisposable;
}

export function createNexusGitApi(ipcRenderer: IpcRendererLike): NexusGitApi {
  return {
    invoke(request) {
      return ipcRenderer.invoke(GIT_BRIDGE_INVOKE_CHANNEL, request);
    },
    onEvent(listener) {
      const wrappedListener = (
        _event: IpcRendererEvent,
        payload: NexusGitEvent,
      ): void => {
        listener(payload);
      };

      ipcRenderer.on(GIT_BRIDGE_EVENT_CHANNEL, wrappedListener);

      return {
        dispose() {
          ipcRenderer.removeListener(GIT_BRIDGE_EVENT_CHANNEL, wrappedListener);
        },
      };
    },
  };
}
