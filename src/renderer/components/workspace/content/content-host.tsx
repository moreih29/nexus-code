import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { EditorTabProps, Tab, TerminalTabProps } from "@/state/stores/tabs";
import { useHiddenPortalEl } from "./content-pool";
import { EditorView } from "./editor-view";
import { useSlotElement } from "./slot-registry";
import { TerminalView } from "./terminal-view";

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
 * into the current parent (slot or hidden pool) whenever the parent
 * changes. The DOM moves; the React tree does not.
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
  const hiddenEl = useHiddenPortalEl();
  const currentParent = slotEl ?? hiddenEl;

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
  // hidden pool) whenever the parent changes. This is what actually moves
  // the DOM during a tab move — the React tree above stays put.
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

  const isVisible = isActiveTab && isWorkspaceActive;

  const inner = (
    <div
      className={isVisible ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none"}
    >
      {tab.type === "terminal" ? (
        <TerminalView
          tabId={tab.id}
          cwd={(tab.props as TerminalTabProps).cwd}
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
          key={(tab.props as EditorTabProps).filePath}
          filePath={(tab.props as EditorTabProps).filePath}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );

  return createPortal(inner, portalTarget);
}
