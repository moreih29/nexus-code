import { describe, expect, test } from "bun:test";

import { HARNESS_OBSERVER_EVENT_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import type { HarnessObserverEvent } from "../../../shared/src/contracts/harness/harness-observer";
import { createNexusHarnessApi } from "./nexus-harness-api";

describe("createNexusHarnessApi", () => {
  test("subscribes and unsubscribes harness observer events", () => {
    const ipcRenderer = new FakeIpcRenderer();
    const api = createNexusHarnessApi(ipcRenderer);
    const observedEvents: HarnessObserverEvent[] = [];

    const subscription = api.onObserverEvent((event) => {
      observedEvents.push(event);
    });
    const payload: HarnessObserverEvent = {
      type: "harness/tab-badge",
      workspaceId: "ws_alpha",
      adapterName: "claude-code",
      sessionId: "sess_preload_001",
      state: "running",
      timestamp: "2026-04-26T05:15:00.000Z",
    };
    const toolCallPayload: HarnessObserverEvent = {
      type: "harness/tool-call",
      workspaceId: "ws_alpha",
      adapterName: "claude-code",
      sessionId: "sess_preload_001",
      status: "completed",
      toolName: "Read",
      timestamp: "2026-04-26T05:15:01.000Z",
      inputSummary: "file_path: hello.py",
    };

    ipcRenderer.emitObserverEvent(payload);
    ipcRenderer.emitObserverEvent(toolCallPayload);

    expect(observedEvents).toEqual([payload, toolCallPayload]);

    subscription.dispose();
    ipcRenderer.emitObserverEvent({
      ...payload,
      state: "completed",
    });

    expect(observedEvents).toEqual([payload, toolCallPayload]);
    expect(ipcRenderer.removedChannels).toEqual([HARNESS_OBSERVER_EVENT_CHANNEL]);
  });
});

class FakeIpcRenderer {
  public readonly removedChannels: string[] = [];

  private observerEventListener:
    | ((event: unknown, payload: HarnessObserverEvent) => void)
    | null = null;

  public on(
    channel: string,
    listener: (event: unknown, payload: HarnessObserverEvent) => void,
  ): void {
    if (channel === HARNESS_OBSERVER_EVENT_CHANNEL) {
      this.observerEventListener = listener;
    }
  }

  public removeListener(
    channel: string,
    listener: (event: unknown, payload: HarnessObserverEvent) => void,
  ): void {
    if (
      channel === HARNESS_OBSERVER_EVENT_CHANNEL &&
      this.observerEventListener === listener
    ) {
      this.observerEventListener = null;
    }

    this.removedChannels.push(channel);
  }

  public emitObserverEvent(payload: HarnessObserverEvent): void {
    this.observerEventListener?.({}, payload);
  }
}
