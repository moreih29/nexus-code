import { describe, expect, mock, test } from "bun:test";

import { CLAUDE_SETTINGS_CONSENT_REQUEST_CHANNEL, CLAUDE_SETTINGS_CONSENT_RESPONSE_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import type { ClaudeSettingsConsentRequest } from "../../../shared/src/contracts/claude-settings";
import { createNexusClaudeSettingsApi } from "./nexus-claude-settings-api";

describe("createNexusClaudeSettingsApi", () => {
  test("subscribes consent requests and responds through IPC", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const ipcRenderer = {
      on: mock((channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener);
      }),
      removeListener: mock((channel: string, listener: (...args: unknown[]) => void) => {
        if (listeners.get(channel) === listener) {
          listeners.delete(channel);
        }
      }),
      invoke: mock(async () => null),
    };
    const api = createNexusClaudeSettingsApi(ipcRenderer);
    const received: ClaudeSettingsConsentRequest[] = [];
    const subscription = api.onConsentRequest((request) => {
      received.push(request);
    });
    const request: ClaudeSettingsConsentRequest = {
      requestId: "req-1",
      workspaceId: "ws_1",
      workspaceName: "Alpha",
      workspacePath: "/tmp/alpha",
    };

    listeners.get(CLAUDE_SETTINGS_CONSENT_REQUEST_CHANNEL)?.({}, request);
    await api.respondConsentRequest({
      requestId: "req-1",
      approved: true,
      dontAskAgain: true,
    });
    subscription.dispose();

    expect(received).toEqual([request]);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      CLAUDE_SETTINGS_CONSENT_RESPONSE_CHANNEL,
      {
        requestId: "req-1",
        approved: true,
        dontAskAgain: true,
      },
    );
    expect(listeners.has(CLAUDE_SETTINGS_CONSENT_REQUEST_CHANNEL)).toBeFalse();
  });
});
