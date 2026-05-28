import { useMemo, useState } from "react";
import { useDragSource } from "@/components/ui/use-drag-source";
import { buildFileDragPayload } from "@/components/workspace/dnd/payload";
import { MIME_FILE } from "@/components/workspace/dnd/types";
import { distinctParents } from "@/services/fs-mutations/distinct-parents";
import { useFilesStore } from "@/state/stores/files";
import { cn } from "@/utils/cn";
import { basename } from "@/utils/path";
import type { TreeNode } from "../../../state/stores/files";
import {
  type GitDecorationKind,
  kindToColorVar,
  kindToLetter,
  kindToTooltip,
} from "./git-decoration";
import { FOLDER_ICON, FOLDER_OPEN_ICON, getFileIcon } from "./icons";
import { indentPaddingLeft, ROW_HEIGHT_PX } from "./metrics";

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
  /**
   * HTML `id` for ARIA aria-activedescendant (Phase F).
   * Set by the parent via `encodeRowId(absPath)` so the tree container can
   * point `aria-activedescendant` at the focused row's id.
   */
  id?: string;
  workspaceId: string;
  absPath: string;
  node: TreeNode;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  /**
   * True when this row holds the keyboard focus (VSCode-parity: focus Trait).
   * Received in Phase A but not yet used for styling — Phase B will apply the
   * focus ring / indicator once the full 4-state visual is in place.
   */
  isFocused?: boolean;
  isLoading?: boolean;
  /**
   * True when this row represents the workspace root. The root is never
   * draggable — drag-source semantics for the workspace itself have no
   * destination. Directories OTHER than the root are draggable like files.
   */
  isRoot?: boolean;
  /**
   * Git decoration kind for this row, if any. Files surface a colored
   * letter chip; directories surface only the propagated chip (no name
   * recoloring) so deep trees do not feel noisy (design.md §1 — color
   * carried by the chip glyph alone).
   */
  decoration?: GitDecorationKind;
  /**
   * True when the file is matched by `.gitignore`. Dims the row so
   * ignored entries (e.g. inside `node_modules`) recede visually. Folder
   * rows never receive this — only files Git confirms as ignored.
   */
  isIgnored?: boolean;
  /** True when this row is in the cut clipboard (VSCode parity: dimmed). */
  isCut?: boolean;
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
  id,
  workspaceId,
  absPath,
  node,
  depth,
  isExpanded,
  isSelected,
  isFocused = false,
  isLoading = false,
  isRoot = false,
  decoration,
  isIgnored = false,
  isCut = false,
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
    <button
      id={id}
      type="button"
      role="treeitem"
      // WAI-ARIA tree widget pattern: with `aria-activedescendant` on the
      // container (file-tree/index.tsx), every descendant `treeitem` must
      // sit outside the tab order. Keyboard navigation uses the container's
      // single tab stop + Arrow keys; the focused row is surfaced via
      // `aria-activedescendant` (row id), not via DOM focus. Mirrors
      // VSCode's listView pattern (rows hold tabIndex=-1, container=0).
      tabIndex={-1}
      aria-level={depth + 1}
      aria-expanded={isDir ? isExpanded : undefined}
      aria-selected={isSelected}
      onClick={isDir ? onToggle : (e) => onClick(e)}
      onDoubleClick={isDir ? undefined : onDoubleClick}
      onContextMenu={onContextMenu}
      title={node.name}
      // DnD hit-testing: the drop-target hook walks up to the [role="treeitem"]
      // element and reads these to decide whether the cursor is over a valid
      // directory drop target and which path to drop into.
      data-file-tree-row-type={node.type}
      data-file-tree-row-path={absPath}
      draggable={!isRoot}
      onDragStart={isRoot ? undefined : handleDragStart}
      onDragEnd={isRoot ? undefined : () => setIsDragging(false)}
      style={{ paddingLeft: indentPaddingLeft(depth), height: ROW_HEIGHT_PX }}
      className={cn(
        "flex items-center w-full text-left cursor-pointer select-none",
        // Reserve a 2px left indicator slot (design.md §8 — selected state uses
        // a left indicator alongside background change; redundant encoding).
        "border-l-2 border-l-transparent",
        "hover:bg-[var(--state-hover-bg)]",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] focus-visible:ring-inset",
        // Selected: sidebar-region selected tokens + state.selected.indicator
        // (matches workbench/sidebar.tsx — single selection vocabulary across
        // sibling sidebar regions).
        isSelected &&
          "bg-[var(--sidebar-item-selected-bg)] border-l-[var(--state-selected-indicator)] text-[var(--sidebar-item-selected-fg)]",
        // Focus: dotted 1px inset outline marks the keyboard-cursor row in multi-select
        // (design.md §10 sidebar.item.focus.border — separate from state.focus.ring which
        // drives form-control :focus-visible rings globally). isFocused is distinct from
        // isSelected: a row can be focused without being in the selection set (e.g. after
        // Escape clears the range but keeps the cursor). Cleared when dragging so the
        // drag overlay is the sole visual anchor.
        isFocused &&
          !isDragging &&
          "outline outline-1 outline-dotted outline-offset-[-1px] outline-[var(--sidebar-item-focus-border)]",
        // Cut state: opacified + muted border (redundant encoding, WCAG 1.4.1).
        // The data attribute is consumed by the DnD hook for DOM hit-testing and
        // by CSS selectors in globals.css for visual styling.
        isCut && "opacity-40 border-l-[var(--state-disabled-border)]",
        // Drag source: fade while this row is the one being dragged.
        isDragging && "opacity-40",
      )}
    >
      {isDir ? (
        <ChevronRightIcon
          className={cn(
            // §14 closed icon grid: size-3 (12px) only. text-[var(--sidebar-icon-fg)]
            // routes through the semantic layer instead of the stoneGray primitive.
            "size-3 shrink-0 text-[var(--sidebar-icon-fg)] transition-transform duration-150 ease-out",
            isExpanded && "rotate-90",
            isLoading && "opacity-50 animate-pulse",
          )}
        />
      ) : (
        <span className="size-3 shrink-0" aria-hidden />
      )}
      <TypeIcon
        className={cn(
          "size-3 shrink-0 ml-1 text-[var(--sidebar-icon-fg)]",
          isLoading && "opacity-50 animate-pulse",
        )}
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <span
        className={cn(
          "ml-2 truncate min-w-0 text-app-body",
          // Ignored rows recede visually — VSCode parity.
          isIgnored && "opacity-50",
        )}
        // Filename color mirrors VSCode's git decoration (added=green,
        // modified=yellow, deleted/conflict=red, untracked=blue, renamed=
        // muted). Inline style wins over the button's selected-fg color
        // cascade so the git signal stays visible on selected rows.
        // Ignored rows without an explicit status entry still pick up the
        // muted ignored fg on top of opacity-50 for a stronger receding cue.
        style={effectiveNameColor(decoration, isIgnored)}
      >
        {node.name}
      </span>
      {decoration !== undefined && <GitDecorationChip kind={decoration} />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Decoration chip — single colored character at the row's trailing edge.
// Mirrors the Source Control panel's GitStatusBadge but trims size+spacing
// to fit the trailing slot of an explorer row.
// ---------------------------------------------------------------------------

/**
 * Resolves the inline color style for the filename text. Returns
 * `undefined` when no git signal applies — the row then inherits the
 * normal foreground from its surface tokens.
 *
 * Precedence: an explicit decoration kind (M/A/D/R/U/!) always wins; the
 * ignored case applies only to files Git confirmed as ignored AND that
 * carry no other status (a path cannot be untracked and ignored at the
 * same time in porcelain v2).
 */
function effectiveNameColor(
  decoration: GitDecorationKind | undefined,
  isIgnored: boolean,
): React.CSSProperties | undefined {
  if (decoration !== undefined) return { color: kindToColorVar(decoration) };
  if (isIgnored) return { color: kindToColorVar("ignored") };
  return undefined;
}

function GitDecorationChip({ kind }: { kind: GitDecorationKind }) {
  const letter = kindToLetter(kind);
  const tooltip = kindToTooltip(kind);
  return (
    <span
      className="ml-auto pl-1 pr-2 inline-flex shrink-0 items-center justify-center font-mono text-app-ui-sm leading-none"
      style={{ color: kindToColorVar(kind) }}
      role="img"
      aria-label={`Git ${tooltip}`}
      title={tooltip}
    >
      {letter}
    </span>
  );
}
