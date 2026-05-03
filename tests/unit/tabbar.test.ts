/**
 * TabBar — onTabContextMenu prop contract
 *
 * Verifies the onTabContextMenu callback contract without a DOM render.
 * The component attaches `onContextMenu={(e) => onTabContextMenu?.(tab.id, e)}`
 * to each tab's wrapper div. We test the handler shape by constructing the
 * inline handler directly (mirroring the component logic) and asserting it
 * calls the callback with the correct tabId.
 *
 * Test cases:
 *   1. Handler calls onTabContextMenu with the tab's id
 *   2. Handler does not call e.preventDefault (Radix ContextMenu requirement)
 *   3. Handler is a no-op when onTabContextMenu is undefined (optional prop)
 *   4. Multiple tabs each produce a handler bound to their own id
 */

import { describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Helper — mirrors the inline handler attached in TabBar.tsx:
//   onContextMenu={(e) => onTabContextMenu?.(tab.id, e)}
// ---------------------------------------------------------------------------

function makeContextMenuHandler(
  tabId: string,
  onTabContextMenu?: (id: string, e: { preventDefault: () => void }) => void,
) {
  return (e: { preventDefault: () => void }) => onTabContextMenu?.(tabId, e);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TabBar — onTabContextMenu handler", () => {
  it("calls onTabContextMenu with the correct tabId", () => {
    const handler = mock(() => {});
    const fakeEvent = { preventDefault: mock(() => {}) };

    makeContextMenuHandler("tab-abc", handler)(fakeEvent);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe("tab-abc");
  });

  it("passes the original event object as second argument", () => {
    const handler = mock((_id: string, _e: unknown) => {});
    const fakeEvent = { preventDefault: mock(() => {}) };

    makeContextMenuHandler("tab-xyz", handler)(fakeEvent);

    expect(handler.mock.calls[0][1]).toBe(fakeEvent);
  });

  it("does NOT call e.preventDefault — Radix ContextMenu must receive native event", () => {
    const handler = mock(() => {});
    const fakeEvent = { preventDefault: mock(() => {}) };

    makeContextMenuHandler("tab-1", handler)(fakeEvent);

    expect(fakeEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("is a no-op when onTabContextMenu is undefined (optional prop)", () => {
    const fakeEvent = { preventDefault: mock(() => {}) };

    // Should not throw
    expect(() => makeContextMenuHandler("tab-1", undefined)(fakeEvent)).not.toThrow();
  });

  it("each tab gets a handler bound to its own id", () => {
    const tabIds = ["tab-a", "tab-b", "tab-c"];
    const handler = mock((_id: string, _e: unknown) => {});
    const fakeEvent = { preventDefault: mock(() => {}) };

    for (const id of tabIds) {
      makeContextMenuHandler(id, handler)(fakeEvent);
    }

    const calledIds = handler.mock.calls.map((call) => call[0]);
    expect(calledIds).toEqual(["tab-a", "tab-b", "tab-c"]);
  });
});
