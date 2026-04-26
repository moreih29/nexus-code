import { describe, expect, test } from "bun:test";

import type { HarnessObserverEvent, ToolCallEvent } from "../../../../shared/src/contracts/harness-observer";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import { createHarnessToolFeedStore, HARNESS_TOOL_FEED_LIMIT } from "./harnessToolFeedStore";

class FakeObserverBridge {
  public readonly listeners = new Set<(event: HarnessObserverEvent) => void>();
  public subscribeCount = 0;
  public disposeCount = 0;

  onObserverEvent(listener: (event: HarnessObserverEvent) => void) {
    this.subscribeCount += 1;
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.disposeCount += 1;
        this.listeners.delete(listener);
      },
    };
  }

  emit(event: HarnessObserverEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const workspaceId = "ws_tool_feed" as WorkspaceId;
const otherWorkspaceId = "ws_other_tool_feed" as WorkspaceId;

function createToolCallEvent(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    type: "harness/tool-call",
    status: "started",
    toolName: "Read",
    sessionId: "sess_tool_feed",
    adapterName: "claude-code",
    workspaceId,
    timestamp: "2026-04-26T05:15:00.000Z",
    inputSummary: "file_path: hello.py",
    ...overrides,
  };
}

describe("harnessToolFeedStore", () => {
  test("appends tool call events per workspace and ignores non-tool observer events", () => {
    const bridge = new FakeObserverBridge();
    const store = createHarnessToolFeedStore(bridge);

    store.getState().applyObserverEvent({
      type: "harness/tab-badge",
      workspaceId,
      adapterName: "claude-code",
      sessionId: "sess_badge",
      state: "running",
      timestamp: "2026-04-26T05:14:00.000Z",
    });
    store.getState().applyObserverEvent(createToolCallEvent({ toolName: "Read" }));
    store.getState().applyObserverEvent(createToolCallEvent({
      workspaceId: otherWorkspaceId,
      toolName: "Bash",
      inputSummary: "command: bun test",
    }));

    expect(store.getState().getEntriesForWorkspace(workspaceId).map((entry) => entry.toolName)).toEqual([
      "Read",
    ]);
    expect(store.getState().getEntriesForWorkspace(otherWorkspaceId).map((entry) => entry.toolName)).toEqual([
      "Bash",
    ]);
    expect(store.getState().getEntriesForWorkspace(workspaceId)[0]?.receivedSequence).toBe(1);
  });

  test("keeps only the most recent workspace entries", () => {
    const bridge = new FakeObserverBridge();
    const store = createHarnessToolFeedStore(bridge);

    for (let index = 0; index < HARNESS_TOOL_FEED_LIMIT + 5; index += 1) {
      store.getState().applyObserverEvent(createToolCallEvent({
        toolName: `Tool ${index}`,
        timestamp: `2026-04-26T05:15:${String(index % 60).padStart(2, "0")}.000Z`,
      }));
    }

    const entries = store.getState().getEntriesForWorkspace(workspaceId);
    expect(entries).toHaveLength(HARNESS_TOOL_FEED_LIMIT);
    expect(entries[0]?.toolName).toBe("Tool 5");
    expect(entries.at(-1)?.toolName).toBe(`Tool ${HARNESS_TOOL_FEED_LIMIT + 4}`);
  });

  test("observer subscription is idempotent and disposable", () => {
    const bridge = new FakeObserverBridge();
    const store = createHarnessToolFeedStore(bridge);

    store.getState().startObserverSubscription();
    store.getState().startObserverSubscription();
    bridge.emit(createToolCallEvent({ toolName: "Edit" }));

    expect(bridge.subscribeCount).toBe(1);
    expect(store.getState().getEntriesForWorkspace(workspaceId).map((entry) => entry.toolName)).toEqual([
      "Edit",
    ]);

    store.getState().stopObserverSubscription();
    bridge.emit(createToolCallEvent({ toolName: "Write" }));

    expect(bridge.disposeCount).toBe(1);
    expect(store.getState().getEntriesForWorkspace(workspaceId).map((entry) => entry.toolName)).toEqual([
      "Edit",
    ]);
  });
});
