import { describe, expect, test } from "bun:test";

import {
  EDITOR_BRIDGE_EVENT_CHANNEL,
  EDITOR_BRIDGE_INVOKE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type {
  EditorBridgeEvent,
  EditorBridgeRequest,
  EditorBridgeResult,
} from "../../../shared/src/contracts/editor/editor-bridge";
import { createNexusEditorApi } from "./nexus-editor-api";

describe("createNexusEditorApi", () => {
  test("invokes the editor bridge channel with typed request payloads", async () => {
    const ipcRenderer = new FakeIpcRenderer();
    const api = createNexusEditorApi(ipcRenderer);
    const request: EditorBridgeRequest = {
      type: "workspace-files/file/read",
      workspaceId: "ws_preload_editor",
      path: "src/index.ts",
    };

    await expect(api.invoke(request)).resolves.toEqual({
      type: "workspace-files/file/read/result",
      workspaceId: "ws_preload_editor",
      path: "src/index.ts",
      content: "export {};\n",
      encoding: "utf8",
      version: "v1",
      readAt: "2026-04-27T00:00:00.000Z",
    });

    expect(ipcRenderer.invokeCalls).toEqual([
      {
        channel: EDITOR_BRIDGE_INVOKE_CHANNEL,
        payload: request,
      },
    ]);
  });

  test("subscribes and unsubscribes editor events", () => {
    const ipcRenderer = new FakeIpcRenderer();
    const api = createNexusEditorApi(ipcRenderer);
    const observedEvents: EditorBridgeEvent[] = [];
    const subscription = api.onEvent((event) => observedEvents.push(event));
    const payload: EditorBridgeEvent = {
      type: "workspace-files/watch",
      workspaceId: "ws_preload_editor",
      path: "src/index.ts",
      kind: "file",
      change: "changed",
      oldPath: null,
      occurredAt: "2026-04-27T00:00:00.000Z",
    };

    ipcRenderer.emitEditorEvent(payload);
    expect(observedEvents).toEqual([payload]);

    subscription.dispose();
    ipcRenderer.emitEditorEvent({ ...payload, path: "src/after-dispose.ts" });

    expect(observedEvents).toEqual([payload]);
    expect(ipcRenderer.removedChannels).toEqual([EDITOR_BRIDGE_EVENT_CHANNEL]);
  });
});

class FakeIpcRenderer {
  public readonly invokeCalls: Array<{ channel: string; payload: unknown }> = [];
  public readonly removedChannels: string[] = [];
  private eventListener:
    | ((event: unknown, payload: EditorBridgeEvent) => void)
    | null = null;

  public invoke(channel: string, payload?: unknown): Promise<EditorBridgeResult> {
    this.invokeCalls.push({ channel, payload });
    return Promise.resolve({
      type: "workspace-files/file/read/result",
      workspaceId: "ws_preload_editor",
      path: "src/index.ts",
      content: "export {};\n",
      encoding: "utf8",
      version: "v1",
      readAt: "2026-04-27T00:00:00.000Z",
    });
  }

  public on(
    channel: string,
    listener: (event: unknown, payload: EditorBridgeEvent) => void,
  ): void {
    if (channel === EDITOR_BRIDGE_EVENT_CHANNEL) {
      this.eventListener = listener;
    }
  }

  public removeListener(
    channel: string,
    listener: (event: unknown, payload: EditorBridgeEvent) => void,
  ): void {
    if (channel === EDITOR_BRIDGE_EVENT_CHANNEL && this.eventListener === listener) {
      this.eventListener = null;
    }

    this.removedChannels.push(channel);
  }

  public emitEditorEvent(payload: EditorBridgeEvent): void {
    this.eventListener?.({}, payload);
  }
}
