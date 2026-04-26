import { describe, expect, test } from "bun:test";

import { isHarnessObserverEvent, isTabBadgeEvent } from "./harness-observer";
import type { HarnessObserverEvent, TabBadgeEvent } from "./harness-observer";

function assertNever(value: never): never {
  throw new Error(`Unhandled harness observer variant: ${JSON.stringify(value)}`);
}

function visitObserverEvent(event: HarnessObserverEvent): HarnessObserverEvent["type"] {
  switch (event.type) {
    case "harness/tab-badge":
      return event.type;
    default:
      return assertNever(event);
  }
}

type HasTypeDiscriminator<T> = T extends { type: string } ? true : false;

const observerEventHasType: HasTypeDiscriminator<HarnessObserverEvent> = true;

describe("harness observer shared contracts", () => {
  test("TabBadgeEvent remains the only concrete observer event for this cycle", () => {
    expect(observerEventHasType).toBe(true);

    const event: TabBadgeEvent = {
      type: "harness/tab-badge",
      state: "awaiting-approval",
      sessionId: "sess_001",
      adapterName: "claude-code",
      workspaceId: "ws_alpha",
      timestamp: "2026-04-26T05:15:00.000Z",
    };

    expect(visitObserverEvent(event)).toBe("harness/tab-badge");
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
});
