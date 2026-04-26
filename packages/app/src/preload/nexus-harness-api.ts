import type { IpcRenderer, IpcRendererEvent } from "electron";

import { HARNESS_OBSERVER_EVENT_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import type { HarnessObserverEvent } from "../../../shared/src/contracts/harness-observer";
import type { NexusPreloadDisposable } from "./nexus-workspace-api";

type IpcRendererLike = Pick<IpcRenderer, "on" | "removeListener">;

export interface NexusHarnessApi {
  onObserverEvent(
    listener: (event: HarnessObserverEvent) => void,
  ): NexusPreloadDisposable;
}

export function createNexusHarnessApi(ipcRenderer: IpcRendererLike): NexusHarnessApi {
  return {
    onObserverEvent(listener) {
      const wrappedListener = (
        _event: IpcRendererEvent,
        payload: HarnessObserverEvent,
      ): void => {
        listener(payload);
      };

      ipcRenderer.on(HARNESS_OBSERVER_EVENT_CHANNEL, wrappedListener);

      return {
        dispose() {
          ipcRenderer.removeListener(HARNESS_OBSERVER_EVENT_CHANNEL, wrappedListener);
        },
      };
    },
  };
}
