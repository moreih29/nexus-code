/**
 * Integration: slot-registry hydration — hydrate() → slotRegistry population
 *
 * SCOPE
 * -----
 * Verifies that after layoutStore.hydrate() the slot registry reaches a state
 * where every leaf resulting from hydration can be registered (slotEl !== null).
 *
 * Architecture of the flow under test:
 *   1. layoutStore.hydrate(ws, snapshot, knownTabIds)
 *      → sanitizes dangling tabs, collapses empty leaves, writes byWorkspace[ws]
 *   2. React renders WorkspacePanel → LayoutTree → GroupView per leaf
 *      GroupView's useCallback ref fires: slotRegistry.set(ws, leaf.id, el)
 *   3. ContentHost reads useSlotElement(ws, ownerLeafId) → slotEl !== null
 *      → createPortal(inner, slotEl) — content is visible in the right slot
 *
 * TEST ENVIRONMENT CONSTRAINT
 * ---------------------------
 * bun:test has no jsdom / DOM environment. Neither @testing-library/react nor
 * a real React renderer is available. This file tests the store ↔ registry
 * contract by:
 *   a) Running the real layoutStore.hydrate() to produce the canonical leaf tree
 *   b) Simulating GroupView's ref callback by calling slotRegistry.set() for
 *      each leaf — exactly what the component does on mount
 *   c) Asserting ContentHost's useSlotElement contract (registry.get returns the
 *      same element) using subscription-simulation, matching the pattern in
 *      slot-registry.test.ts
 *
 * This is an equivalent-coverage strategy: the component is a thin pass-through
 * (useCallback ref → slotRegistry.set); what matters is the store contract, the
 * sanitize result, and the registry API — all testable without a real renderer.
 *
 * AUTOMATION BOUNDARIES
 * ---------------------
 * Automated: hydrate → leaf tree correctness, simulated ref → registry, ContentHost
 *   slot contract, multi-workspace isolation, sanitize → surviving leaf registration
 * Not automated: CSS portal visibility, React Strict-Mode double-mount effects,
 *   actual DOM containment (requires jsdom/browser)
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shim window.ipc so store modules load without DOM / Electron preload.
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
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import { ownerLeafIdOf } from "../../src/renderer/components/workspace/content/selectors";
import { slotRegistry } from "../../src/renderer/components/workspace/content/slot-registry";
import { useLayoutStore } from "../../src/renderer/state/stores/layout";
import { allLeaves } from "../../src/renderer/state/stores/layout/helpers";
import type { LayoutLeaf, LayoutNode } from "../../src/renderer/state/stores/layout/types";
import { useTabsStore } from "../../src/renderer/state/stores/tabs";

// ---------------------------------------------------------------------------
// Minimal HTMLElement stand-in — mirrors the approach in slot-registry.test.ts.
// The registry stores references by identity only, never calls DOM methods.
// ---------------------------------------------------------------------------

class FakeHTMLElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly children: FakeHTMLElement[] = [];

  constructor(tagName = "DIV") {
    this.tagName = tagName;
  }

  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.children.some((c) => c.contains(other));
  }
}

function makeEl(tagName = "DIV"): HTMLElement {
  return new FakeHTMLElement(tagName) as unknown as HTMLElement;
}

// ---------------------------------------------------------------------------
// Test-scoped cleanup helpers
// ---------------------------------------------------------------------------

const WS_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

/** All (ws, leaf) pairs written to the registry during a test. */
let writtenSlots: Array<{ ws: string; leaf: string }> = [];
/** All subscription disposers created during a test. */
let disposers: Array<() => void> = [];

function trackedSlotSet(ws: string, leaf: string, el: HTMLElement | null): void {
  if (el !== null) writtenSlots.push({ ws, leaf });
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

/**
 * Simulate what GroupView's useCallback ref does on mount:
 * for each leaf in the hydrated layout, create a fake element and register it.
 * Returns a map of leafId → FakeHTMLElement for assertions.
 */
function simulateMountSlots(ws: string): Map<string, HTMLElement> {
  const layout = useLayoutStore.getState().byWorkspace[ws];
  if (!layout) return new Map();

  const registered = new Map<string, HTMLElement>();
  for (const leaf of allLeaves(layout.root)) {
    const el = makeEl();
    trackedSlotSet(ws, leaf.id, el);
    registered.set(leaf.id, el);
  }
  return registered;
}

beforeEach(() => {
  writtenSlots = [];
  disposers = [];
  resetStores();
});

afterEach(() => {
  for (const d of disposers) {
    d();
  }
  disposers = [];
  for (const { ws, leaf } of writtenSlots) {
    slotRegistry.set(ws, leaf, null);
  }
  writtenSlots = [];
  resetStores();
});

// ---------------------------------------------------------------------------
// Scenario 1 — single leaf hydrate: all leaf slots registered after first commit
// ---------------------------------------------------------------------------

describe("Scenario 1: 단일 워크스페이스 hydrate 후 첫 commit에 모든 leaf의 slot이 registry에 등록됨", () => {
  it("단일 leaf snapshot hydrate → 해당 leafId로 slotRegistry.get이 non-null element 반환", () => {
    const leafId = "11111111-1111-4111-b111-111111111111";
    const tabId = "t1111111-1111-4111-b111-111111111111";

    const snapshot = {
      root: {
        kind: "leaf" as const,
        id: leafId,
        tabIds: [tabId],
        activeTabId: tabId,
      } satisfies LayoutLeaf,
      activeGroupId: leafId,
    };

    useLayoutStore.getState().hydrate(WS_A, snapshot, new Set([tabId]));

    // Verify hydrate produced the expected layout
    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    expect(layout).toBeDefined();
    expect(layout!.root.kind).toBe("leaf");
    expect(layout!.root.id).toBe(leafId);

    // Simulate GroupView ref callback — what React would do on first commit
    const registered = simulateMountSlots(WS_A);

    // ContentHost's useSlotElement contract: slotRegistry.get returns the element
    const slotEl = slotRegistry.get(WS_A, leafId);
    expect(slotEl).not.toBeNull();
    expect(slotEl).toBe(registered.get(leafId));
  });

  it("slot 등록 시 subscribe listener가 호출됨 (useSyncExternalStore 알림 계약)", () => {
    const leafId = "12121212-1212-4121-b121-121212121212";
    const tabId = "t2121212-1212-4121-b121-121212121212";

    const snapshot = {
      root: {
        kind: "leaf" as const,
        id: leafId,
        tabIds: [tabId],
        activeTabId: tabId,
      } satisfies LayoutLeaf,
      activeGroupId: leafId,
    };

    useLayoutStore.getState().hydrate(WS_A, snapshot, new Set([tabId]));

    const listener = mock(() => {});
    trackedSubscribe(listener);

    simulateMountSlots(WS_A);

    // Listener fires once per leaf registered
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — split tree snapshot hydrate: all leaves registered
// ---------------------------------------------------------------------------

describe("Scenario 2: split 트리 snapshot hydrate — 모든 leaf의 slot 등록 완료", () => {
  it("2-leaf 수평 split snapshot hydrate → 두 leafId 모두 registry에 등록됨", () => {
    const leafAId = "22222222-2222-4222-b222-222222222222";
    const leafBId = "23232323-2323-4232-b232-232323232323";
    const tabAId = "ta222222-2222-4222-b222-222222222222";
    const tabBId = "tb232323-2323-4232-b232-232323232323";

    const snapshot = {
      root: {
        kind: "split" as const,
        id: "sp222222-2222-4222-b222-222222222222",
        orientation: "horizontal" as const,
        ratio: 0.5,
        first: {
          kind: "leaf" as const,
          id: leafAId,
          tabIds: [tabAId],
          activeTabId: tabAId,
        } satisfies LayoutLeaf,
        second: {
          kind: "leaf" as const,
          id: leafBId,
          tabIds: [tabBId],
          activeTabId: tabBId,
        } satisfies LayoutLeaf,
      } satisfies LayoutNode,
      activeGroupId: leafAId,
    };

    useLayoutStore.getState().hydrate(WS_A, snapshot, new Set([tabAId, tabBId]));

    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    expect(layout!.root.kind).toBe("split");

    const leaves = allLeaves(layout!.root);
    expect(leaves.length).toBe(2);

    // Simulate GroupView mount for all leaves
    const registered = simulateMountSlots(WS_A);

    // Every leaf must be registered in the slot registry
    for (const leaf of leaves) {
      const slotEl = slotRegistry.get(WS_A, leaf.id);
      expect(slotEl).not.toBeNull();
      expect(slotEl).toBe(registered.get(leaf.id));
    }
  });

  it("3-leaf 트리 (nested split) hydrate → 모든 leaf slot 등록", () => {
    const leaf1Id = "31313131-3131-4313-b313-313131313131";
    const leaf2Id = "32323232-3232-4323-b323-323232323232";
    const leaf3Id = "33333333-3333-4333-b333-333333333333";
    const tab1Id = "t1313131-3131-4313-b313-313131313131";
    const tab2Id = "t2323232-3232-4323-b323-323232323232";
    const tab3Id = "t3333333-3333-4333-b333-333333333333";

    // Tree: split(leaf1, split(leaf2, leaf3))
    const snapshot = {
      root: {
        kind: "split" as const,
        id: "sp313131-3131-4313-b313-313131313131",
        orientation: "horizontal" as const,
        ratio: 0.5,
        first: {
          kind: "leaf" as const,
          id: leaf1Id,
          tabIds: [tab1Id],
          activeTabId: tab1Id,
        } satisfies LayoutLeaf,
        second: {
          kind: "split" as const,
          id: "sp323232-3232-4323-b323-323232323232",
          orientation: "vertical" as const,
          ratio: 0.5,
          first: {
            kind: "leaf" as const,
            id: leaf2Id,
            tabIds: [tab2Id],
            activeTabId: tab2Id,
          } satisfies LayoutLeaf,
          second: {
            kind: "leaf" as const,
            id: leaf3Id,
            tabIds: [tab3Id],
            activeTabId: tab3Id,
          } satisfies LayoutLeaf,
        } satisfies LayoutNode,
      } satisfies LayoutNode,
      activeGroupId: leaf1Id,
    };

    useLayoutStore.getState().hydrate(WS_A, snapshot, new Set([tab1Id, tab2Id, tab3Id]));

    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    const leaves = allLeaves(layout!.root);
    expect(leaves.length).toBe(3);

    const registered = simulateMountSlots(WS_A);

    for (const leaf of leaves) {
      expect(slotRegistry.get(WS_A, leaf.id)).not.toBeNull();
      expect(slotRegistry.get(WS_A, leaf.id)).toBe(registered.get(leaf.id));
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — ContentHost portal target: slot element is the portal container
// ---------------------------------------------------------------------------

describe("Scenario 3: ContentHost들이 첫 commit에 portal target 보유 (또는 fallback null state 통과)", () => {
  it("slot 등록 전 ContentHost는 null slotEl로 fallback container에 render됨", () => {
    const leafId = "44444444-4444-4444-b444-444444444444";
    const tabId = "t4444444-4444-4444-b444-444444444444";

    const snapshot = {
      root: {
        kind: "leaf" as const,
        id: leafId,
        tabIds: [tabId],
        activeTabId: tabId,
      } satisfies LayoutLeaf,
      activeGroupId: leafId,
    };

    useLayoutStore.getState().hydrate(WS_A, snapshot, new Set([tabId]));

    // Before GroupView mounts: registry is empty — ContentHost renders fallback
    const slotElBefore = slotRegistry.get(WS_A, leafId);
    expect(slotElBefore).toBeNull(); // fallback: invisible 0×0 container

    // After GroupView mounts: registry is populated — ContentHost portals correctly
    const registered = simulateMountSlots(WS_A);
    const slotElAfter = slotRegistry.get(WS_A, leafId);
    expect(slotElAfter).not.toBeNull();
    expect(slotElAfter).toBe(registered.get(leafId));
  });

  it("slot element가 설정되면 tab의 ownerLeafId로 ContentHost가 portal 대상을 찾을 수 있음", () => {
    const leafId = "45454545-4545-4545-b454-454545454545";
    const tabId = "t5454545-4545-4545-b454-454545454545";

    const snapshot = {
      root: {
        kind: "leaf" as const,
        id: leafId,
        tabIds: [tabId],
        activeTabId: tabId,
      } satisfies LayoutLeaf,
      activeGroupId: leafId,
    };

    useLayoutStore.getState().hydrate(WS_A, snapshot, new Set([tabId]));
    simulateMountSlots(WS_A);

    const layout = useLayoutStore.getState().byWorkspace[WS_A];

    // ownerLeafIdOf mirrors ContentPool/ContentHost logic
    const ownerLeafId = ownerLeafIdOf(layout!.root, tabId);
    expect(ownerLeafId).toBe(leafId);

    // ContentHost calls useSlotElement(ws, ownerLeafId) → should find element
    const slotEl = slotRegistry.get(WS_A, ownerLeafId!);
    expect(slotEl).not.toBeNull();
  });

  it("slot 설정 후 subscribe listener가 즉시 호출되어 ContentHost re-render 트리거됨", () => {
    const leafId = "46464646-4646-4646-b464-464646464646";
    const tabId = "t6464646-4646-4646-b464-464646464646";

    const snapshot = {
      root: {
        kind: "leaf" as const,
        id: leafId,
        tabIds: [tabId],
        activeTabId: tabId,
      } satisfies LayoutLeaf,
      activeGroupId: leafId,
    };

    useLayoutStore.getState().hydrate(WS_A, snapshot, new Set([tabId]));

    // Simulate useSyncExternalStore subscription (ContentHost subscribing)
    let capturedSnapshot: HTMLElement | null = slotRegistry.get(WS_A, leafId);
    const onStoreChange = mock(() => {
      capturedSnapshot = slotRegistry.get(WS_A, leafId);
    });
    trackedSubscribe(onStoreChange);

    // Before GroupView mount: null
    expect(capturedSnapshot).toBeNull();
    expect(onStoreChange).not.toHaveBeenCalled();

    // GroupView mounts — slot ref fires
    simulateMountSlots(WS_A);

    // Listener was called exactly once (first commit slot registration)
    expect(onStoreChange).toHaveBeenCalledTimes(1);
    // Snapshot now holds the element — ContentHost re-renders with portal
    expect(capturedSnapshot).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — dual workspace hydrate: both active and inactive register slots
// ---------------------------------------------------------------------------

describe("Scenario 4: 비활성 워크스페이스 동시 hydrate 시에도 동일하게 등록", () => {
  it("active + inactive 두 워크스페이스 모두 hydrate 후 각 leaf slot 등록 완료", () => {
    const leafActiveId = "55555555-5555-4555-b555-555555555555";
    const tabActiveId = "ta555555-5555-4555-b555-555555555555";

    const leafInactiveId = "56565656-5656-4565-b565-565656565656";
    const tabInactiveId = "ti565656-5656-4565-b565-565656565656";

    // Hydrate active workspace
    useLayoutStore.getState().hydrate(
      WS_A,
      {
        root: {
          kind: "leaf" as const,
          id: leafActiveId,
          tabIds: [tabActiveId],
          activeTabId: tabActiveId,
        } satisfies LayoutLeaf,
        activeGroupId: leafActiveId,
      },
      new Set([tabActiveId]),
    );

    // Hydrate inactive workspace (WS_B)
    useLayoutStore.getState().hydrate(
      WS_B,
      {
        root: {
          kind: "leaf" as const,
          id: leafInactiveId,
          tabIds: [tabInactiveId],
          activeTabId: tabInactiveId,
        } satisfies LayoutLeaf,
        activeGroupId: leafInactiveId,
      },
      new Set([tabInactiveId]),
    );

    // Both layouts must exist in the store
    expect(useLayoutStore.getState().byWorkspace[WS_A]).toBeDefined();
    expect(useLayoutStore.getState().byWorkspace[WS_B]).toBeDefined();

    // Simulate both WorkspacePanels mounting (both are kept alive in CSS-hidden mode)
    const registeredA = simulateMountSlots(WS_A);
    const registeredB = simulateMountSlots(WS_B);

    // Active workspace slot registered
    expect(slotRegistry.get(WS_A, leafActiveId)).not.toBeNull();
    expect(slotRegistry.get(WS_A, leafActiveId)).toBe(registeredA.get(leafActiveId));

    // Inactive workspace slot registered (panels stay mounted for PTY survival)
    expect(slotRegistry.get(WS_B, leafInactiveId)).not.toBeNull();
    expect(slotRegistry.get(WS_B, leafInactiveId)).toBe(registeredB.get(leafInactiveId));
  });

  it("두 워크스페이스의 slot은 격리됨 — 같은 leafId 이름이라도 서로 영향 없음", () => {
    // Use the same leaf id string for both workspaces to test namespacing
    const sharedLeafId = "57575757-5757-4575-b757-575757575757";
    const tabIdForA = "ta575757-5757-4575-b757-575757575757";
    const tabIdForB = "tb575757-5757-4575-b757-575757575757";

    useLayoutStore.getState().hydrate(
      WS_A,
      {
        root: {
          kind: "leaf" as const,
          id: sharedLeafId,
          tabIds: [tabIdForA],
          activeTabId: tabIdForA,
        } satisfies LayoutLeaf,
        activeGroupId: sharedLeafId,
      },
      new Set([tabIdForA]),
    );

    useLayoutStore.getState().hydrate(
      WS_B,
      {
        root: {
          kind: "leaf" as const,
          id: sharedLeafId,
          tabIds: [tabIdForB],
          activeTabId: tabIdForB,
        } satisfies LayoutLeaf,
        activeGroupId: sharedLeafId,
      },
      new Set([tabIdForB]),
    );

    const elForA = makeEl();
    const elForB = makeEl();
    trackedSlotSet(WS_A, sharedLeafId, elForA);
    trackedSlotSet(WS_B, sharedLeafId, elForB);

    // Each workspace has its own element
    expect(slotRegistry.get(WS_A, sharedLeafId)).toBe(elForA);
    expect(slotRegistry.get(WS_B, sharedLeafId)).toBe(elForB);
    // They are distinct
    expect(elForA).not.toBe(elForB);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — sanitize hoisting: dangling tabs stripped, survivors registered
// ---------------------------------------------------------------------------

describe("Scenario 5: sanitize 결과 hoisted된 leaf id로 registry 등록", () => {
  it("dangling tabIds 포함 split snapshot → stripDanglingTabs + collapseEmptyLeaves 후 살아남은 leaf로 등록", () => {
    const goodLeafId = "66666666-6666-4666-b666-666666666666";
    const emptyLeafId = "67676767-6767-4676-b676-676767676767";
    const goodTabId = "tg666666-6666-4666-b666-666666666666";
    const danglingTabId = "td676767-6767-4676-b676-676767676767"; // not in knownTabIds

    // Snapshot: split with one good leaf and one leaf whose only tab is dangling
    const snapshot = {
      root: {
        kind: "split" as const,
        id: "sp666666-6666-4666-b666-666666666666",
        orientation: "horizontal" as const,
        ratio: 0.5,
        first: {
          kind: "leaf" as const,
          id: goodLeafId,
          tabIds: [goodTabId],
          activeTabId: goodTabId,
        } satisfies LayoutLeaf,
        second: {
          kind: "leaf" as const,
          id: emptyLeafId,
          tabIds: [danglingTabId],
          activeTabId: danglingTabId,
        } satisfies LayoutLeaf,
      } satisfies LayoutNode,
      activeGroupId: goodLeafId,
    };

    // Only goodTabId is known — danglingTabId gets stripped
    useLayoutStore.getState().hydrate(WS_A, snapshot, new Set([goodTabId]));

    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    expect(layout).toBeDefined();

    // After sanitize: emptyLeaf (now tab-less) is hoisted away → root is sole leaf
    expect(layout!.root.kind).toBe("leaf");
    expect(layout!.root.id).toBe(goodLeafId);

    const leaves = allLeaves(layout!.root);
    expect(leaves.length).toBe(1);
    expect(leaves[0]!.id).toBe(goodLeafId);

    // The dangling leaf id must NOT be in the tree
    expect(leaves.some((l) => l.id === emptyLeafId)).toBe(false);

    // Simulate GroupView mount for surviving leaf only
    const registered = simulateMountSlots(WS_A);

    // Surviving leaf is registered
    expect(slotRegistry.get(WS_A, goodLeafId)).not.toBeNull();
    expect(slotRegistry.get(WS_A, goodLeafId)).toBe(registered.get(goodLeafId));

    // Dangling (now non-existent) leaf has no slot
    expect(slotRegistry.get(WS_A, emptyLeafId)).toBeNull();
  });

  it("full sanitize 후 단일 빈 leaf: sole leaf로 보존되고 root leaf id로 slot 등록", () => {
    const soleLeafId = "68686868-6868-4686-b868-686868686868";
    const danglingTabId = "td686868-6868-4686-b868-686868686868";

    // Single leaf with only a dangling tab — after strip it becomes an empty sole leaf
    const snapshot = {
      root: {
        kind: "leaf" as const,
        id: soleLeafId,
        tabIds: [danglingTabId],
        activeTabId: danglingTabId,
      } satisfies LayoutLeaf,
      activeGroupId: soleLeafId,
    };

    // No known tabs → tabIds stripped to empty; sole leaf must be preserved (not hoisted)
    useLayoutStore.getState().hydrate(WS_A, snapshot, new Set<string>());

    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    expect(layout!.root.kind).toBe("leaf");
    expect(layout!.root.id).toBe(soleLeafId);

    const registered = simulateMountSlots(WS_A);
    expect(slotRegistry.get(WS_A, soleLeafId)).not.toBeNull();
    expect(slotRegistry.get(WS_A, soleLeafId)).toBe(registered.get(soleLeafId));
  });

  it("모든 tab이 dangling인 2-leaf split → 두 leaf 모두 empty → 두 번째 leaf가 hoist되어 첫번째만 남음", () => {
    const leaf1Id = "69696969-6969-4696-b969-696969696969";
    const leaf2Id = "6a6a6a6a-6a6a-4a6a-ba6a-6a6a6a6a6a6a";
    const dangle1 = "td696969-6969-4696-b969-696969696969";
    const dangle2 = "td6a6a6a-6a6a-4a6a-ba6a-6a6a6a6a6a6a";

    const snapshot = {
      root: {
        kind: "split" as const,
        id: "sp696969-6969-4696-b969-696969696969",
        orientation: "vertical" as const,
        ratio: 0.5,
        first: {
          kind: "leaf" as const,
          id: leaf1Id,
          tabIds: [dangle1],
          activeTabId: dangle1,
        } satisfies LayoutLeaf,
        second: {
          kind: "leaf" as const,
          id: leaf2Id,
          tabIds: [dangle2],
          activeTabId: dangle2,
        } satisfies LayoutLeaf,
      } satisfies LayoutNode,
      activeGroupId: leaf1Id,
    };

    // No known tabs → both leaves become empty; collapseEmptyLeaves keeps only one
    useLayoutStore.getState().hydrate(WS_A, snapshot, new Set<string>());

    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    // After collapsing both empty leaves from a 2-leaf split, exactly one sole leaf remains
    const survivingLeaves = allLeaves(layout!.root);
    expect(survivingLeaves.length).toBe(1);

    // The surviving leaf is registered
    const survivingLeafId = survivingLeaves[0]!.id;
    const registered = simulateMountSlots(WS_A);
    expect(slotRegistry.get(WS_A, survivingLeafId)).not.toBeNull();
    expect(slotRegistry.get(WS_A, survivingLeafId)).toBe(registered.get(survivingLeafId));
  });
});
