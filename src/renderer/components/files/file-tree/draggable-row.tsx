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
