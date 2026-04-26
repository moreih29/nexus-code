import { describe, expect, test } from "bun:test";

import type { HarnessObserverEvent } from "../../../shared/src/contracts/harness-observer";
import { HarnessNotificationService } from "./harness-notification-service";

describe("HarnessNotificationService", () => {
  test("notifies for approval, completion and error events", () => {
    const shown: Array<{ title: string; body: string }> = [];
    const service = new HarnessNotificationService({
      isSupported: () => true,
      createNotification: (payload) => ({
        show: () => shown.push(payload),
      }),
    });

    for (const event of [
      toolEvent("awaiting-approval", "2026-04-26T00:00:00.000Z"),
      badgeEvent("completed", "2026-04-26T00:00:01.000Z"),
      toolEvent("error", "2026-04-26T00:00:02.000Z"),
    ] satisfies HarnessObserverEvent[]) {
      service.handleObserverEvent(event);
    }

    expect(shown).toEqual([
      {
        title: "Claude Code approval needed",
        body: "Edit is waiting for approval.",
      },
      {
        title: "Claude Code turn completed",
        body: "Claude Code finished the current turn.",
      },
      {
        title: "Claude Code observer error",
        body: "Edit failed or reported an error.",
      },
    ]);
  });

  test("deduplicates repeated event keys", () => {
    let showCount = 0;
    const service = new HarnessNotificationService({
      isSupported: () => true,
      createNotification: () => ({
        show: () => {
          showCount += 1;
        },
      }),
    });
    const event = toolEvent("awaiting-approval", "2026-04-26T00:00:00.000Z");

    service.handleObserverEvent(event);
    service.handleObserverEvent({ ...event });

    expect(showCount).toBe(1);
  });

  test("no-ops when notifications are unsupported or event is not a trigger", () => {
    let showCount = 0;
    const service = new HarnessNotificationService({
      isSupported: () => false,
      createNotification: () => ({
        show: () => {
          showCount += 1;
        },
      }),
    });

    service.handleObserverEvent(toolEvent("running", "2026-04-26T00:00:00.000Z"));
    service.handleObserverEvent(toolEvent("awaiting-approval", "2026-04-26T00:00:01.000Z"));

    expect(showCount).toBe(0);
  });
});

function toolEvent(
  status: "running" | "awaiting-approval" | "completed" | "error",
  timestamp: string,
): HarnessObserverEvent {
  return {
    type: "harness/tool-call",
    workspaceId: "ws_alpha",
    adapterName: "claude-code",
    sessionId: "sess_alpha",
    status,
    toolName: "Edit",
    timestamp,
  };
}

function badgeEvent(
  state: "running" | "awaiting-approval" | "completed" | "error",
  timestamp: string,
): HarnessObserverEvent {
  return {
    type: "harness/tab-badge",
    workspaceId: "ws_alpha",
    adapterName: "claude-code",
    sessionId: "sess_alpha",
    state,
    timestamp,
  };
}
