import { describe, expect, test } from "bun:test";

import type {
  HarnessObserverEvent,
  SessionHistoryEvent,
} from "../../../../shared/src/contracts/harness/harness-observer";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { createHarnessSessionStore } from "./harnessSessionStore";

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

const workspaceId = "ws_session" as WorkspaceId;
const otherWorkspaceId = "ws_other_session" as WorkspaceId;

function createSessionHistoryEvent(
  overrides: Partial<SessionHistoryEvent> = {},
): SessionHistoryEvent {
  return {
    type: "harness/session-history",
    workspaceId,
    adapterName: "claude-code",
    sessionId: "sess_session",
    timestamp: "2026-04-26T05:15:00.000Z",
    transcriptPath: "/Users/kih/.claude/projects/project/session.jsonl",
    ...overrides,
  };
}

describe("harnessSessionStore", () => {
  test("stores latest session history reference per workspace and ignores other events", () => {
    const bridge = new FakeObserverBridge();
    const store = createHarnessSessionStore(bridge);

    store.getState().applyObserverEvent({
      type: "harness/tool-call",
      workspaceId,
      adapterName: "claude-code",
      sessionId: "sess_tool",
      status: "completed",
      toolName: "Read",
      timestamp: "2026-04-26T05:14:00.000Z",
    });
    store.getState().applyObserverEvent(createSessionHistoryEvent({ transcriptPath: "/Users/kih/.claude/projects/project/one.jsonl" }));
    store.getState().applyObserverEvent(createSessionHistoryEvent({
      workspaceId: otherWorkspaceId,
      sessionId: "sess_other",
      transcriptPath: "/Users/kih/.claude/projects/other/two.jsonl",
    }));
    store.getState().applyObserverEvent(createSessionHistoryEvent({ transcriptPath: "/Users/kih/.claude/projects/project/latest.jsonl" }));

    expect(store.getState().getSessionForWorkspace(workspaceId)).toMatchObject({
      sessionId: "sess_session",
      transcriptPath: "/Users/kih/.claude/projects/project/latest.jsonl",
      receivedSequence: 3,
    });
    expect(store.getState().getSessionForWorkspace(otherWorkspaceId)).toMatchObject({
      sessionId: "sess_other",
      transcriptPath: "/Users/kih/.claude/projects/other/two.jsonl",
      receivedSequence: 2,
    });
  });

  test("observer subscription is idempotent and disposable", () => {
    const bridge = new FakeObserverBridge();
    const store = createHarnessSessionStore(bridge);

    store.getState().startObserverSubscription();
    store.getState().startObserverSubscription();
    bridge.emit(createSessionHistoryEvent({ transcriptPath: "/Users/kih/.claude/projects/project/one.jsonl" }));

    expect(bridge.subscribeCount).toBe(1);
    expect(store.getState().getSessionForWorkspace(workspaceId)?.transcriptPath).toBe(
      "/Users/kih/.claude/projects/project/one.jsonl",
    );

    store.getState().stopObserverSubscription();
    bridge.emit(createSessionHistoryEvent({ transcriptPath: "/Users/kih/.claude/projects/project/two.jsonl" }));

    expect(bridge.disposeCount).toBe(1);
    expect(store.getState().getSessionForWorkspace(workspaceId)?.transcriptPath).toBe(
      "/Users/kih/.claude/projects/project/one.jsonl",
    );
  });
});
