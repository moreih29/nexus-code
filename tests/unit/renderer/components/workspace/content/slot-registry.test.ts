/**
 * slot-registry — external contract unit tests
 *
 * Verifies the public API of slotRegistry:
 *
 *   slotRegistry.set(workspaceId, leafId, el | null): void
 *   slotRegistry.get(workspaceId, leafId): HTMLElement | null
 *   slotRegistry.subscribe(listener: () => void): () => void  // disposer
 *
 * Test cases:
 *   1. set + get: same (workspaceId, leafId) returns the stored element
 *   2. namespacing: different workspaceId → same leafId → isolated values
 *   3. null set: entry deletion → get returns null
 *   4. subscribe: listener called on set and on null-clear
 *   5. idempotent set: same element re-set → listener called only once
 *   6. unsubscribe: disposer stops notifications
 *   7. reference stability: repeated get() returns the same value in every state
 *   8. StrictMode double-mount simulation: (el → null → el) sequence preserves final element
 *
 * DOM note:
 *   bun:test has no jsdom environment by default. The registry only stores element
 *   references by identity — it never calls DOM methods — so lightweight
 *   HTMLElement stand-ins suffice.
 *
 * Isolation strategy:
 *   The registry is a module-level singleton Map. Each test uses a unique
 *   (workspaceId, leafId) key pair to prevent cross-test interference. All
 *   subscriptions are disposed and all set slots are cleared in afterEach
 *   via per-test disposer references stored in an array.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { slotRegistry } from "../../../../../../src/renderer/components/workspace/content/slot-registry";

// ---------------------------------------------------------------------------
// Minimal HTMLElement stand-in
// The registry only does identity comparison and Map storage — no DOM API calls.
// ---------------------------------------------------------------------------

class FakeHTMLElement {
  readonly nodeType = 1;
  readonly tagName: string;
  constructor(tagName = "DIV") {
    this.tagName = tagName;
  }
}

function makeEl(tagName = "DIV"): HTMLElement {
  return new FakeHTMLElement(tagName) as unknown as HTMLElement;
}

// ---------------------------------------------------------------------------
// Per-test cleanup bookkeeping
// ---------------------------------------------------------------------------

/** All (ws, leaf) pairs written during a test — cleared in afterEach. */
let writtenKeys: Array<{ ws: string; leaf: string }> = [];
/** All subscription disposers created during a test — called in afterEach. */
let disposers: Array<() => void> = [];

function trackedSet(ws: string, leaf: string, el: HTMLElement | null): void {
  if (el !== null) {
    writtenKeys.push({ ws, leaf });
  }
  slotRegistry.set(ws, leaf, el);
}

function trackedSubscribe(listener: () => void): () => void {
  const dispose = slotRegistry.subscribe(listener);
  disposers.push(dispose);
  return dispose;
}

beforeEach(() => {
  writtenKeys = [];
  disposers = [];
});

afterEach(() => {
  // Unsubscribe all listeners before clearing slots so no spurious notifications
  for (const d of disposers) {
    d();
  }
  disposers = [];
  // Clear all slots written during the test
  for (const { ws, leaf } of writtenKeys) {
    slotRegistry.set(ws, leaf, null);
  }
  writtenKeys = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("slotRegistry", () => {
  // 1 -----------------------------------------------------------------------
  it("set + get: 같은 (workspaceId, leafId)에 element를 set하면 get이 같은 element 반환", () => {
    const el = makeEl();
    trackedSet("ws1", "leafA", el);

    expect(slotRegistry.get("ws1", "leafA")).toBe(el);
  });

  // 2 -----------------------------------------------------------------------
  it("namespacing: 다른 workspaceId는 같은 leafId라도 격리", () => {
    const el1 = makeEl();
    const el2 = makeEl();
    trackedSet("ws1", "leafA", el1);
    trackedSet("ws2", "leafA", el2);

    expect(slotRegistry.get("ws1", "leafA")).toBe(el1);
    expect(slotRegistry.get("ws2", "leafA")).toBe(el2);
  });

  // 3 -----------------------------------------------------------------------
  it("null set: entry 삭제 후 get은 null", () => {
    const el = makeEl();
    trackedSet("ws3", "leafA", el);
    slotRegistry.set("ws3", "leafA", null);

    expect(slotRegistry.get("ws3", "leafA")).toBeNull();
  });

  // 4 -----------------------------------------------------------------------
  it("subscribe 알림: listener가 set/clear 시점에 호출됨", () => {
    const listener = mock(() => {});
    trackedSubscribe(listener);

    const el = makeEl();
    trackedSet("ws4", "leafA", el);
    expect(listener).toHaveBeenCalledTimes(1);

    slotRegistry.set("ws4", "leafA", null);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // 5 -----------------------------------------------------------------------
  it("idempotent set (StrictMode 보호): 동일 element 재set 시 listener 1회만", () => {
    const listener = mock(() => {});
    trackedSubscribe(listener);

    const el = makeEl();
    trackedSet("ws5", "leafA", el);
    trackedSet("ws5", "leafA", el); // exact same reference — must be skipped

    expect(listener).toHaveBeenCalledTimes(1);
  });

  // 6 -----------------------------------------------------------------------
  it("unsubscribe: disposer 호출 후엔 listener 미호출", () => {
    const listener = mock(() => {});
    const dispose = trackedSubscribe(listener);

    dispose(); // unsubscribe immediately (afterEach will also call it, idempotent)

    const el = makeEl();
    trackedSet("ws6", "leafA", el);

    expect(listener).not.toHaveBeenCalled();
  });

  // 7 -----------------------------------------------------------------------
  // useSyncExternalStore 계약: getSnapshot은 store 상태가 변하지 않으면 동일
  // 참조를 반환해야 한다. 아래 한 케이스로 모든 상태(element / 미등록 / set(null)
  // 후)에서의 참조 안정성을 통합 검증한다.
  it("getSnapshot 참조 안정성: 모든 상태에서 연속 get()이 Object.is 동일", () => {
    const WS = "ws-ref-stability";
    const LEAF_PRESENT = "leaf-present";
    const LEAF_ABSENT = "leaf-absent";
    const el = makeEl();

    // (1) element가 등록된 경우: 연속 get()이 같은 참조
    trackedSet(WS, LEAF_PRESENT, el);
    const r1 = slotRegistry.get(WS, LEAF_PRESENT);
    const r2 = slotRegistry.get(WS, LEAF_PRESENT);
    const r3 = slotRegistry.get(WS, LEAF_PRESENT);
    expect(Object.is(r1, r2)).toBe(true);
    expect(Object.is(r2, r3)).toBe(true);
    expect(r1).toBe(el);

    // (2) key가 미등록인 경우: 연속 get()이 null로 안정
    const a1 = slotRegistry.get(WS, LEAF_ABSENT);
    const a2 = slotRegistry.get(WS, LEAF_ABSENT);
    expect(a1).toBeNull();
    expect(Object.is(a1, a2)).toBe(true);

    // (3) set(null)로 entry를 지운 후: 연속 get()이 null로 안정
    slotRegistry.set(WS, LEAF_PRESENT, null);
    const n1 = slotRegistry.get(WS, LEAF_PRESENT);
    const n2 = slotRegistry.get(WS, LEAF_PRESENT);
    expect(n1).toBeNull();
    expect(Object.is(n1, n2)).toBe(true);
  });

  // 8 -----------------------------------------------------------------------
  it("StrictMode 이중 마운트 시뮬레이션: (el → null → el) 시퀀스 후 최종 상태 element 보유", () => {
    const WS = "ws8";
    const LEAF = "leaf8";
    const el = makeEl();
    const listener = mock(() => {});
    trackedSubscribe(listener);

    // StrictMode React calls ref callbacks: el → null → el
    trackedSet(WS, LEAF, el); // mount #1: ref receives el
    slotRegistry.set(WS, LEAF, null); // unmount #1: ref receives null (strict cleanup)
    trackedSet(WS, LEAF, el); // mount #2: ref receives el again

    // Final registry state must hold the element
    expect(slotRegistry.get(WS, LEAF)).toBe(el);

    // Listener call count analysis:
    //   set(el)   → el !== undefined in map → notify → count 1
    //   set(null) → key existed → delete + notify → count 2
    //   set(el)   → el not in map (was deleted) → notify → count 3
    // Total: 3 notifications (idempotent guard only skips same-reference re-set,
    // not a re-set after a null-clear)
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("slotRegistry — notification order and workspace scoping", () => {
  it("listener reads the new value on every change: A → null → B", () => {
    const WS = "ws-snapshot-order";
    const LEAF = "leaf-snapshot-order";
    const elA = makeEl();
    const elB = makeEl();
    // ContentHost's useSyncExternalStore reads get() inside the notification,
    // so the map must already hold the new value when listeners run.
    const snapshots: Array<HTMLElement | null> = [];
    trackedSubscribe(() => {
      snapshots.push(slotRegistry.get(WS, LEAF));
    });

    trackedSet(WS, LEAF, elA);
    slotRegistry.set(WS, LEAF, null);
    trackedSet(WS, LEAF, elB);

    expect(snapshots).toEqual([elA, null, elB]);
  });

  it("clearing one workspace's slot leaves another workspace's same leafId intact", () => {
    const el1 = makeEl();
    const el2 = makeEl();
    trackedSet("ws-clear-1", "leaf-shared", el1);
    trackedSet("ws-clear-2", "leaf-shared", el2);

    slotRegistry.set("ws-clear-2", "leaf-shared", null);

    expect(slotRegistry.get("ws-clear-1", "leaf-shared")).toBe(el1);
    expect(slotRegistry.get("ws-clear-2", "leaf-shared")).toBeNull();
  });
});
