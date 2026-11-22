import i18next from "i18next";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { DropEdge } from "../../services/agent-view/order";
import { cn } from "../../utils/cn";
import { beginDragInFlight } from "../../utils/drag-in-flight";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
  type MenuItemSpec,
} from "../ui/context-menu";
import { SidebarDropIndicator, sidebarDropEdge } from "./sidebar-drop";

const MIME_PEER = "application/x-nexus-peer";

export type PeerDrag = { id: string; drop?: { target: string; edge: DropEdge } };

export interface PeerReorder {
  ids: readonly string[];
  drag: PeerDrag | null;
  setDrag: Dispatch<SetStateAction<PeerDrag | null>>;
  move(moved: string, target: string, edge: DropEdge): void;
}

export function peerOrderMenu(
  id: string,
  { ids, move }: Pick<PeerReorder, "ids" | "move">,
): MenuItemSpec[] {
  const index = ids.indexOf(id);
  if (index === -1) return [];
  const above = ids[index - 1];
  const below = ids[index + 1];
  const items: MenuItemSpec[] = [];
  if (above !== undefined) {
    items.push({
      kind: "item",
      label: i18next.t("agentView.remote.moveUp"),
      onSelect: () => move(id, above, "before"),
    });
  }
  if (below !== undefined) {
    items.push({
      kind: "item",
      label: i18next.t("agentView.remote.moveDown"),
      onSelect: () => move(id, below, "after"),
    });
  }
  return items;
}

function openPeerMenu(button: HTMLButtonElement): void {
  const rect = button.getBoundingClientRect();
  button.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left,
      clientY: rect.bottom,
    }),
  );
}

export function RemotePeerHeader({
  id,
  reorder,
  expanded,
  onToggle,
  className,
  children,
}: {
  id: string;
  reorder: PeerReorder | undefined;
  expanded: boolean;
  onToggle: () => void;
  className: string;
  children: ReactNode;
}) {
  const activeDrag = reorder?.drag;
  const drag =
    activeDrag && activeDrag.id !== id && reorder?.ids.includes(activeDrag.id) ? activeDrag : null;
  const drop = drag?.drop;
  const header = (
    <button
      type="button"
      draggable={reorder !== undefined}
      aria-expanded={expanded}
      aria-keyshortcuts={reorder ? "Shift+F10" : undefined}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (reorder && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
          e.preventDefault();
          openPeerMenu(e.currentTarget);
        }
      }}
      onDragStart={(e) => {
        if (!reorder) return;
        e.dataTransfer.setData(MIME_PEER, id);
        e.dataTransfer.effectAllowed = "move";
        reorder.setDrag({ id });
        beginDragInFlight();
      }}
      onDragOver={(e) => {
        if (!reorder || !drag || !e.dataTransfer.types.includes(MIME_PEER)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const edge = sidebarDropEdge(e);
        if (drop?.target !== id || drop.edge !== edge) {
          reorder.setDrag({ id: drag.id, drop: { target: id, edge } });
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          reorder?.setDrag((current) =>
            current?.drop?.target === id ? { id: current.id } : current,
          );
        }
      }}
      onDrop={(e) => {
        if (!reorder || !drag || e.dataTransfer.getData(MIME_PEER) !== drag.id) return;
        e.preventDefault();
        reorder.setDrag(null);
        reorder.move(drag.id, id, sidebarDropEdge(e));
      }}
      onDragEnd={() => reorder?.setDrag(null)}
      className={cn(
        "relative text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      data-testid="remote-peer-header"
    >
      {drop?.target === id && <SidebarDropIndicator edge={drop.edge} />}
      {children}
    </button>
  );
  if (!reorder) return header;
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger>{header}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItems items={peerOrderMenu(id, reorder)} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
