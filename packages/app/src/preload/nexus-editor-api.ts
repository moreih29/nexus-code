import type { IpcRenderer, IpcRendererEvent } from "electron";

import {
  EDITOR_BRIDGE_EVENT_CHANNEL,
  EDITOR_BRIDGE_INVOKE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type {
  EditorBridgeEvent,
  EditorBridgeRequest,
  EditorBridgeResultFor,
} from "../../../shared/src/contracts/editor/editor-bridge";
import type { NexusPreloadDisposable } from "./nexus-workspace-api";

type IpcRendererLike = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export interface NexusEditorApi {
  invoke<TRequest extends EditorBridgeRequest>(
    request: TRequest,
  ): Promise<EditorBridgeResultFor<TRequest>>;
  onEvent(listener: (event: EditorBridgeEvent) => void): NexusPreloadDisposable;
}

export function createNexusEditorApi(ipcRenderer: IpcRendererLike): NexusEditorApi {
  return {
    invoke(request) {
      return ipcRenderer.invoke(EDITOR_BRIDGE_INVOKE_CHANNEL, request);
    },
    onEvent(listener) {
      const wrappedListener = (
        _event: IpcRendererEvent,
        payload: EditorBridgeEvent,
      ): void => {
        listener(payload);
      };

      ipcRenderer.on(EDITOR_BRIDGE_EVENT_CHANNEL, wrappedListener);

      return {
        dispose() {
          ipcRenderer.removeListener(EDITOR_BRIDGE_EVENT_CHANNEL, wrappedListener);
        },
      };
    },
  };
}
