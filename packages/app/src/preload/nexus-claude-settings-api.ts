import type { IpcRenderer, IpcRendererEvent } from "electron";

import {
  CLAUDE_SETTINGS_CONSENT_REQUEST_CHANNEL,
  CLAUDE_SETTINGS_CONSENT_RESPONSE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type {
  ClaudeSettingsConsentRequest,
  ClaudeSettingsConsentResponse,
} from "../../../shared/src/contracts/claude/claude-settings";
import type { NexusPreloadDisposable } from "./nexus-workspace-api";

type IpcRendererLike = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export interface NexusClaudeSettingsApi {
  onConsentRequest(
    listener: (request: ClaudeSettingsConsentRequest) => void,
  ): NexusPreloadDisposable;
  respondConsentRequest(response: ClaudeSettingsConsentResponse): Promise<void>;
}

export function createNexusClaudeSettingsApi(
  ipcRenderer: IpcRendererLike,
): NexusClaudeSettingsApi {
  return {
    onConsentRequest(listener) {
      const wrappedListener = (
        _event: IpcRendererEvent,
        payload: ClaudeSettingsConsentRequest,
      ): void => {
        listener(payload);
      };

      ipcRenderer.on(CLAUDE_SETTINGS_CONSENT_REQUEST_CHANNEL, wrappedListener);

      return {
        dispose() {
          ipcRenderer.removeListener(
            CLAUDE_SETTINGS_CONSENT_REQUEST_CHANNEL,
            wrappedListener,
          );
        },
      };
    },
    async respondConsentRequest(response) {
      await ipcRenderer.invoke(CLAUDE_SETTINGS_CONSENT_RESPONSE_CHANNEL, response);
    },
  };
}
