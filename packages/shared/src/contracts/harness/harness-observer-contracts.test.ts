import { describe, expect, test } from "bun:test";

import {
  isHarnessObserverEvent,
  isSessionHistoryEvent,
  isTabBadgeEvent,
  isToolCallEvent,
} from "./harness-observer";
import type {
  HarnessObserverEvent,
  SessionHistoryEvent,
  TabBadgeEvent,
  ToolCallEvent,
} from "./harness-observer";

function assertNever(value: never): never {
  throw new Error(`Unhandled harness observer variant: ${JSON.stringify(value)}`);
}

function visitObserverEvent(event: HarnessObserverEvent): HarnessObserverEvent["type"] {
  switch (event.type) {
    case "harness/tab-badge":
      return event.type;
    case "harness/tool-call":
      return event.type;
    case "harness/session-history":
      return event.type;
    default:
      return assertNever(event);
  }
}

type HasTypeDiscriminator<T> = T extends { type: string } ? true : false;

const observerEventHasType: HasTypeDiscriminator<HarnessObserverEvent> = true;

describe("harness observer shared contracts", () => {
  test("observer events keep a discriminated union across badge, tool call, and session variants", () => {
    expect(observerEventHasType).toBe(true);

    const tabBadgeEvent: TabBadgeEvent = {
      type: "harness/tab-badge",
      state: "awaiting-approval",
      sessionId: "sess_001",
      adapterName: "claude-code",
      workspaceId: "ws_alpha",
      timestamp: "2026-04-26T05:15:00.000Z",
    };
    const toolCallEvent: ToolCallEvent = {
      type: "harness/tool-call",
      status: "started",
      toolName: "Read",
      sessionId: "sess_001",
      adapterName: "claude-code",
      workspaceId: "ws_alpha",
      timestamp: "2026-04-26T05:15:01.000Z",
      inputSummary: "file_path: hello.py",
    };
    const sessionHistoryEvent: SessionHistoryEvent = {
      type: "harness/session-history",
      sessionId: "sess_001",
      adapterName: "claude-code",
      workspaceId: "ws_alpha",
      timestamp: "2026-04-26T05:15:02.000Z",
      transcriptPath: "/Users/kih/.claude/projects/ws/sess_001.jsonl",
    };

    expect(visitObserverEvent(tabBadgeEvent)).toBe("harness/tab-badge");
    expect(visitObserverEvent(toolCallEvent)).toBe("harness/tool-call");
    expect(visitObserverEvent(sessionHistoryEvent)).toBe("harness/session-history");
  });

  test("runtime guards accept valid TabBadgeEvent and reject malformed payloads", () => {
    const valid: TabBadgeEvent = {
      type: "harness/tab-badge",
      state: "running",
      sessionId: "sess_001",
      adapterName: "claude-code",
      workspaceId: "ws_alpha",
      timestamp: "2026-04-26T05:15:00.000Z",
    };

    expect(isHarnessObserverEvent(valid)).toBe(true);
    expect(isTabBadgeEvent(valid)).toBe(true);
    expect(isToolCallEvent(valid)).toBe(false);
    expect(isSessionHistoryEvent(valid)).toBe(false);

    expect(
      isHarnessObserverEvent({
        ...valid,
        state: "idle",
      }),
    ).toBe(false);

    expect(
      isHarnessObserverEvent({
        ...valid,
        workspaceId: "",
      }),
    ).toBe(false);

    expect(
      isHarnessObserverEvent({
        ...valid,
        timestamp: "not-an-iso-date",
      }),
    ).toBe(false);

    expect(
      isHarnessObserverEvent({
        ...valid,
        adapterName: undefined,
      }),
    ).toBe(false);
  });

  test("runtime guards accept valid ToolCallEvent and reject malformed payloads", () => {
    const valid: ToolCallEvent = {
      type: "harness/tool-call",
      status: "completed",
      toolName: "Update",
      sessionId: "sess_002",
      adapterName: "claude-code",
      workspaceId: "ws_alpha",
      timestamp: "2026-04-26T05:16:00.000Z",
      toolCallId: "toolu_001",
      inputSummary: "file_path: hello.py",
      resultSummary: "success: true",
    };

    expect(isHarnessObserverEvent(valid)).toBe(true);
    expect(isToolCallEvent(valid)).toBe(true);
    expect(isTabBadgeEvent(valid)).toBe(false);
    expect(isSessionHistoryEvent(valid)).toBe(false);

    expect(
      isHarnessObserverEvent({
        ...valid,
        status: "running",
      }),
    ).toBe(false);

    expect(
      isHarnessObserverEvent({
        ...valid,
        toolName: "",
      }),
    ).toBe(false);

    expect(
      isHarnessObserverEvent({
        ...valid,
        inputSummary: "",
      }),
    ).toBe(false);

    expect(
      isHarnessObserverEvent({
        ...valid,
        rawPayload: { tool_input: { file_path: "hello.py" } },
      }),
    ).toBe(false);
  });

  test("runtime guards accept valid SessionHistoryEvent and reject malformed payloads", () => {
    const valid: SessionHistoryEvent = {
      type: "harness/session-history",
      sessionId: "sess_003",
      adapterName: "claude-code",
      workspaceId: "ws_alpha",
      timestamp: "2026-04-26T05:17:00.000Z",
      transcriptPath: "/Users/kih/.claude/projects/ws/sess_003.jsonl",
    };

    expect(isHarnessObserverEvent(valid)).toBe(true);
    expect(isSessionHistoryEvent(valid)).toBe(true);
    expect(isTabBadgeEvent(valid)).toBe(false);
    expect(isToolCallEvent(valid)).toBe(false);

    expect(
      isHarnessObserverEvent({
        ...valid,
        transcriptPath: "",
      }),
    ).toBe(false);

    expect(
      isHarnessObserverEvent({
        ...valid,
        timestamp: "not-a-date",
      }),
    ).toBe(false);
  });
});
