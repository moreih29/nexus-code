import { useMemo, useState } from "react";
import { useDragSource } from "@/components/ui/use-drag-source";
import { distinctParents } from "@/services/fs-mutations/distinct-parents";
import { useFilesStore } from "@/state/stores/files";
import { MIME_FILE } from "@/types/workbench-dnd";
import { basename } from "@/utils/path";
import { buildFileDragPayload } from "@/utils/workbench-dnd-payload";
import { FileTreeRow, type FileTreeRowProps } from "./row";

export function DraggableFileTreeRow({
  workspaceId,
  isRoot,
  ...row
}: FileTreeRowProps & { workspaceId: string; isRoot: boolean }) {
  const { absPath } = row;
  // Drag source — everything except the workspace root. Directories are
  // draggable (move/copy a folder into another folder); the root is the
  // only exception because it has no meaningful destination.
  //
  // Phase E: payload and drag-image label are resolved at dragstart time so
  // they reflect the current multi-selection state:
  //   - absPath is in selection.paths → drag the whole selection (distinctParents).
  //   - absPath is NOT in selection.paths → drag only this row (single path).
  // This is a read-once snapshot; selection changes during drag do not affect
  // the in-flight payload.
  //
  // `payload` is a stable identity value (always the single-path shape) that
  // keeps the useCallback dep array stable.  `getPayload` is called at dragstart
  // time to produce the real multi-path payload.
  const stablePayload = useMemo(
    () => buildFileDragPayload(workspaceId, [absPath]),
    [workspaceId, absPath],
  );

  const getPayload = useMemo(
    () => () => {
      const sel = useFilesStore.getState().selection.get(workspaceId);
      if (sel && sel.paths.size > 0 && sel.paths.has(absPath)) {
        const filePaths = distinctParents([...sel.paths]);
        return buildFileDragPayload(workspaceId, filePaths);
      }
      return buildFileDragPayload(workspaceId, [absPath]);
    },
    [workspaceId, absPath],
  );

  const getDragImage = useMemo(
    () => () => {
      const sel = useFilesStore.getState().selection.get(workspaceId);
      const isMulti = sel && sel.paths.size > 0 && sel.paths.has(absPath);
      if (isMulti) {
        const count = distinctParents([...sel.paths]).length;
        if (count > 1) {
          return { kind: "label" as const, text: String(count) };
        }
      }
      return { kind: "label" as const, text: basename(absPath) };
    },
    [workspaceId, absPath],
  );

  const { onDragStart } = useDragSource({
    mime: MIME_FILE,
    payload: stablePayload,
    getPayload,
    dragImage: getDragImage,
    effectAllowed: "copyMove",
  });
  // Dim the source row while it is being dragged (VSCode parity — the dragged
  // entry fades so the floating drag label / drop target stand out).
  const [isDragging, setIsDragging] = useState(false);
  const handleDragStart = (e: React.DragEvent<HTMLButtonElement>): void => {
    setIsDragging(true);
    onDragStart(e);
  };

  return (
    <FileTreeRow
      {...row}
      isDragging={isDragging}
      dragProps={{
        draggable: !isRoot,
        onDragStart: isRoot ? undefined : handleDragStart,
        onDragEnd: isRoot ? undefined : () => setIsDragging(false),
      }}
    />
  );
}
