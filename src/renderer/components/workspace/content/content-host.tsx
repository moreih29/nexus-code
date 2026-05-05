import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Tab } from "@/state/stores/tabs";
import { EditorView } from "./editor-view";
import { useSlotElement } from "./slot-registry";
import { TerminalView } from "./terminal-view";
import { useViewPark } from "./view-park";

interface ContentHostProps {
  workspaceId: string;
  tab: Tab;
  ownerLeafId: string | null;
  isActiveTab: boolean;
  isWorkspaceActive: boolean;
}

/**
 * createPortal target lifecycle.
 *
 * Earlier versions passed `slotEl ?? hiddenEl` directly to createPortal.
 * That worked for the EditorView, but caused TerminalView to lose its
 * xterm renderer state on every tab move: when createPortal's target DOM
 * node changes, React unmounts the children at the old portal and mounts
 * them at the new portal — the entire TerminalController is disposed and
 * recreated, the line buffer is gone, and the user sees a blank terminal
 * until the next byte arrives from the PTY.
 *
 * Fix (mirrors VSCode's view-container pattern): each ContentHost owns a
 * stable per-tab `<div>` for the lifetime of the tab. createPortal always
 * targets that stable element — so the React subtree is never unmounted
 * during a tab move. We then imperatively appendChild the stable element
 * into the current parent (slot or view park) whenever the parent
 * changes. The DOM moves; the React tree does not.
 *
 * Parent selection — single rule, leaf-aware:
 *   visible = isWorkspaceActive AND isActiveTab
 *     → slot when registered, transient park otherwise
 *   not visible (inactive workspace OR inactive tab in active workspace)
 *     → view park
 *
 * Why route inactive *tabs* (not just inactive workspaces) to the park:
 * each tab's portalTarget is `position:absolute; inset:0` over the same
 * leaf slot. If we kept all of a leaf's tabs' portalTargets stacked in
 * the slot — relying on inner CSS (`invisible pointer-events-none`) to
 * hide non-active ones — the topmost portalTarget would still intercept
 * pointer events because its own box has `pointer-events: auto` and an
 * empty parent box absorbs any event whose target child has
 * `pointer-events: none`. Result: clicks/scroll meant for the active
 * editor get swallowed by whichever portalTarget happens to be last in
 * DOM order (typically the most-recently-opened tab in the leaf).
 *
 * Routing inactive tabs to the park makes the slot's invariant strict:
 * AT MOST ONE portalTarget lives in any slot at a time — the active
 * tab's. Stacking conflicts become structurally impossible, and the same
 * mechanism also resolves the cross-leaf GPU canvas leak (xterm WebGL
 * not honoring ancestor `visibility:hidden`) at the leaf level — which
 * the workspace-only park previously handled only across workspaces.
 *
 * Pairing with slot-registry:
 *   slot-registry  → positive resolution (where to show what's visible)
 *   view-park      → negative resolution (where to keep what is not)
 *
 * Note: WebGL/Canvas renderers can still lose their rasterized buffer
 * across DOM detach/reattach. TerminalView refresh() (called on parent
 * change) handles that.
 */
export function ContentHost({
  workspaceId,
  tab,
  ownerLeafId,
  isActiveTab,
  isWorkspaceActive,
}: ContentHostProps) {
  const slotEl = useSlotElement(workspaceId, ownerLeafId);
  const parkEl = useViewPark();
  const isVisible = isActiveTab && isWorkspaceActive;
  const currentParent = isVisible ? (slotEl ?? parkEl) : parkEl;

  // Stable per-tab portal target. Created once on first render and reused
  // for the component's entire lifetime. Use lazy-init via ref so we don't
  // re-create on each render.
  const portalTargetRef = useRef<HTMLDivElement | null>(null);
  if (portalTargetRef.current === null) {
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.inset = "0";
    portalTargetRef.current = el;
  }
  const portalTarget = portalTargetRef.current;

  // Reparent the stable portal target into the current parent (slot or
  // view park) whenever the parent changes. This is what actually moves
  // the DOM during a tab move or workspace switch — the React tree above
  // stays put.
  useEffect(() => {
    if (!currentParent) return;
    if (portalTarget.parentElement !== currentParent) {
      currentParent.appendChild(portalTarget);
    }
  }, [currentParent, portalTarget]);

  // Detach on unmount so we don't leak the element in the previous parent.
  useEffect(() => {
    return () => {
      portalTarget.remove();
    };
  }, [portalTarget]);

  // No CSS-based visibility masking on the inner wrapper: when the tab is
  // not visible, its portalTarget lives in the view park (off-screen, inert,
  // visibility:hidden, contain:strict), so it is already neither painted nor
  // hit-tested. Adding `invisible pointer-events-none` here would be dead
  // weight and previously caused the stacking bug this rule fixes.
  const inner = (
    <div className="absolute inset-0">
      {tab.type === "terminal" ? (
        <TerminalView
          tabId={tab.id}
          cwd={tab.props.cwd}
          ownerLeafId={ownerLeafId}
          parentEl={currentParent}
          isVisible={isVisible}
        />
      ) : (
        // key on filePath: preview-slot reuse (Stage 2A) swaps props.filePath on
        // the same Tab id, so without a key the EditorView would keep the same
        // monaco editor instance while useSharedModel disposed the old model
        // out from under it — triggering "InstantiationService has been disposed"
        // when setModel ran against the half-torn editor. Remounting on filePath
        // change gives @monaco-editor/react a clean dispose + create cycle.
        <EditorView
          key={tab.props.filePath}
          filePath={tab.props.filePath}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );

  return createPortal(inner, portalTarget);
}
