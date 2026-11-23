import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { TreeNode } from "../../../state/stores/files";
import { FileIcon } from "./file-icon";
import { type GitDecorationKind, kindToColorVar, kindToLetter } from "./git-decoration";
import { indentPaddingLeft, ROW_HEIGHT_PX } from "./metrics";

export interface FileTreeRowProps {
  id?: string;
  absPath: string;
  node: Pick<TreeNode, "type" | "name">;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isFocused?: boolean;
  isLoading?: boolean;
  isDragging?: boolean;
  dragProps?: Pick<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "draggable" | "onDragStart" | "onDragEnd"
  >;
  decoration?: GitDecorationKind;
  isIgnored?: boolean;
  isCut?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function FileTreeRow({
  id,
  absPath,
  node,
  depth,
  isExpanded,
  isSelected,
  isFocused = false,
  isLoading = false,
  isDragging = false,
  dragProps,
  decoration,
  isIgnored = false,
  isCut = false,
  onClick,
  onDoubleClick,
  onContextMenu,
}: FileTreeRowProps) {
  const isDir = node.type === "dir";

  return (
    <button
      id={id}
      type="button"
      role="treeitem"
      tabIndex={-1}
      aria-level={depth + 1}
      aria-expanded={isDir ? isExpanded : undefined}
      aria-selected={isSelected}
      onClick={(e) => onClick(e)}
      onDoubleClick={isDir ? undefined : onDoubleClick}
      onContextMenu={onContextMenu}
      title={node.name}
      data-file-tree-row-type={node.type}
      data-file-tree-row-path={absPath}
      {...dragProps}
      style={{ paddingLeft: indentPaddingLeft(depth), height: ROW_HEIGHT_PX }}
      className={cn(
        "flex items-center w-full text-left cursor-pointer select-none",
        "border-l-2 border-l-transparent",
        "hover:bg-[var(--state-hover-bg)]",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] focus-visible:ring-inset",
        isSelected &&
          "bg-[var(--sidebar-item-selected-bg)] border-l-[var(--state-selected-indicator)] text-[var(--sidebar-item-selected-fg)]",
        isFocused &&
          !isDragging &&
          "outline outline-1 outline-dotted outline-offset-[-1px] outline-[var(--sidebar-item-focus-border)]",
        isCut && "opacity-40 border-l-[var(--state-disabled-border)]",
        isDragging && "opacity-40",
      )}
    >
      {isDir ? (
        <ChevronRight
          aria-hidden="true"
          strokeWidth={1.5}
          className={cn(
            "size-3 shrink-0 text-[var(--sidebar-icon-fg)] transition-transform duration-150 ease-out",
            isExpanded && "rotate-90",
            isLoading && "opacity-50 animate-pulse",
          )}
        />
      ) : (
        <span className="size-3 shrink-0" aria-hidden />
      )}
      <FileIcon
        kind={isDir ? (isExpanded ? "folder-open" : "folder") : "file"}
        name={node.name}
        size="sm"
        tone="sidebar"
        className={cn("ml-1 shrink-0", isLoading && "opacity-50 animate-pulse")}
        aria-hidden="true"
      />
      <span
        className={cn("ml-2 truncate min-w-0 text-app-body", isIgnored && "opacity-50")}
        style={effectiveNameColor(decoration, isIgnored)}
      >
        {node.name}
      </span>
      {decoration !== undefined && <GitDecorationChip kind={decoration} />}
    </button>
  );
}

function effectiveNameColor(
  decoration: GitDecorationKind | undefined,
  isIgnored: boolean,
): React.CSSProperties | undefined {
  if (decoration !== undefined) return { color: kindToColorVar(decoration) };
  if (isIgnored) return { color: kindToColorVar("ignored") };
  return undefined;
}

function GitDecorationChip({ kind }: { kind: GitDecorationKind }) {
  const { t } = useTranslation("files");
  const letter = kindToLetter(kind);
  const tooltip = t(`git.decorations.${kind}`);
  return (
    <span
      className="ml-auto pl-1 pr-2 inline-flex shrink-0 items-center justify-center font-mono text-app-ui-sm leading-none"
      style={{ color: kindToColorVar(kind) }}
      role="img"
      aria-label={tooltip}
      title={tooltip}
    >
      {letter}
    </span>
  );
}
