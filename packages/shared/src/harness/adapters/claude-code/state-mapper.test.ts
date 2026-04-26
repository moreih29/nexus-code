import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../contracts/workspace";
import {
  mapClaudeCodeHookEventToTabBadgeEvent,
  normalizeClaudeCodeHookEvent,
  tabBadgeStateForClaudeCodeHook,
} from "./state-mapper";

const workspaceId = "ws_claude" as WorkspaceId;
const fixedNow = new Date("2026-04-26T01:02:03.004Z");

describe("Claude Code state mapper", () => {
  test("maps hook-like inputs to the four tab badge states", () => {
    const scenarios = [
      { event: "PreToolUse", state: "running" },
      {
        event: "Notification",
        notification_type: "permission_prompt",
        state: "awaiting-approval",
      },
      { event: "Stop", state: "completed" },
      { event: "StopFailure", state: "error" },
    ] as const;

    for (const scenario of scenarios) {
      const event = mapClaudeCodeHookEventToTabBadgeEvent(
        {
          type: "harness/hook",
          workspaceId,
          event: scenario.event,
          payload: {
            session_id: `session-${scenario.state}`,
            adapterName: "claude-code",
            timestamp: "2026-04-26T00:00:00Z",
            notification_type: "notification_type" in scenario ? scenario.notification_type : undefined,
          },
        },
        { workspaceId, now: () => fixedNow },
      );

      expect(event).toEqual({
        type: "harness/tab-badge",
        state: scenario.state,
        sessionId: `session-${scenario.state}`,
        adapterName: "claude-code",
        workspaceId,
        timestamp: "2026-04-26T00:00:00Z",
      });
    }
  });

  test("awaiting approval requires Notification.notification_type exactly permission_prompt", () => {
    expect(
      mapClaudeCodeHookEventToTabBadgeEvent(
        {
          event: "Notification",
          sessionId: "s-approval",
          notification_type: "permission_prompt",
        },
        { workspaceId },
      )?.state,
    ).toBe("awaiting-approval");

    for (const notificationType of ["permissionPrompt", "tool_use", "idle", "Permission_Prompt", undefined]) {
      expect(
        mapClaudeCodeHookEventToTabBadgeEvent(
          {
            event: "Notification",
            sessionId: "s-not-approval",
            notification_type: notificationType,
          },
          { workspaceId },
        ),
      ).toBeUndefined();
    }
  });

  test("PostToolUse is non-emitting while error fields take precedence", () => {
    expect(
      mapClaudeCodeHookEventToTabBadgeEvent(
        {
          event: "PostToolUse",
          sessionId: "s-tool-done",
        },
        { workspaceId, now: () => fixedNow },
      ),
    ).toBeUndefined();

    expect(
      tabBadgeStateForClaudeCodeHook({
        eventName: "PreToolUse",
        hasError: true,
      }),
    ).toBe("error");
  });

  test("normalizes sidecar wire payload aliases and default adapter name", () => {
    const normalized = normalizeClaudeCodeHookEvent(
      {
        type: "harness/hook",
        workspace_id: workspaceId,
        event: "pre_tool_use",
        payload: JSON.stringify({
          session_id: "session-1",
          timestamp: "2026-04-26T01:02:03.000000004Z",
        }),
      },
      { workspaceId, now: () => fixedNow },
    );

    expect(normalized).toMatchObject({
      eventName: "pre_tool_use",
      workspaceId,
      sessionId: "session-1",
      adapterName: "claude-code",
      timestamp: "2026-04-26T01:02:03.000000004Z",
    });
  });

  test("suppresses events for a different workspace", () => {
    expect(
      mapClaudeCodeHookEventToTabBadgeEvent(
        {
          workspaceId: "ws_other",
          event: "PreToolUse",
          sessionId: "s-other",
        },
        { workspaceId },
      ),
    ).toBeUndefined();
  });
});
