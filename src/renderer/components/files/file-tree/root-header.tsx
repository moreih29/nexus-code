/**
 * Workspace root header — the sticky row at the top of the file-tree that
 * shows the workspace folder name and exposes hover-revealed action icons.
 *
 * Hoisted out of the virtualized tree so:
 *   - the action cluster stays in place as the tree scrolls,
 *   - the chevron is a sibling of (not inside) the tree's `role="tree"`
 *     container — it does not participate in `aria-activedescendant`
 *     navigation, matching VSCode's view-title-bar semantics.
 *
 * Actions (VSCode parity, `explorerView.ts` MenuId.ViewTitle group `navigation`):
 *   10 New File   • startCreate at root, file kind
 *   20 New Folder • startCreate at root, folder kind
 *   30 Refresh    • files operation `refresh(workspaceId)`
 *   40 Collapse   • files operation `collapseAll(workspaceId)` (keeps root expanded)
 *
 * Right-click anywhere on the header surfaces the root context menu through
 * the same ContextMenuRoot the tree uses — index.tsx wires `onContextMenu`
 * to set the root target before the menu opens.
 */
import { ChevronsDownUp, FilePlus, FolderPlus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { basename } from "@/utils/path";

interface WorkspaceRootHeaderProps {
  rootAbsPath: string;
  /** True when the workspace root is expanded (children visible below). */
  isExpanded: boolean;
  /** Click on chevron / name → toggle root's expanded state. */
  onToggle: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  onCollapseAll: () => void;
  /** Right-click on any part of the header → root context menu. */
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
}

// Inline chevron matches the SVG used by FileTreeRow (row.tsx) so the
// expand affordance is visually identical between header and child rows.
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

interface ActionButtonProps {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

// Local icon-button. Sized to match the header row height (24px) — the
// shared ui/Button's smallest variant (icon-sm = 32px) overflows the row.
function ActionButton({ label, onClick, children }: ActionButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        // Stop propagation so the header's toggle handler doesn't also fire.
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex size-5 items-center justify-center rounded-(--radius-control)",
        "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
        "active:bg-[var(--state-active-bg)]",
        "outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50",
      )}
    >
      {children}
    </button>
  );
}

export function WorkspaceRootHeader({
  rootAbsPath,
  isExpanded,
  onToggle,
  onNewFile,
  onNewFolder,
  onRefresh,
  onCollapseAll,
  onContextMenu,
}: WorkspaceRootHeaderProps) {
  const { t } = useTranslation("files");
  const name = basename(rootAbsPath) || rootAbsPath;
  return (
    // <header> is the right semantic for "introduces the section below".
    // Hover-state propagation for the action cluster is driven by a named
    // Tailwind group (`group/filetree`) on the FileTree's outer wrapper —
    // matches VSCode where the title-bar actions stay visible as long as
    // the explorer view is hovered, not just its title strip. Right-click
    // anywhere on the header surfaces the root context menu; the inner
    // toggle button and action buttons handle their own click semantics,
    // so this listener only matters for the gaps between them.
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click delegation on a header strip — keyboard users access the same context menu via Menu key on the focused button below.
    <header
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 pl-2 pr-1.5",
        "border-b border-border/50 select-none",
      )}
      onContextMenu={onContextMenu}
    >
      {/*
        Chevron + name share a single button so the entire left side toggles
        the root. Width caps at the available space; the action cluster on
        the right is laid out separately and gets priority via shrink-0.
       */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        title={rootAbsPath}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 text-left",
          "outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50 rounded-(--radius-control)",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            isExpanded && "rotate-90",
          )}
        />
        <span className="truncate text-app-ui-sm font-medium uppercase tracking-wide">{name}</span>
      </button>

      {/*
        Action cluster: hidden by default, revealed whenever the user is
        hovering anywhere over the file-tree (the `group/filetree` ancestor
        wraps both this header and the virtualized body in index.tsx).
        focus-within keeps it visible when a keyboard user tabs into one
        of the buttons. Spacing matches the icon-button density in
        tab-bar.tsx.
       */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5",
          "opacity-0 transition-opacity",
          "group-hover/filetree:opacity-100 focus-within:opacity-100",
        )}
      >
        <ActionButton label={t("fileTree.header.newFile")} onClick={onNewFile}>
          <FilePlus aria-hidden className="size-3.5" />
        </ActionButton>
        <ActionButton label={t("fileTree.header.newFolder")} onClick={onNewFolder}>
          <FolderPlus aria-hidden className="size-3.5" />
        </ActionButton>
        <ActionButton label={t("fileTree.header.refresh")} onClick={onRefresh}>
          <RefreshCw aria-hidden className="size-3.5" />
        </ActionButton>
        <ActionButton label={t("fileTree.header.collapse")} onClick={onCollapseAll}>
          <ChevronsDownUp aria-hidden className="size-3.5" />
        </ActionButton>
      </div>
    </header>
  );
}
