import { type DragEvent, useState, useSyncExternalStore } from "react";
import { createListenerBus } from "../../../shared/util/listener-bus";
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

let source: SessionDrag | null = null;
let reordering: SessionDrag | null = null;
const dragChanges = createListenerBus();

export function useSessionReordering(deviceId?: string): SessionDrag | null {
  const snapshot = () => (reordering?.deviceId === deviceId ? reordering : null);
  return useSyncExternalStore(dragChanges.subscribe, snapshot, snapshot);
}

function showReordering(row: SessionDrag | null) {
  if (reordering === row) return;
  reordering = row;
  dragChanges.notify();
}

function sourceIn(event: DragEvent<HTMLElement>, workspaceId: string, deviceId?: string) {
  return source?.workspaceId === workspaceId &&
    source.deviceId === deviceId &&
    event.dataTransfer.types.includes(deviceId === undefined ? MIME_AGENT : MIME_SESSION_ORDER)
    ? source
    : null;
}

export function hoverWorkspaceReorder(
  event: DragEvent<HTMLElement>,
  workspaceId: string,
  deviceId?: string,
) {
  const row = sourceIn(event, workspaceId, deviceId);
  if (row) showReordering(row);
}

export function leaveWorkspaceReorder(
  event: DragEvent<HTMLElement>,
  deviceId?: string,
  workspaceId?: string,
) {
  if (
    reordering?.deviceId === deviceId &&
    (workspaceId === undefined || reordering?.workspaceId === workspaceId) &&
    !event.currentTarget.contains(event.relatedTarget as Node | null)
  )
    showReordering(null);
}

export function startSessionDrag(event: DragEvent, row: SessionDrag): void {
  if (row.deviceId === undefined) {
    setAgentDrag(event.dataTransfer, row.key);
  } else {
    event.dataTransfer.setData(MIME_SESSION_ORDER, row.key);
    event.dataTransfer.effectAllowed = "move";
  }
  source = row;
  showReordering(null);
  beginDragInFlight();
  document.addEventListener("pointerdown", endSessionDrag, true);
}

export function endSessionDrag(): void {
  if (!source) return;
  source = null;
  document.removeEventListener("pointerdown", endSessionDrag, true);
  showReordering(null);
}

function sessionDropEdge(event: DragEvent<HTMLElement>, row: SessionDrag): DropEdge | null {
  const moved = sourceIn(event, row.workspaceId, row.deviceId);
  return moved && row.key !== moved.key ? sidebarDropEdge(event) : null;
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
        showReordering(source);
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
