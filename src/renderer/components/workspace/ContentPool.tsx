// ContentPool — mounts every workspace tab exactly once and positions each
// ContentHost over its corresponding group-slot element via absolute CSS.
//
// Placement contract:
//   ContentPool renders as `absolute inset-0` — this requires its parent
//   container to be `position: relative`. T7 (WorkspacePanel) is responsible
//   for establishing that positioning context by layering ContentPool as an
//   absolute sibling on top of the LayoutTree.

import { useLayoutEffect, useRef, useState } from "react";
import { EditorView } from "../EditorView";
import { TerminalView } from "../TerminalView";
import { useLayoutStore } from "../../store/layout";
import { allLeaves } from "../../store/layout/helpers";
import type { EditorTabProps, Tab, TerminalTabProps } from "../../store/tabs";
import { useTabsStore } from "../../store/tabs";
import { ownerLeafIdOf } from "./contentPool-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface ContentHostProps {
  workspaceId: string;
  tab: Tab;
  ownerLeafId: string | null;
  isActiveTab: boolean;
  isWorkspaceActive: boolean;
  poolRef: React.RefObject<HTMLDivElement>;
}

// ---------------------------------------------------------------------------
// ContentHost — one per tab, always mounted, positioned over its slot
// ---------------------------------------------------------------------------

function ContentHost({
  workspaceId,
  tab,
  ownerLeafId,
  isActiveTab,
  isWorkspaceActive,
  poolRef,
}: ContentHostProps) {
  const [rect, setRect] = useState<Rect | null>(null);

  useLayoutEffect(() => {
    if (!ownerLeafId) {
      setRect(null);
      return;
    }

    function measure() {
      const pool = poolRef.current;
      if (!pool) {
        setRect(null);
        return;
      }
      const slotEl = pool.parentElement?.querySelector<HTMLElement>(
        `[data-group-slot="${ownerLeafId}"]`,
      );
      if (!slotEl) {
        setRect(null);
        return;
      }

      const poolBounds = pool.getBoundingClientRect();
      const slotBounds = slotEl.getBoundingClientRect();

      setRect({
        top: slotBounds.top - poolBounds.top,
        left: slotBounds.left - poolBounds.left,
        width: slotBounds.width,
        height: slotBounds.height,
      });
    }

    measure();

    const pool = poolRef.current;
    if (!pool) return;

    const slotEl = pool.parentElement?.querySelector<HTMLElement>(
      `[data-group-slot="${ownerLeafId}"]`,
    );

    const ro = new ResizeObserver(measure);
    // Observe the pool container itself — recalculate when origin shifts
    ro.observe(pool);
    // Observe the slot element — recalculate when sash drag or split resizes it
    if (slotEl) {
      ro.observe(slotEl);
    }

    return () => {
      ro.disconnect();
    };
  }, [ownerLeafId, poolRef]);

  const isVisible = isActiveTab && isWorkspaceActive;
  const visibilityClass =
    rect !== null && isVisible ? "pointer-events-auto" : "invisible pointer-events-none";

  return (
    <div
      className={`absolute ${visibilityClass}`}
      style={
        rect !== null
          ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          : { top: 0, left: 0, width: 0, height: 0 }
      }
    >
      {tab.type === "terminal" ? (
        <TerminalView tabId={tab.id} cwd={(tab.props as TerminalTabProps).cwd} />
      ) : (
        <EditorView
          filePath={(tab.props as EditorTabProps).filePath}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContentPool — renders one ContentHost per tab record
// ---------------------------------------------------------------------------

export function ContentPool({
  workspaceId,
  isWorkspaceActive,
}: {
  workspaceId: string;
  isWorkspaceActive: boolean;
}) {
  const poolRef = useRef<HTMLDivElement>(null);

  const tabRecord = useTabsStore((s) => s.byWorkspace[workspaceId] ?? {});
  const layout = useLayoutStore((s) => s.byWorkspace[workspaceId]);

  // Derive activeTabId for each leaf once so ContentHost can get isActiveTab.
  const activeTabByLeaf: Record<string, string | null> = {};
  if (layout) {
    for (const leaf of allLeaves(layout.root)) {
      activeTabByLeaf[leaf.id] = leaf.activeTabId;
    }
  }

  return (
    <div ref={poolRef} className="absolute inset-0 pointer-events-none">
      {Object.values(tabRecord).map((tab) => {
        const ownerLeafId = layout ? ownerLeafIdOf(layout.root, tab.id) : null;
        const isActiveTab =
          ownerLeafId !== null
            ? activeTabByLeaf[ownerLeafId] === tab.id
            : false;

        return (
          <ContentHost
            key={tab.id}
            workspaceId={workspaceId}
            tab={tab}
            ownerLeafId={ownerLeafId}
            isActiveTab={isActiveTab}
            isWorkspaceActive={isWorkspaceActive}
            poolRef={poolRef}
          />
        );
      })}
    </div>
  );
}
