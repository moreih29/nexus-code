/**
 * portal-fiber-identity — regression guard for ContentHost fiber identity and portal target.
 *
 * DEFECT SCENARIO (T9 fix target)
 * --------------------------------
 * Before T9 fix, ContentHost had a conditional branch:
 *
 *   if (!slotEl) return null;           // fallback branch A
 *   return createPortal(inner, slotEl); // live branch B
 *
 * When slotEl toggled A → null → B (GroupView unmount/remount during split), React
 * saw the component switch between returning null and returning a portal. The fiber
 * inside "inner" was destroyed and recreated on each toggle, unmounting PTY/Monaco.
 *
 * T9 fix: ContentHost always returns createPortal(inner, slotEl ?? hiddenEl).
 * The portal target changes from hiddenEl → slotEl, but the *inner* React subtree
 * is always present and React can reconcile it in place — no unmount/remount.
 *
 * WHY DIRECT FIBER MEASUREMENT IS NOT POSSIBLE HERE
 * --------------------------------------------------
 * bun:test runs without jsdom or happy-dom. Neither ReactDOMClient.createRoot nor
 * react-test-renderer's act() environment is available without a proper DOM shim.
 * Importing happy-dom was removed from this project because it caused test hangs.
 *
 * SURROGATE STRATEGY
 * ------------------
 * We verify the *precondition* that makes fiber identity preservation possible:
 *
 * 1. Registry atomicity: set(A) → set(null) → set(B) produces exactly 3 listener
 *    notifications; get() returns B at the end. ContentHost's useSyncExternalStore
 *    snapshot transitions through (A, null, B) — none is skipped or doubled.
 *
 * 2. Notification count contract: the registry notifies on every meaningful state
 *    change. useSyncExternalStore re-renders ContentHost on each notification. If
 *    the renderer re-renders with the same `inner` React element (same key, same
 *    component type), React preserves the fiber — the test verifies the registry
 *    side of this contract so the renderer side cannot be sabotaged.
 *
 * 3. Portal target swap (T4 absorption): after slot DOM node replacement the
 *    registry holds the new node, not the stale one. ContentHost — reading via
 *    useSyncExternalStore — will receive the new node on next render.
 *
 * 4. closeGroup residue absence (T4 absorption): after leaf removal via
 *    closeGroup, the stale slot registration is cleaned up so get() returns null.
 *    ContentHost falls back to hiddenEl — its inner subtree is still alive inside
 *    hiddenEl, not parked in a detached DOM node.
 *
 * 5. Sequence idempotency guard: the set(A) → set(null) → set(A) (StrictMode
 *    remount) pattern produces exactly 3 notifications and restores the original
 *    element reference — same as test 8 in slot-registry.test.ts, but verified
 *    here in the context of ContentHost's full slot-swap lifecycle simulation.
 *
 * AUTOMATION BOUNDARY
 * -------------------
 * Automated (this file):
 *   - Registry atomicity across slot-swap sequences
 *   - Notification count contract (useSyncExternalStore trigger correctness)
 *   - Portal target update after slot DOM replacement
 *   - Stale registration absence after closeGroup
 *   - Snapshot transition fidelity (every intermediate state observable by ContentHost)
 *
 * Not automated (manual T8 smoke):
 *   - React fiber survival: useEffect mount/unmount counts in TerminalView/EditorView
 *   - PTY and Monaco actual lifecycle (requires browser DevTools or Playwright)
 *   - CSS visibility of the portal content in the correct slot
 *
 * T8 manual smoke covers what this file cannot: actual React reconciler behavior
 * when slotEl toggles. This file ensures the registry contract that drives that
 * reconciler behavior is correct.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shim window.ipc so store modules load without Electron preload.
// Must occur before any store import.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: () => () => {},
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { slotRegistry } from "../../src/renderer/components/workspace/content/slot-registry";
import { allLeaves } from "../../src/renderer/state/stores/layout/helpers";
import { useLayoutStore } from "../../src/renderer/state/stores/layout/store";
import { useTabsStore } from "../../src/renderer/state/stores/tabs";

// ---------------------------------------------------------------------------
// Minimal HTMLElement stand-in
// The registry only stores element references by identity — no DOM API calls.
// ---------------------------------------------------------------------------

class FakeHTMLElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly _label: string;
  constructor(label = "div") {
    this.tagName = "DIV";
    this._label = label;
  }
}

function makeEl(label = "div"): HTMLElement {
  return new FakeHTMLElement(label) as unknown as HTMLElement;
}

// ---------------------------------------------------------------------------
// Per-test cleanup bookkeeping
// ---------------------------------------------------------------------------

let writtenKeys: Array<{ ws: string; leaf: string }> = [];
let disposers: Array<() => void> = [];

function trackedSet(ws: string, leaf: string, el: HTMLElement | null): void {
  if (el !== null) writtenKeys.push({ ws, leaf });
  slotRegistry.set(ws, leaf, el);
}

function trackedSubscribe(listener: () => void): () => void {
  const dispose = slotRegistry.subscribe(listener);
  disposers.push(dispose);
  return dispose;
}

function resetStores(): void {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

beforeEach(() => {
  writtenKeys = [];
  disposers = [];
  resetStores();
});

afterEach(() => {
  for (const d of disposers) {
    d();
  }
  disposers = [];
  for (const { ws, leaf } of writtenKeys) {
    slotRegistry.set(ws, leaf, null);
  }
  writtenKeys = [];
  resetStores();
});

// ---------------------------------------------------------------------------
// Workspace / leaf fixture constants
// ---------------------------------------------------------------------------

const WS = "f1be1d00-f1be-4f1b-e1db-e1dbe1dbe1db";

// ===========================================================================
// Scenario 1 — Registry atomicity: set(A) → set(null) → set(B)
//
// This is the exact slot-swap sequence that occurs when:
//   1. GroupView mounts  → set(ws, leaf, elA)
//   2. GroupView unmounts (split mutation) → set(ws, leaf, null)
//   3. GroupView remounts with new DOM node → set(ws, leaf, elB)
//
// ContentHost subscribes via useSyncExternalStore. It fires a re-render on
// each registry notification. The three transitions must each produce exactly
// one notification so ContentHost sees the correct portal target at every step.
// ===========================================================================

describe("Scenario 1: set(A) → set(null) → set(B) registry atomicity", () => {
  const LEAF = "leaf-s1-0000-0000-0000-000000000000";

  it("get() returns B after the full A → null → B sequence", () => {
    const elA = makeEl("slot-A");
    const elB = makeEl("slot-B");

    trackedSet(WS, LEAF, elA);
    slotRegistry.set(WS, LEAF, null);
    trackedSet(WS, LEAF, elB);

    expect(slotRegistry.get(WS, LEAF)).toBe(elB);
  });

  it("listener receives exactly 3 notifications across the A → null → B sequence", () => {
    const listener = mock(() => {});
    trackedSubscribe(listener);

    const elA = makeEl("slot-A");
    const elB = makeEl("slot-B");

    trackedSet(WS, LEAF, elA); // notification 1: null → A
    slotRegistry.set(WS, LEAF, null); // notification 2: A → null
    trackedSet(WS, LEAF, elB); // notification 3: null → B

    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("snapshot transitions correctly at each step: A, null, B", () => {
    // Simulate useSyncExternalStore: track the snapshot value each time the
    // listener fires. ContentHost reads getSnapshot() on each notification.
    const snapshots: Array<HTMLElement | null> = [];
    const onStoreChange = mock(() => {
      snapshots.push(slotRegistry.get(WS, LEAF));
    });
    trackedSubscribe(onStoreChange);

    const elA = makeEl("slot-A");
    const elB = makeEl("slot-B");

    trackedSet(WS, LEAF, elA);
    slotRegistry.set(WS, LEAF, null);
    trackedSet(WS, LEAF, elB);

    // Three notifications, each with the correct snapshot value
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toBe(elA); // after set(A): ContentHost targets elA
    expect(snapshots[1]).toBeNull(); // after set(null): ContentHost targets hiddenEl
    expect(snapshots[2]).toBe(elB); // after set(B): ContentHost targets elB
  });

  it("inner React element is portal-target-independent: get() changes but registry identity is stable per call", () => {
    // This verifies that get(ws, leaf) returns a reference-stable value each call
    // (same reference for the same current state). ContentHost's getSnapshot
    // uses slotRegistry.get() and useSyncExternalStore requires getSnapshot to
    // return the same reference across calls when the store has not changed.
    const elA = makeEl("slot-A");
    trackedSet(WS, LEAF, elA);

    const snap1 = slotRegistry.get(WS, LEAF);
    const snap2 = slotRegistry.get(WS, LEAF);

    // Two consecutive calls with no intervening set → same reference
    expect(snap1).toBe(snap2);
    expect(snap1).toBe(elA);
  });

  it("no spurious extra notification when set() is called with the same element after A → null → A", () => {
    // StrictMode scenario: React fires ref callbacks el → null → el.
    // After the full cycle the registry holds el, and a re-set of el
    // (idempotent guard) must NOT produce a 4th notification.
    const listener = mock(() => {});
    trackedSubscribe(listener);

    const elA = makeEl("slot-A");

    trackedSet(WS, LEAF, elA); // notification 1
    slotRegistry.set(WS, LEAF, null); // notification 2
    trackedSet(WS, LEAF, elA); // notification 3: null→A (not idempotent — was deleted)
    slotRegistry.set(WS, LEAF, elA); // idempotent: same ref already in map → NO notification

    expect(listener).toHaveBeenCalledTimes(3);
    expect(slotRegistry.get(WS, LEAF)).toBe(elA);
  });
});

// ===========================================================================
// Scenario 2 — Portal target swap: slot DOM node replacement after split mutation
// (T4 portal-dom-ancestry absorption)
//
// When a split mutation causes GroupView to remount with a new DOM node, the
// registry must hold the NEW node (not the stale pre-mutation node). This is
// the precondition for ContentHost to portal into the correct live node.
// ===========================================================================

describe("Scenario 2: portal target swap after slot DOM node replacement (T4 absorption)", () => {
  const LEAF = "leaf-s2-0000-0000-0000-000000000000";

  it("registry holds new node after slot DOM node replacement (unmount → remount with new element)", () => {
    const elOld = makeEl("old-slot");
    const elNew = makeEl("new-slot");

    // GroupView mounts: registers old node
    trackedSet(WS, LEAF, elOld);
    expect(slotRegistry.get(WS, LEAF)).toBe(elOld);

    // Split mutation: GroupView unmounts (clears old), remounts (registers new)
    slotRegistry.set(WS, LEAF, null);
    trackedSet(WS, LEAF, elNew);

    // ContentHost's next render reads elNew — not the stale elOld
    expect(slotRegistry.get(WS, LEAF)).toBe(elNew);
    expect(slotRegistry.get(WS, LEAF)).not.toBe(elOld);
  });

  it("old node is no longer accessible via registry after replacement", () => {
    const elOld = makeEl("old-slot");
    const elNew = makeEl("new-slot");

    trackedSet(WS, LEAF, elOld);
    slotRegistry.set(WS, LEAF, null);
    trackedSet(WS, LEAF, elNew);

    // Verify the stale node is completely gone from the registry's perspective.
    // ContentHost cannot accidentally retrieve it.
    const retrieved = slotRegistry.get(WS, LEAF);
    expect(retrieved).not.toBe(elOld);
    expect(retrieved).toBe(elNew);
  });

  it("ContentHost subscription receives notification when portal target changes to new slot", () => {
    // Mirrors ContentHost's useSyncExternalStore subscription.
    // On the notification, ContentHost reads getSnapshot() and re-renders with
    // the new portal target.
    const elOld = makeEl("old-slot");
    const elNew = makeEl("new-slot");

    trackedSet(WS, LEAF, elOld); // initial mount

    let latestSnapshot: HTMLElement | null = slotRegistry.get(WS, LEAF);
    const onStoreChange = mock(() => {
      latestSnapshot = slotRegistry.get(WS, LEAF);
    });
    trackedSubscribe(onStoreChange);

    // Slot DOM replacement
    slotRegistry.set(WS, LEAF, null); // unmount
    trackedSet(WS, LEAF, elNew); // remount with new node

    // Two notifications: null-clear + new-node-set
    expect(onStoreChange).toHaveBeenCalledTimes(2);
    // After second notification ContentHost snapshot is the new element
    expect(latestSnapshot).toBe(elNew);
  });

  it("split scenario: store-driven splitGroup replaces rightLeafId slot and registry updates", () => {
    // Full store-level regression: after splitGroup the old slot is unregistered
    // and the new slot registration is picked up correctly.
    useLayoutStore.getState().ensureLayout(WS);
    const layout = useLayoutStore.getState().byWorkspace[WS];
    if (!layout) throw new Error("layout not found");

    const initialLeafId = layout.activeGroupId;

    // GroupView mounts for the initial single leaf
    const elInitial = makeEl("initial-slot");
    trackedSet(WS, initialLeafId, elInitial);

    // Split: produces a new right leaf
    const rightLeafId = useLayoutStore
      .getState()
      .splitGroup(WS, initialLeafId, "horizontal", "after");

    // Simulate GroupView unmount of initialLeaf, remount of both (worst-case split)
    const elOldLeft = slotRegistry.get(WS, initialLeafId);
    if (elOldLeft) slotRegistry.set(WS, initialLeafId, null);
    const elNewLeft = makeEl("new-left-slot");
    trackedSet(WS, initialLeafId, elNewLeft);
    const elRight = makeEl("right-slot");
    trackedSet(WS, rightLeafId, elRight);

    // Both slots now live in registry with new elements
    expect(slotRegistry.get(WS, initialLeafId)).toBe(elNewLeft);
    expect(slotRegistry.get(WS, rightLeafId)).toBe(elRight);

    // Layout has exactly 2 leaves
    const updatedLayout = useLayoutStore.getState().byWorkspace[WS];
    if (!updatedLayout) throw new Error("layout not found after split");
    expect(allLeaves(updatedLayout.root).length).toBe(2);
  });
});

// ===========================================================================
// Scenario 3 — closeGroup residue absence (T4 absorption)
//
// After a leaf is removed via closeGroup (or via detachTab that hoists), the
// slot registration for that leaf must be cleaned up. ContentHost should not
// find a stale registration pointing at a detached DOM node.
//
// In production, GroupView's useCallback ref fires with null on unmount —
// exactly slotRegistry.set(ws, leafId, null). We verify the post-cleanup state.
// ===========================================================================

describe("Scenario 3: closeGroup — no stale slot registration after leaf removal (T4 absorption)", () => {
  it("after closeGroup simulation, removed leaf's slot registration is null", () => {
    const LEAF_LEFT = "leaf-s3-left-0000-0000-000000000000";
    const LEAF_RIGHT = "leaf-s3-right-000-0000-000000000000";

    // Both leaves mount and register slots
    const elLeft = makeEl("left-slot");
    const elRight = makeEl("right-slot");
    trackedSet(WS, LEAF_LEFT, elLeft);
    trackedSet(WS, LEAF_RIGHT, elRight);

    // Simulate closeGroup: GroupView for LEAF_RIGHT unmounts → slot ref fires null
    slotRegistry.set(WS, LEAF_RIGHT, null);

    // Stale registration is gone — ContentHost cannot portal into detached node
    expect(slotRegistry.get(WS, LEAF_RIGHT)).toBeNull();

    // Left leaf is unaffected
    expect(slotRegistry.get(WS, LEAF_LEFT)).toBe(elLeft);
  });

  it("closeGroup via store + simulated GroupView unmount leaves only surviving leaf registered", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const layout = useLayoutStore.getState().byWorkspace[WS];
    if (!layout) throw new Error("layout not found");

    const leafAId = layout.activeGroupId;
    const tab1 = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/ws" } });
    useLayoutStore.getState().attachTab(WS, leafAId, tab1.id);

    // Horizontal split → leafA | leafB
    const leafBId = useLayoutStore.getState().splitGroup(WS, leafAId, "horizontal", "after");
    const tab2 = useTabsStore
      .getState()
      .createTab(WS, { type: "terminal", props: { cwd: "/ws2" } });
    useLayoutStore.getState().attachTab(WS, leafBId, tab2.id);

    // Both GroupViews mount their slots
    const elA = makeEl("leafA-slot");
    const elB = makeEl("leafB-slot");
    trackedSet(WS, leafAId, elA);
    trackedSet(WS, leafBId, elB);

    // Close group B via store
    useLayoutStore.getState().closeGroup(WS, leafBId);

    // Simulate GroupView unmount for leafB (its DOM is removed from layout tree)
    slotRegistry.set(WS, leafBId, null);

    // leafB slot must be null — no stale registration that ContentHost could portal into
    expect(slotRegistry.get(WS, leafBId)).toBeNull();

    // leafA slot remains live
    expect(slotRegistry.get(WS, leafAId)).toBe(elA);

    // Layout collapsed to single leaf
    const updatedLayout = useLayoutStore.getState().byWorkspace[WS];
    if (!updatedLayout) throw new Error("layout not found after closeGroup");
    expect(allLeaves(updatedLayout.root).length).toBe(1);
  });

  it("closeGroup notification fires so ContentHost re-renders away from stale target", () => {
    const LEAF_TO_CLOSE = "leaf-s3-close-000-0000-000000000000";
    const LEAF_SURVIVOR = "leaf-s3-surv-0000-0000-000000000000";

    const elClose = makeEl("closing-slot");
    const elSurv = makeEl("surviving-slot");
    trackedSet(WS, LEAF_TO_CLOSE, elClose);
    trackedSet(WS, LEAF_SURVIVOR, elSurv);

    // Subscribe (simulates ContentHost's useSyncExternalStore subscription)
    let callCount = 0;
    const listener = mock(() => {
      callCount++;
    });
    trackedSubscribe(listener);

    // GroupView unmount fires null (closeGroup cleanup)
    slotRegistry.set(WS, LEAF_TO_CLOSE, null);

    // Notification fired: ContentHost for the closed leaf re-renders,
    // gets null from getSnapshot(), falls back to hiddenEl (no stale portal)
    expect(listener).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(1);
    expect(slotRegistry.get(WS, LEAF_TO_CLOSE)).toBeNull();
  });
});

// ===========================================================================
// Scenario 4 — Fiber identity surrogate: getSnapshot reference stability
//
// useSyncExternalStore contract: getSnapshot must return the same reference
// on consecutive calls when the store has not changed. If it returns a new
// reference each call, React will warn and may schedule extra re-renders that
// could disrupt fiber continuity.
//
// We verify that slotRegistry.get() is referentially stable between
// notifications — i.e., two consecutive calls without an intervening set()
// return Object.is equal values.
// ===========================================================================

describe("Scenario 4: getSnapshot reference stability (useSyncExternalStore contract)", () => {
  const LEAF = "leaf-s4-0000-0000-0000-000000000000";

  it("get() returns the same reference on consecutive calls when no set() occurred", () => {
    const el = makeEl("stable-slot");
    trackedSet(WS, LEAF, el);

    const r1 = slotRegistry.get(WS, LEAF);
    const r2 = slotRegistry.get(WS, LEAF);
    const r3 = slotRegistry.get(WS, LEAF);

    expect(Object.is(r1, r2)).toBe(true);
    expect(Object.is(r2, r3)).toBe(true);
    expect(r1).toBe(el);
  });

  it("get() returns null consistently when key is absent (null is Object.is stable)", () => {
    // No element registered for this leaf
    const r1 = slotRegistry.get(WS, LEAF);
    const r2 = slotRegistry.get(WS, LEAF);

    expect(r1).toBeNull();
    expect(Object.is(r1, r2)).toBe(true);
  });

  it("get() after set(null) returns null stably — fallback to hiddenEl is stable", () => {
    const el = makeEl("transient-slot");
    trackedSet(WS, LEAF, el);
    slotRegistry.set(WS, LEAF, null); // simulate GroupView unmount

    const r1 = slotRegistry.get(WS, LEAF);
    const r2 = slotRegistry.get(WS, LEAF);

    expect(r1).toBeNull();
    expect(Object.is(r1, r2)).toBe(true);
  });

  it("after set(B) following set(A) → set(null), get() returns B stably", () => {
    const elA = makeEl("slot-A");
    const elB = makeEl("slot-B");

    trackedSet(WS, LEAF, elA);
    slotRegistry.set(WS, LEAF, null);
    trackedSet(WS, LEAF, elB);

    const r1 = slotRegistry.get(WS, LEAF);
    const r2 = slotRegistry.get(WS, LEAF);

    expect(Object.is(r1, r2)).toBe(true);
    expect(r1).toBe(elB);
  });
});

// ===========================================================================
// Scenario 5 — Multi-leaf split: each leaf has a unique stable portal target
//
// After a two-step split (horizontal then vertical), three leaves must each
// have a distinct, stably-retrievable slot element. This is the precondition
// for ContentHost to portal each tab's content into the correct leaf slot
// without cross-leaf contamination.
// ===========================================================================

describe("Scenario 5: multi-leaf split — each leaf has a distinct stable portal target", () => {
  it("3-leaf split produces 3 distinct slot elements, each stable across consecutive reads", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const layout = useLayoutStore.getState().byWorkspace[WS];
    if (!layout) throw new Error("layout not found");

    const leftId = layout.activeGroupId;
    const rightId = useLayoutStore.getState().splitGroup(WS, leftId, "horizontal", "after");
    const bottomId = useLayoutStore.getState().splitGroup(WS, rightId, "vertical", "after");

    // All three GroupViews mount their slot divs
    const elLeft = makeEl("left");
    const elRight = makeEl("right-top");
    const elBottom = makeEl("right-bottom");
    trackedSet(WS, leftId, elLeft);
    trackedSet(WS, rightId, elRight);
    trackedSet(WS, bottomId, elBottom);

    // Each leaf has its correct element
    expect(slotRegistry.get(WS, leftId)).toBe(elLeft);
    expect(slotRegistry.get(WS, rightId)).toBe(elRight);
    expect(slotRegistry.get(WS, bottomId)).toBe(elBottom);

    // Elements are distinct — no aliasing between leaves
    expect(elLeft).not.toBe(elRight);
    expect(elRight).not.toBe(elBottom);
    expect(elLeft).not.toBe(elBottom);

    // Reference stability: two consecutive reads return the same object
    expect(slotRegistry.get(WS, leftId)).toBe(slotRegistry.get(WS, leftId));
    expect(slotRegistry.get(WS, rightId)).toBe(slotRegistry.get(WS, rightId));
    expect(slotRegistry.get(WS, bottomId)).toBe(slotRegistry.get(WS, bottomId));
  });

  it("closing one leaf in a 3-leaf split removes only that leaf's slot registration", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const layout = useLayoutStore.getState().byWorkspace[WS];
    if (!layout) throw new Error("layout not found");

    const leftId = layout.activeGroupId;
    const tab1 = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/" } });
    useLayoutStore.getState().attachTab(WS, leftId, tab1.id);

    const rightId = useLayoutStore.getState().splitGroup(WS, leftId, "horizontal", "after");
    const tab2 = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/b" } });
    useLayoutStore.getState().attachTab(WS, rightId, tab2.id);

    const bottomId = useLayoutStore.getState().splitGroup(WS, rightId, "vertical", "after");
    const tab3 = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/c" } });
    useLayoutStore.getState().attachTab(WS, bottomId, tab3.id);

    const elLeft = makeEl("left");
    const elRight = makeEl("right-top");
    const elBottom = makeEl("right-bottom");
    trackedSet(WS, leftId, elLeft);
    trackedSet(WS, rightId, elRight);
    trackedSet(WS, bottomId, elBottom);

    // Close the bottom leaf and simulate GroupView unmount
    useLayoutStore.getState().closeGroup(WS, bottomId);
    slotRegistry.set(WS, bottomId, null); // GroupView unmount fires

    // Closed leaf is unregistered
    expect(slotRegistry.get(WS, bottomId)).toBeNull();
    // Surviving leaves are unaffected
    expect(slotRegistry.get(WS, leftId)).toBe(elLeft);
    expect(slotRegistry.get(WS, rightId)).toBe(elRight);
  });
});

// ===========================================================================
// Scenario 6 — T9 fix contract: portal always has a target (hiddenEl fallback)
//
// The T9 fix ensures ContentHost always returns createPortal(inner, target)
// where target = slotEl ?? hiddenEl. This test verifies the registry side:
// slotEl is null only when the leaf has no registration, which is exactly
// when ContentHost should use hiddenEl. We verify the null→element→null
// lifecycle produces the correct target sequence at each step.
// ===========================================================================

describe("Scenario 6: T9 fix contract — portal target is never undefined (hiddenEl fallback)", () => {
  const LEAF = "leaf-s6-0000-0000-0000-000000000000";

  it("before GroupView mount: slotEl is null → ContentHost targets hiddenEl", () => {
    // No slot registered yet (ContentPool renders before GroupView commits)
    const slotEl = slotRegistry.get(WS, LEAF);
    // ContentHost: target = slotEl ?? hiddenEl → hiddenEl
    expect(slotEl).toBeNull();
    // (hiddenEl is managed by ContentPool; we only verify slotEl is null here)
  });

  it("after GroupView mount: slotEl is non-null → ContentHost targets slotEl", () => {
    const el = makeEl("slot");
    trackedSet(WS, LEAF, el);

    const slotEl = slotRegistry.get(WS, LEAF);
    expect(slotEl).not.toBeNull();
    expect(slotEl).toBe(el);
    // ContentHost: target = slotEl ?? hiddenEl → slotEl
  });

  it("during split (GroupView unmounted): slotEl is null → ContentHost falls back to hiddenEl", () => {
    const el = makeEl("slot");
    trackedSet(WS, LEAF, el);

    // GroupView unmounts during split mutation
    slotRegistry.set(WS, LEAF, null);

    const slotEl = slotRegistry.get(WS, LEAF);
    expect(slotEl).toBeNull();
    // ContentHost: target = slotEl ?? hiddenEl → hiddenEl
    // Inner subtree is ALIVE inside hiddenEl — no destroy/recreate
  });

  it("after GroupView remounts with new node: slotEl points to new node", () => {
    const elOld = makeEl("old");
    trackedSet(WS, LEAF, elOld);

    slotRegistry.set(WS, LEAF, null); // unmount

    const elNew = makeEl("new");
    trackedSet(WS, LEAF, elNew); // remount

    const slotEl = slotRegistry.get(WS, LEAF);
    expect(slotEl).toBe(elNew);
    expect(slotEl).not.toBe(elOld);
    // ContentHost: target = slotEl ?? hiddenEl → elNew (the live node)
  });

  it("target sequence across full split lifecycle: hiddenEl → slotEl → hiddenEl → newSlotEl", () => {
    // Simulate the useSyncExternalStore snapshot for ContentHost over a split lifecycle.
    // At each step: ContentHost reads target = get(ws, leaf) ?? hiddenEl.
    // We verify the registry's contribution (get() values) — hiddenEl is constant.
    const hiddenEl = makeEl("hidden"); // stand-in for ContentPool's hidden div

    const snapshots: Array<HTMLElement> = [];
    const onStoreChange = mock(() => {
      const slotEl = slotRegistry.get(WS, LEAF);
      snapshots.push(slotEl ?? hiddenEl); // mirrors ContentHost's target computation
    });
    trackedSubscribe(onStoreChange);

    // ContentPool renders before GroupView: initial snapshot is hiddenEl (no registry change yet)
    // (We do not call set here — no notification. Snapshot is read on first render.)
    const initial = slotRegistry.get(WS, LEAF) ?? hiddenEl;
    expect(initial).toBe(hiddenEl); // initial state: no slot → hiddenEl

    const elA = makeEl("slot-A");
    trackedSet(WS, LEAF, elA); // GroupView mounts → target becomes elA

    slotRegistry.set(WS, LEAF, null); // split mutation unmount → target becomes hiddenEl

    const elB = makeEl("slot-B");
    trackedSet(WS, LEAF, elB); // GroupView remounts with new node → target becomes elB

    expect(onStoreChange).toHaveBeenCalledTimes(3);
    expect(snapshots[0]).toBe(elA); // after first set: portal to slot
    expect(snapshots[1]).toBe(hiddenEl); // during split: portal to hidden (fiber alive)
    expect(snapshots[2]).toBe(elB); // after remount: portal to new slot
  });
});
