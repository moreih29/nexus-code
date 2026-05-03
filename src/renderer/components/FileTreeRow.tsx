import { cn } from "@/lib/utils";
import type { TreeNode } from "../store/files";

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
  node: TreeNode;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  onToggle: () => void; // dir click
  onClick: () => void; // file click
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FileTreeRow({
  node,
  depth,
  isExpanded,
  isSelected,
  onToggle,
  onClick,
}: FileTreeRowProps) {
  const isDir = node.type === "dir";

  return (
    <button
      type="button"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isDir ? isExpanded : undefined}
      aria-selected={isSelected}
      onClick={isDir ? onToggle : onClick}
      title={node.name}
      style={{ paddingLeft: depth * 12 + 8 }}
      className={cn(
        "flex items-center h-6 w-full text-left cursor-pointer select-none",
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
          )}
        />
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="ml-1 truncate min-w-0 text-app-body">{node.name}</span>
    </button>
  );
}
