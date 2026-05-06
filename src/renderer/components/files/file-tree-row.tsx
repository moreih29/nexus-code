import { useMemo } from "react";
import { useDragSource } from "@/components/ui/use-drag-source";
import { type FileDragPayload, MIME_FILE } from "@/components/workspace/dnd/types";
import { cn } from "@/utils/cn";
import type { TreeNode } from "../../state/stores/files";
import { FOLDER_ICON, FOLDER_OPEN_ICON, getFileIcon } from "./file-tree-icons";
import { indentPaddingLeft, ROW_HEIGHT_PX } from "./file-tree-metrics";

// ---------------------------------------------------------------------------
// Inline icon — avoids external icon library dependency
// ---------------------------------------------------------------------------

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      role="none"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FileTreeRowProps {
  workspaceId: string;
  absPath: string;
  node: TreeNode;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isLoading?: boolean;
  onToggle: () => void; // dir click
  onClick: (e: React.MouseEvent) => void; // file click
  /**
   * File-only double-click. Mirrors VSCode explorer's "double-click =
   * open as a permanent (non-preview) tab" gesture.
   */
  onDoubleClick?: (e: React.MouseEvent) => void;
  /**
   * Right-click on the row. The parent file-tree consumes this to set
   * its menu anchor *before* Radix's ContextMenu.Trigger opens (React's
   * bubble order — child handler fires before the trigger's).
   */
  onContextMenu?: (e: React.MouseEvent) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FileTreeRow({
  workspaceId,
  absPath,
  node,
  depth,
  isExpanded,
  isSelected,
  isLoading = false,
  onToggle,
  onClick,
  onDoubleClick,
  onContextMenu,
}: FileTreeRowProps) {
  const isDir = node.type === "dir";

  // Type icon: folder open/closed for directories, file-family glyph
  // (FileCode, FileJson, ...) for files. The chevron stays as the
  // expand affordance; this slot answers "what kind of node is this?"
  // and aligns vertically across the tree regardless of nesting depth.
  const TypeIcon = isDir ? (isExpanded ? FOLDER_OPEN_ICON : FOLDER_ICON) : getFileIcon(node.name);

  // Drag source — files only. Directories aren't draggable; opening "the
  // folder" as an editor tab has no semantics.
  const payload = useMemo<FileDragPayload>(
    () => ({ workspaceId, filePath: absPath }),
    [workspaceId, absPath],
  );
  const { onDragStart } = useDragSource({
    mime: MIME_FILE,
    payload,
    dragImage: { kind: "label", text: node.name },
    effectAllowed: "copy",
  });

  return (
    <button
      type="button"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isDir ? isExpanded : undefined}
      aria-selected={isSelected}
      onClick={isDir ? onToggle : (e) => onClick(e)}
      onDoubleClick={isDir ? undefined : onDoubleClick}
      onContextMenu={onContextMenu}
      title={node.name}
      draggable={!isDir}
      onDragStart={isDir ? undefined : onDragStart}
      style={{ paddingLeft: indentPaddingLeft(depth), height: ROW_HEIGHT_PX }}
      className={cn(
        "flex items-center w-full text-left cursor-pointer select-none",
        "border-l-2 border-l-transparent",
        "hover:bg-frosted-veil-strong",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mist-border focus-visible:ring-inset",
        isSelected && "bg-frosted-veil border-l-mist-border text-foreground",
      )}
    >
      {isDir ? (
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-stone-gray transition-transform duration-150 ease-out",
            isExpanded && "rotate-90",
            isLoading && "opacity-50 animate-pulse",
          )}
        />
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden />
      )}
      <TypeIcon
        className={cn(
          "size-3.5 shrink-0 ml-1 text-stone-gray",
          isLoading && "opacity-50 animate-pulse",
        )}
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <span className="ml-1.5 truncate min-w-0 text-app-body">{node.name}</span>
    </button>
  );
}
