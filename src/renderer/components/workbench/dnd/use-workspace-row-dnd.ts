import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import {
  hasWorkspaceRowMime,
  MIME_WORKSPACE_ROW,
  parseWorkspaceDragPayload,
  type WorkspaceRowDragPayload,
} from "./workspace-row-drag";

export interface SlotInfo {
  key: string;
  group: "pinned" | "unpinned";
  beforeId?: string;
  afterId?: string;
}

export interface ReorderArgs {
  id: string;
  beforeId?: string;
  afterId?: string;
  targetGroup: "pinned" | "unpinned";
}

export interface UseWorkspaceRowDndOptions {
  workspaces: WorkspaceMeta[];
  onReorder: (args: ReorderArgs) => void;
}

export interface UseWorkspaceRowDndResult {
  dragSourceId: string | null;
  activeSlotKey: string | null;
  getRowDragSourceProps: (
    rowId: string,
    pinned: boolean,
  ) => {
    draggable: true;
    onDragStart: (e: React.DragEvent<HTMLElement>) => void;
    onDragEnd: (e: React.DragEvent<HTMLElement>) => void;
  };
  getSlotDropProps: (slot: SlotInfo) => {
    onDragEnter: (e: React.DragEvent<HTMLElement>) => void;
    onDragOver: (e: React.DragEvent<HTMLElement>) => void;
    onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
    onDrop: (e: React.DragEvent<HTMLElement>) => void;
  };
  isSlotSuppressed: (slot: SlotInfo) => boolean;
}

export function buildSlotsForGroup(
  group: WorkspaceMeta[],
  groupKind: "pinned" | "unpinned",
): SlotInfo[] {
  if (group.length === 0) return [];

  const slots: SlotInfo[] = [];

  slots.push({
    key: `${groupKind}:top:${group[0].id}`,
    group: groupKind,
    beforeId: group[0].id,
  });

  for (let i = 0; i < group.length - 1; i += 1) {
    slots.push({
      key: `${groupKind}:between:${group[i].id}:${group[i + 1].id}`,
      group: groupKind,
      beforeId: group[i + 1].id,
      afterId: group[i].id,
    });
  }

  slots.push({
    key: `${groupKind}:bottom:${group[group.length - 1].id}`,
    group: groupKind,
    afterId: group[group.length - 1].id,
  });

  return slots;
}

export function isSlotNoOp(args: { source: WorkspaceMeta; slot: SlotInfo }): boolean {
  const { source, slot } = args;
  const sourceGroup: "pinned" | "unpinned" = source.pinned ? "pinned" : "unpinned";

  if (sourceGroup !== slot.group) return false;

  if (slot.beforeId === source.id) return true;
  if (slot.afterId === source.id) return true;
  return false;
}

export function useWorkspaceRowDnd({
  workspaces,
  onReorder,
}: UseWorkspaceRowDndOptions): UseWorkspaceRowDndResult {
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [activeSlotKey, setActiveSlotKey] = useState<string | null>(null);

  const onReorderRef = useRef(onReorder);
  useEffect(() => {
    onReorderRef.current = onReorder;
  });

  const workspacesRef = useRef(workspaces);
  useEffect(() => {
    workspacesRef.current = workspaces;
  });

  const sourcePayloadRef = useRef<WorkspaceRowDragPayload | null>(null);

  useEffect(() => {
    function onDocDragEnd() {
      setDragSourceId(null);
      setActiveSlotKey(null);
      sourcePayloadRef.current = null;
    }
    document.addEventListener("dragend", onDocDragEnd);
    return () => document.removeEventListener("dragend", onDocDragEnd);
  }, []);

  const slotIsSuppressedForCurrentSource = useCallback((slot: SlotInfo): boolean => {
    const payload = sourcePayloadRef.current;
    if (!payload) return false;
    const source = workspacesRef.current.find((w) => w.id === payload.workspaceId);
    if (!source) return false;
    return isSlotNoOp({ source, slot });
  }, []);

  const getRowDragSourceProps = useCallback((rowId: string, pinned: boolean) => {
    function onDragStart(e: React.DragEvent<HTMLElement>) {
      if (!e.dataTransfer) return;

      const payload: WorkspaceRowDragPayload = { workspaceId: rowId, pinned };

      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(MIME_WORKSPACE_ROW, JSON.stringify(payload));

      e.dataTransfer.setDragImage(e.currentTarget, 0, 0);

      sourcePayloadRef.current = payload;
      setDragSourceId(rowId);
    }

    function onDragEnd(_e: React.DragEvent<HTMLElement>) {
      setDragSourceId(null);
      setActiveSlotKey(null);
      sourcePayloadRef.current = null;
    }

    return {
      draggable: true as const,
      onDragStart,
      onDragEnd,
    };
  }, []);

  const getSlotDropProps = useCallback(
    (slot: SlotInfo) => {
      function onDragEnter(e: React.DragEvent<HTMLElement>) {
        if (!e.dataTransfer) return;
        if (!hasWorkspaceRowMime(e.dataTransfer.types)) return;
        if (slotIsSuppressedForCurrentSource(slot)) return;
        e.preventDefault();
      }

      function onDragOver(e: React.DragEvent<HTMLElement>) {
        if (!e.dataTransfer) return;
        if (!hasWorkspaceRowMime(e.dataTransfer.types)) return;

        if (slotIsSuppressedForCurrentSource(slot)) {
          if (activeSlotKey === slot.key) setActiveSlotKey(null);
          return;
        }

        e.preventDefault();
        e.dataTransfer.dropEffect = "move";

        if (activeSlotKey !== slot.key) setActiveSlotKey(slot.key);
      }

      function onDragLeave(_e: React.DragEvent<HTMLElement>) {
        if (activeSlotKey === slot.key) setActiveSlotKey(null);
      }

      function onDrop(e: React.DragEvent<HTMLElement>) {
        if (!e.dataTransfer) return;
        const payload = parseWorkspaceDragPayload(e.dataTransfer);
        if (!payload) return;

        e.preventDefault();
        e.stopPropagation();

        if (slotIsSuppressedForCurrentSource(slot)) {
          setActiveSlotKey(null);
          return;
        }

        const args: ReorderArgs = {
          id: payload.workspaceId,
          targetGroup: slot.group,
          ...(slot.beforeId ? { beforeId: slot.beforeId } : {}),
          ...(!slot.beforeId && slot.afterId ? { afterId: slot.afterId } : {}),
        };

        onReorderRef.current(args);
        setActiveSlotKey(null);
      }

      return { onDragEnter, onDragOver, onDragLeave, onDrop };
    },
    [activeSlotKey, slotIsSuppressedForCurrentSource],
  );

  return {
    dragSourceId,
    activeSlotKey,
    getRowDragSourceProps,
    getSlotDropProps,
    isSlotSuppressed: slotIsSuppressedForCurrentSource,
  };
}
