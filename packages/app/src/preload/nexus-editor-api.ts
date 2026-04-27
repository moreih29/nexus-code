import type { IpcRenderer, IpcRendererEvent } from "electron";

import {
  E4_EDITOR_EVENT_CHANNEL,
  E4_EDITOR_INVOKE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type {
  E4EditorEvent,
  E4EditorRequest,
  E4EditorResultFor,
} from "../../../shared/src/contracts/e4-editor";
import type { NexusPreloadDisposable } from "./nexus-workspace-api";

type IpcRendererLike = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export interface NexusEditorApi {
  invoke<TRequest extends E4EditorRequest>(
    request: TRequest,
  ): Promise<E4EditorResultFor<TRequest>>;
  onEvent(listener: (event: E4EditorEvent) => void): NexusPreloadDisposable;
}

export function createNexusEditorApi(ipcRenderer: IpcRendererLike): NexusEditorApi {
  return {
    invoke(request) {
      return ipcRenderer.invoke(E4_EDITOR_INVOKE_CHANNEL, request);
    },
    onEvent(listener) {
      const wrappedListener = (
        _event: IpcRendererEvent,
        payload: E4EditorEvent,
      ): void => {
        listener(payload);
      };

      ipcRenderer.on(E4_EDITOR_EVENT_CHANNEL, wrappedListener);

      return {
        dispose() {
          ipcRenderer.removeListener(E4_EDITOR_EVENT_CHANNEL, wrappedListener);
        },
      };
    },
  };
}
