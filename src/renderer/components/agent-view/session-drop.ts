import { type DragEvent, useState } from "react";
import type { DropEdge } from "../../services/agent-view/order";
import { beginDragInFlight } from "../../utils/drag-in-flight";
import { MIME_AGENT, setAgentDrag } from "./drag";
import { sidebarDropEdge } from "./sidebar-drop";

const MIME_SESSION_ORDER = "application/x-nexus-session-order";

export type SessionReorder = (moved: string, target: string, edge: DropEdge) => void;

interface SessionDrag {
  key: string;
  workspaceId: string;
  deviceId?: string;
}

// Dragover can read the payload's type only, so keep the row's scope while dragging.
let source: SessionDrag | null = null;

export function startSessionDrag(event: DragEvent, row: SessionDrag): void {
  if (row.deviceId === undefined) {
    setAgentDrag(event.dataTransfer, row.key);
  } else {
    event.dataTransfer.setData(MIME_SESSION_ORDER, row.key);
    event.dataTransfer.effectAllowed = "move";
  }
  source = row;
  beginDragInFlight();
}

export function endSessionDrag(): void {
  source = null;
}

/** A row accepts another row from the same device and workspace. */
function sessionDropEdge(event: DragEvent<HTMLElement>, row: SessionDrag): DropEdge | null {
  if (
    !source ||
    row.key === source.key ||
    row.workspaceId !== source.workspaceId ||
    row.deviceId !== source.deviceId ||
    !event.dataTransfer.types.includes(row.deviceId === undefined ? MIME_AGENT : MIME_SESSION_ORDER)
  ) {
    return null;
  }
  return sidebarDropEdge(event);
}

export function useSessionDrop(row: SessionDrag, reorder: SessionReorder | undefined) {
  const [edge, setEdge] = useState<DropEdge | null>(null);
  return {
    edge: reorder ? edge : null,
    dropProps: {
      onDragOver(event: DragEvent<HTMLElement>) {
        const next = reorder ? sessionDropEdge(event, row) : null;
        if (next !== edge) setEdge(next);
        if (!next) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEdge(null);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        const next = reorder ? sessionDropEdge(event, row) : null;
        setEdge(null);
        if (!reorder || !next || !source) return;
        event.preventDefault();
        const { key } = source;
        endSessionDrag();
        reorder(key, row.key, next);
      },
    },
  };
}
