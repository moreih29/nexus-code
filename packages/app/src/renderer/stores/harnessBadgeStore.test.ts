import { describe, expect, test } from "bun:test";

import type { HarnessObserverEvent } from "../../../../shared/src/contracts/harness-observer";
import {
  createHarnessBadgeStore,
  type HarnessObserverBridge,
} from "./harnessBadgeStore";

class FakeHarnessBridge implements HarnessObserverBridge {
  public listener: ((event: HarnessObserverEvent) => void) | null = null;
  public disposed = 0;

  onObserverEvent(listener: (event: HarnessObserverEvent) => void) {
    this.listener = listener;
    return {
      dispose: () => {
        this.disposed += 1;
        if (this.listener === listener) {
          this.listener = null;
        }
      },
    };
  }

  emit(event: HarnessObserverEvent): void {
    this.listener?.(event);
  }
}

const baseEvent = {
  type: "harness/tab-badge" as const,
  workspaceId: "ws_alpha",
  adapterName: "claude-code",
  sessionId: "sess_001",
  timestamp: "2026-04-26T05:15:00.000Z",
};

describe("harnessBadgeStore", () => {
  test("subscribes to preload observer events and stores visible badge states", () => {
    const bridge = new FakeHarnessBridge();
    const store = createHarnessBadgeStore(bridge);

    store.getState().startObserverSubscription();
    bridge.emit({ ...baseEvent, state: "running" });

    expect(store.getState().badgeByWorkspaceId.ws_alpha).toMatchObject({
      state: "running",
      sessionId: "sess_001",
    });

    store.getState().stopObserverSubscription();
    expect(bridge.disposed).toBe(1);
  });

  test("last-event-wins ignores stale events and completed removes the visible badge", () => {
    const bridge = new FakeHarnessBridge();
    const store = createHarnessBadgeStore(bridge);

    store.getState().applyObserverEvent({
      ...baseEvent,
      sessionId: "sess_new",
      state: "awaiting-approval",
      timestamp: "2026-04-26T05:15:10.000Z",
    });
    store.getState().applyObserverEvent({
      ...baseEvent,
      sessionId: "sess_old",
      state: "error",
      timestamp: "2026-04-26T05:15:05.000Z",
    });

    expect(store.getState().badgeByWorkspaceId.ws_alpha).toMatchObject({
      state: "awaiting-approval",
      sessionId: "sess_new",
    });

    store.getState().applyObserverEvent({
      ...baseEvent,
      sessionId: "sess_new",
      state: "completed",
      timestamp: "2026-04-26T05:15:11.000Z",
    });

    expect(store.getState().badgeByWorkspaceId.ws_alpha).toBeUndefined();
    expect(store.getState().latestEventByWorkspaceId.ws_alpha).toMatchObject({
      sessionId: "sess_new",
      timestamp: "2026-04-26T05:15:11.000Z",
    });
  });

  test("error automatically clears on the next running event", () => {
    const bridge = new FakeHarnessBridge();
    const store = createHarnessBadgeStore(bridge);

    store.getState().applyObserverEvent({
      ...baseEvent,
      state: "error",
      timestamp: "2026-04-26T05:15:00.000Z",
    });
    store.getState().applyObserverEvent({
      ...baseEvent,
      sessionId: "sess_next",
      state: "running",
      timestamp: "2026-04-26T05:15:01.000Z",
    });

    expect(store.getState().badgeByWorkspaceId.ws_alpha).toMatchObject({
      state: "running",
      sessionId: "sess_next",
    });
  });
});
