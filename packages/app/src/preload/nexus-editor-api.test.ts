import { describe, expect, test } from "bun:test";

import {
  E4_EDITOR_EVENT_CHANNEL,
  E4_EDITOR_INVOKE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type {
  E4EditorEvent,
  E4EditorRequest,
  E4EditorResult,
} from "../../../shared/src/contracts/e4-editor";
import { createNexusEditorApi } from "./nexus-editor-api";

describe("createNexusEditorApi", () => {
  test("invokes the E4 editor channel with typed request payloads", async () => {
    const ipcRenderer = new FakeIpcRenderer();
    const api = createNexusEditorApi(ipcRenderer);
    const request: E4EditorRequest = {
      type: "e4/file/read",
      workspaceId: "ws_preload_editor",
      path: "src/index.ts",
    };

    await expect(api.invoke(request)).resolves.toEqual({
      type: "e4/file/read/result",
      workspaceId: "ws_preload_editor",
      path: "src/index.ts",
      content: "export {};\n",
      encoding: "utf8",
      version: "v1",
      readAt: "2026-04-27T00:00:00.000Z",
    });

    expect(ipcRenderer.invokeCalls).toEqual([
      {
        channel: E4_EDITOR_INVOKE_CHANNEL,
        payload: request,
      },
    ]);
  });

  test("subscribes and unsubscribes editor events", () => {
    const ipcRenderer = new FakeIpcRenderer();
    const api = createNexusEditorApi(ipcRenderer);
    const observedEvents: E4EditorEvent[] = [];
    const subscription = api.onEvent((event) => observedEvents.push(event));
    const payload: E4EditorEvent = {
      type: "e4/file/watch",
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
    expect(ipcRenderer.removedChannels).toEqual([E4_EDITOR_EVENT_CHANNEL]);
  });
});

class FakeIpcRenderer {
  public readonly invokeCalls: Array<{ channel: string; payload: unknown }> = [];
  public readonly removedChannels: string[] = [];
  private eventListener:
    | ((event: unknown, payload: E4EditorEvent) => void)
    | null = null;

  public invoke(channel: string, payload?: unknown): Promise<E4EditorResult> {
    this.invokeCalls.push({ channel, payload });
    return Promise.resolve({
      type: "e4/file/read/result",
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
    listener: (event: unknown, payload: E4EditorEvent) => void,
  ): void {
    if (channel === E4_EDITOR_EVENT_CHANNEL) {
      this.eventListener = listener;
    }
  }

  public removeListener(
    channel: string,
    listener: (event: unknown, payload: E4EditorEvent) => void,
  ): void {
    if (channel === E4_EDITOR_EVENT_CHANNEL && this.eventListener === listener) {
      this.eventListener = null;
    }

    this.removedChannels.push(channel);
  }

  public emitEditorEvent(payload: E4EditorEvent): void {
    this.eventListener?.({}, payload);
  }
}
