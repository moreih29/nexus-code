// ---------------------------------------------------------------------------
// View park — off-screen DOM home for portal targets whose owning workspace
// is not currently active.
//
// Why this exists:
//   slot-registry resolves "where should this view be visible?" — the leaf
//   slot of the owning workspace. But when a workspace is inactive, its
//   panel sits in the DOM as a sibling of the active panel (CSS-hidden via
//   `visibility:hidden`) so PTY/editor instances survive the switch. Some
//   GPU-composited content — most notably xterm's WebGL canvas — does not
//   reliably honor `visibility:hidden` on an ancestor: the GPU layer keeps
//   compositing and bleeds through at the same screen pixels as the active
//   workspace's slot in the same layout position.
//
//   The fix is structural rather than CSS-based: park inactive workspaces'
//   portal targets in a single hidden node that lives OUTSIDE every
//   WorkspacePanel. That node is 0×0, contained, and visibility:hidden,
//   so any composited content inside it has no visible region.
//
// Pairing:
//   - slot-registry  → positive resolution (leafId → visible DOM slot)
//   - view-park      → negative resolution (parking when no slot applies)
//
// Both are DOM registries consumed by ContentHost via useSyncExternalStore.
// ---------------------------------------------------------------------------

import { useCallback } from "react";
import { useSyncExternalStore } from "react";

let parkEl: HTMLElement | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export const viewPark: {
  set(el: HTMLElement | null): void;
  get(): HTMLElement | null;
  subscribe(listener: () => void): () => void;
} = {
  set(el) {
    if (parkEl === el) return;
    parkEl = el;
    notify();
  },
  get() {
    return parkEl;
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

const getServerSnapshot = (): HTMLElement | null => null;

export function useViewPark(): HTMLElement | null {
  return useSyncExternalStore(viewPark.subscribe, viewPark.get, getServerSnapshot);
}

// ---------------------------------------------------------------------------
// ViewParkRoot — mount once at App level, OUTSIDE every WorkspacePanel.
//
// Style notes:
//   - position: fixed + 0×0 → no layout impact, independent of workspace flow
//   - visibility: hidden    → CSS-paint suppression for plain DOM children
//   - overflow: hidden      → clips any descendant that ignores visibility
//   - contain: strict       → layout/paint/style isolation; helps the
//                             compositor de-promote inner GPU layers
//   - inert + aria-hidden   → no focus / a11y reachability while parked
// ---------------------------------------------------------------------------

export function ViewParkRoot(): React.JSX.Element {
  const ref = useCallback((el: HTMLDivElement | null) => {
    viewPark.set(el);
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden
      inert
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        overflow: "hidden",
        visibility: "hidden",
        pointerEvents: "none",
        contain: "strict",
      }}
    />
  );
}
