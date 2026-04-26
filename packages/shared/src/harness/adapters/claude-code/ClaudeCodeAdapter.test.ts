import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../contracts/workspace";
import { ClaudeCodeAdapter } from "./ClaudeCodeAdapter";

const workspaceId = "ws_claude" as WorkspaceId;

async function* streamOf(events: unknown[]): AsyncIterable<unknown> {
  for (const event of events) {
    yield event;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("ClaudeCodeAdapter", () => {
  test("observe normalizes mock hook events to TabBadgeEvent observer events", async () => {
    const adapter = new ClaudeCodeAdapter({
      eventStream: streamOf([
        {
          type: "harness/hook",
          workspaceId,
          event: "PreToolUse",
          payload: {
            session_id: "session-1",
            timestamp: "2026-04-26T01:00:00Z",
          },
        },
        {
          type: "harness/hook",
          workspaceId,
          event: "Notification",
          payload: {
            sessionId: "session-1",
            notification_type: "permission_prompt",
            timestamp: "2026-04-26T01:00:01Z",
          },
        },
        {
          type: "harness/hook",
          workspaceId,
          event: "Stop",
          payload: {
            sessionId: "session-1",
            timestamp: "2026-04-26T01:00:02Z",
          },
        },
      ]),
    });

    await expect(collect(adapter.observe(workspaceId))).resolves.toEqual([
      {
        type: "harness/tab-badge",
        state: "running",
        sessionId: "session-1",
        adapterName: "claude-code",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
      },
      {
        type: "harness/tab-badge",
        state: "awaiting-approval",
        sessionId: "session-1",
        adapterName: "claude-code",
        workspaceId,
        timestamp: "2026-04-26T01:00:01Z",
      },
      {
        type: "harness/tab-badge",
        state: "completed",
        sessionId: "session-1",
        adapterName: "claude-code",
        workspaceId,
        timestamp: "2026-04-26T01:00:02Z",
      },
    ]);
  });

  test("observe passes through already-normalized sidecar TabBadgeEvent values", async () => {
    const adapter = new ClaudeCodeAdapter({
      eventStream: streamOf([
        {
          type: "harness/tab-badge",
          state: "running",
          sessionId: "session-normalized",
          adapterName: "claude-code",
          workspaceId,
          timestamp: "2026-04-26T01:00:00Z",
        },
      ]),
    });

    await expect(collect(adapter.observe(workspaceId))).resolves.toEqual([
      {
        type: "harness/tab-badge",
        state: "running",
        sessionId: "session-normalized",
        adapterName: "claude-code",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
      },
    ]);
  });

  test("permission_prompt only and PostToolUse do not rely on debounce inference", async () => {
    const adapter = new ClaudeCodeAdapter({
      eventStream: streamOf([
        {
          event: "PreToolUse",
          sessionId: "session-auto-allowed",
          timestamp: "2026-04-26T01:00:00Z",
        },
        {
          event: "Notification",
          sessionId: "session-auto-allowed",
          notification_type: "tool_use_started",
          timestamp: "2026-04-26T01:00:02Z",
        },
        {
          event: "PostToolUse",
          sessionId: "session-auto-allowed",
          timestamp: "2026-04-26T01:00:03Z",
        },
        {
          event: "Stop",
          sessionId: "session-auto-allowed",
          timestamp: "2026-04-26T01:00:04Z",
        },
      ]),
    });

    await expect(collect(adapter.observe(workspaceId))).resolves.toEqual([
      {
        type: "harness/tab-badge",
        state: "running",
        sessionId: "session-auto-allowed",
        adapterName: "claude-code",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
      },
      {
        type: "harness/tab-badge",
        state: "completed",
        sessionId: "session-auto-allowed",
        adapterName: "claude-code",
        workspaceId,
        timestamp: "2026-04-26T01:00:04Z",
      },
    ]);
    expect(adapter.getLatestSession()).toMatchObject({
      sessionId: "session-auto-allowed",
      timestamp: "2026-04-26T01:00:04Z",
    });
  });

  test("last-event-wins suppresses stale events from older concurrent sessions", async () => {
    const adapter = new ClaudeCodeAdapter({
      eventStream: streamOf([
        {
          event: "PreToolUse",
          sessionId: "session-a",
          timestamp: "2026-04-26T01:00:00Z",
        },
        {
          event: "Notification",
          sessionId: "session-b",
          notification_type: "permission_prompt",
          timestamp: "2026-04-26T01:00:05Z",
        },
        {
          event: "Stop",
          sessionId: "session-a",
          timestamp: "2026-04-26T01:00:02Z",
        },
      ]),
    });

    await expect(collect(adapter.observe(workspaceId))).resolves.toEqual([
      {
        type: "harness/tab-badge",
        state: "running",
        sessionId: "session-a",
        adapterName: "claude-code",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
      },
      {
        type: "harness/tab-badge",
        state: "awaiting-approval",
        sessionId: "session-b",
        adapterName: "claude-code",
        workspaceId,
        timestamp: "2026-04-26T01:00:05Z",
      },
    ]);
    expect(adapter.getLatestSession()).toEqual({
      sessionId: "session-b",
      adapterName: "claude-code",
      workspaceId,
      timestamp: "2026-04-26T01:00:05Z",
      sequence: 2,
    });
    expect(adapter.getLatestSession(workspaceId)?.sessionId).toBe("session-b");
  });

  test("last-event-wins tracking is scoped per workspace", async () => {
    const otherWorkspaceId = "ws_other" as WorkspaceId;
    const adapter = new ClaudeCodeAdapter({
      eventStream: (_requestedWorkspaceId) =>
        streamOf([
          {
            event: "PreToolUse",
            sessionId: "session-other-newer",
            workspaceId: otherWorkspaceId,
            timestamp: "2026-04-26T02:00:00Z",
          },
          {
            event: "PreToolUse",
            sessionId: "session-current-older",
            workspaceId,
            timestamp: "2026-04-26T01:00:00Z",
          },
        ]),
    });

    await expect(collect(adapter.observe(otherWorkspaceId))).resolves.toEqual([
      {
        type: "harness/tab-badge",
        state: "running",
        sessionId: "session-other-newer",
        adapterName: "claude-code",
        workspaceId: otherWorkspaceId,
        timestamp: "2026-04-26T02:00:00Z",
      },
    ]);

    await expect(collect(adapter.observe(workspaceId))).resolves.toEqual([
      {
        type: "harness/tab-badge",
        state: "running",
        sessionId: "session-current-older",
        adapterName: "claude-code",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
      },
    ]);
    expect(adapter.getLatestSession(otherWorkspaceId)?.sessionId).toBe("session-other-newer");
    expect(adapter.getLatestSession(workspaceId)?.sessionId).toBe("session-current-older");
  });

  test("describe returns adapter metadata and dispose is idempotent", async () => {
    let capturedSignal: AbortSignal | undefined;
    const adapter = new ClaudeCodeAdapter({
      eventStream: (_workspaceId, signal) => {
        capturedSignal = signal;
        return streamOf([
          {
            event: "PreToolUse",
            sessionId: "session-disposed",
            timestamp: "2026-04-26T01:00:00Z",
          },
        ]);
      },
    });

    expect(adapter.describe()).toEqual({
      name: "claude-code",
      version: "0.1.0",
      observationPath: "hooks-api",
    });

    adapter.dispose();
    adapter.dispose();
    expect(await collect(adapter.observe(workspaceId))).toEqual([]);

    const activeAdapter = new ClaudeCodeAdapter({
      eventStream: (_workspaceId, signal) => {
        capturedSignal = signal;
        return streamOf([]);
      },
    });
    expect(await collect(activeAdapter.observe(workspaceId))).toEqual([]);
    expect(capturedSignal?.aborted).toBe(false);
    activeAdapter.dispose();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
