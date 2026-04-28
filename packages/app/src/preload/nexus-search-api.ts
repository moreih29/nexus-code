import type { IpcRenderer, IpcRendererEvent } from "electron";

import {
  SEARCH_BRIDGE_EVENT_CHANNEL,
  SEARCH_BRIDGE_INVOKE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type {
  SearchCancelCommand,
  SearchCompletedEvent,
  SearchFailedEvent,
  SearchStartedReply,
  SearchStartCommand,
  SearchCanceledEvent,
} from "../../../shared/src/contracts/generated/search-lifecycle";
import type { SearchResultChunkMessage } from "../../../shared/src/contracts/generated/search-relay";
import type { NexusPreloadDisposable } from "./nexus-workspace-api";

type IpcRendererLike = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export type NexusSearchEvent =
  | SearchStartedReply
  | SearchCompletedEvent
  | SearchFailedEvent
  | SearchCanceledEvent
  | SearchResultChunkMessage;

export interface NexusSearchApi {
  startSearch(command: SearchStartCommand): Promise<SearchStartedReply | SearchFailedEvent>;
  cancelSearch(command: SearchCancelCommand): Promise<void>;
  onEvent(listener: (event: NexusSearchEvent) => void): NexusPreloadDisposable;
}

export function createNexusSearchApi(ipcRenderer: IpcRendererLike): NexusSearchApi {
  return {
    startSearch(command) {
      return ipcRenderer.invoke(SEARCH_BRIDGE_INVOKE_CHANNEL, command);
    },
    async cancelSearch(command) {
      await ipcRenderer.invoke(SEARCH_BRIDGE_INVOKE_CHANNEL, command);
    },
    onEvent(listener) {
      const wrappedListener = (
        _event: IpcRendererEvent,
        payload: NexusSearchEvent,
      ): void => {
        listener(payload);
      };

      ipcRenderer.on(SEARCH_BRIDGE_EVENT_CHANNEL, wrappedListener);

      return {
        dispose() {
          ipcRenderer.removeListener(SEARCH_BRIDGE_EVENT_CHANNEL, wrappedListener);
        },
      };
    },
  };
}
