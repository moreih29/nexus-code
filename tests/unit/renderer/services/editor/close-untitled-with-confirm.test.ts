/**
 * Regression guard for closeUntitledWithConfirm's dirty-check call path.
 *
 * History: an early version keyed the untitled dirty check with
 * `cacheUriFor(workspaceId, "Untitled-N")`, but `cacheUriFor` →
 * `workspaceUriFor` requires an absolute path and THROWS on the
 * "Untitled-N" display name. That made every untitled-tab close (X button,
 * ⌘W, context-menu) throw at runtime and the tab never closed.
 *
 * The fix keys it with `untitledCacheUriFor(workspaceId, untitledIndex)`
 * (the same `untitled://` scheme the model cache registers under). This test
 * exercises the not-dirty path end-to-end so a revert to `cacheUriFor` would
 * make the call throw and fail here.
 */

import { describe, expect, it } from "bun:test";
import { closeUntitledWithConfirm } from "../../../../../src/renderer/services/editor/save/close-handler";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const WS = "11111111-1111-1111-1111-111111111111";

function seedUntitledTab(tabId: string, untitledIndex: number): void {
  useTabsStore.setState((state) => ({
    byWorkspace: {
      ...state.byWorkspace,
      [WS]: {
        ...state.byWorkspace[WS],
        [tabId]: {
          id: tabId,
          type: "untitled",
          title: `Untitled-${untitledIndex}`,
          props: { untitledIndex },
        },
      },
    },
  }));
}

describe("closeUntitledWithConfirm — not-dirty path", () => {
  it("closes a clean untitled tab without throwing and removes it from the store", async () => {
    const tabId = "tab-untitled-1";
    seedUntitledTab(tabId, 1);
    expect(useTabsStore.getState().byWorkspace[WS]?.[tabId]).toBeDefined();

    // A freshly-opened untitled buffer has no dirty edits, so this takes the
    // discard branch — which first calls isDirty(untitledCacheUriFor(...)).
    // The previous bug threw here; the fix must resolve cleanly to "closed".
    const outcome = await closeUntitledWithConfirm(WS, tabId);

    expect(outcome).toBe("closed");
    expect(useTabsStore.getState().byWorkspace[WS]?.[tabId]).toBeUndefined();
  });

  it("returns 'closed' for an unknown tab id (no-op safety)", async () => {
    expect(await closeUntitledWithConfirm(WS, "does-not-exist")).toBe("closed");
  });
});
