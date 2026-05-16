/**
 * Git file/group context-menu primitives for the Source Control panel.
 *
 * Menus intentionally mirror the lightweight GitMoreMenu popover pattern:
 * component-local open state, outside-click dismissal, Escape dismissal, and
 * data-driven item builders that tests can assert without a DOM menu library.
 */
import { useCallback, useEffect, useRef } from "react";
import type { GitExpandedGroupKey } from "../../../../../shared/git/types";
import { useDismissOnOutsideClick } from "../../../ui/use-dismiss-on-outside-click";

export interface GitContextMenuPoint {
  readonly x: number;
  readonly y: number;
}

interface GitMenuItemSpec {
  readonly kind: "item";
  readonly label: string;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly destructive?: boolean;
  readonly onSelect: () => void;
}

interface GitMenuSeparatorSpec {
  readonly kind: "separator";
}

export type GitMenuSpec = GitMenuItemSpec | GitMenuSeparatorSpec;

export interface GitFileContextMenuActions {
  readonly openFile: () => void;
  readonly openChanges: () => void;
  readonly markResolved?: () => void;
  readonly stage?: () => void;
  readonly unstage?: () => void;
  readonly discard?: () => void;
  readonly revealInOS: () => void;
  readonly copyPath: () => void;
  readonly copyRelativePath: () => void;
  readonly addToGitignore: () => void;
}

export interface GitGroupContextMenuActions {
  readonly stageAll?: () => void;
  readonly unstageAll?: () => void;
  readonly discardAll?: () => void;
  readonly addToGitignore?: () => void;
  readonly stashGroup?: () => void;
}

interface GitContextMenuPopoverProps {
  point: GitContextMenuPoint | null;
  items: GitMenuSpec[];
  onClose: () => void;
}

interface GitFileContextMenuProps {
  point: GitContextMenuPoint | null;
  groupKey: GitExpandedGroupKey;
  actions: GitFileContextMenuActions;
  onClose: () => void;
}

interface GitGroupContextMenuProps {
  point: GitContextMenuPoint | null;
  groupKey: GitExpandedGroupKey;
  actions: GitGroupContextMenuActions;
  onClose: () => void;
}

/** Renders a file-row context menu at the pointer or kebab position. */
export function GitFileContextMenu({ point, groupKey, actions, onClose }: GitFileContextMenuProps) {
  return (
    <GitContextMenuPopover
      point={point}
      items={buildGitFileContextMenuItems(groupKey, actions)}
      onClose={onClose}
    />
  );
}

/** Renders a group-header context menu at the pointer or kebab position. */
export function GitGroupContextMenu({
  point,
  groupKey,
  actions,
  onClose,
}: GitGroupContextMenuProps) {
  return (
    <GitContextMenuPopover
      point={point}
      items={buildGitGroupContextMenuItems(groupKey, actions)}
      onClose={onClose}
    />
  );
}

/** Builds the file-row menu with group-specific hide rules. */
export function buildGitFileContextMenuItems(
  groupKey: GitExpandedGroupKey,
  actions: GitFileContextMenuActions,
): GitMenuSpec[] {
  if (groupKey === "merge") {
    // Conflict rows open the in-app editor with the conflict-resolution
    // CodeLens UI — there is no external-editor escape hatch for this group.
    return collapseGitMenuSeparators([
      { kind: "item", label: "Open Diff", onSelect: actions.openChanges },
      {
        kind: "item",
        label: "Mark Resolved",
        disabled: !actions.markResolved,
        onSelect: actions.markResolved ?? noop,
      },
      { kind: "separator" },
      { kind: "item", label: "Discard", destructive: true, onSelect: actions.discard ?? noop },
    ]);
  }

  const items: GitMenuSpec[] = [{ kind: "item", label: "Open File", onSelect: actions.openFile }];

  if (groupKey !== "untracked") {
    items.push({ kind: "item", label: "Open Changes", onSelect: actions.openChanges });
  }

  items.push({ kind: "separator" });
  if (groupKey === "staged") {
    if (actions.unstage) items.push({ kind: "item", label: "Unstage", onSelect: actions.unstage });
  } else if (actions.stage) {
    items.push({ kind: "item", label: "Stage", onSelect: actions.stage });
  }

  if (groupKey !== "staged" && actions.discard) {
    items.push({ kind: "item", label: "Discard", destructive: true, onSelect: actions.discard });
  }

  items.push(
    { kind: "separator" },
    { kind: "item", label: revealInOSLabel(), onSelect: actions.revealInOS },
    { kind: "item", label: "Copy Path", onSelect: actions.copyPath },
    { kind: "item", label: "Copy Relative Path", onSelect: actions.copyRelativePath },
  );

  items.push(
    { kind: "separator" },
    { kind: "item", label: "Add to .gitignore", onSelect: actions.addToGitignore },
  );

  return collapseGitMenuSeparators(items);
}

/** Builds the group-header menu, keeping unsupported future operations disabled. */
export function buildGitGroupContextMenuItems(
  groupKey: GitExpandedGroupKey,
  actions: GitGroupContextMenuActions,
): GitMenuSpec[] {
  if (groupKey === "merge") {
    return collapseGitMenuSeparators([
      {
        kind: "item",
        label: "Stage All Resolved",
        disabled: true,
        onSelect: actions.stageAll ?? noop,
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Stash Changes in Group",
        disabled: true,
        onSelect: actions.stashGroup ?? noop,
      },
    ]);
  }

  const items: GitMenuSpec[] = [];
  if (groupKey === "staged" && actions.unstageAll) {
    items.push({ kind: "item", label: "Unstage All", onSelect: actions.unstageAll });
  }
  if (groupKey !== "staged" && actions.stageAll) {
    items.push({ kind: "item", label: "Stage All", onSelect: actions.stageAll });
  }
  if (groupKey !== "staged" && actions.discardAll) {
    items.push({
      kind: "item",
      label: "Discard All",
      destructive: true,
      onSelect: actions.discardAll,
    });
  }

  items.push(
    { kind: "separator" },
    {
      kind: "item",
      label: "Stash Changes in Group",
      disabled: !actions.stashGroup,
      onSelect: actions.stashGroup ?? noop,
    },
  );

  if (actions.addToGitignore) {
    items.push(
      { kind: "separator" },
      { kind: "item", label: "Add to .gitignore", onSelect: actions.addToGitignore },
    );
  }

  return collapseGitMenuSeparators(items);
}

/** Returns the platform-native label used for reveal-in-OS actions. */
export function revealInOSLabel(platform: string = detectPlatform()): string {
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Reveal in Explorer";
  return "Open Containing Folder";
}

/** Converts a mouse event into a fixed-position context-menu anchor point. */
export function pointFromMouseEvent(event: React.MouseEvent): GitContextMenuPoint {
  return { x: event.clientX, y: event.clientY };
}

/** Converts a kebab button rect into a fixed-position menu anchor point. */
export function pointFromButtonRect(rect: DOMRect): GitContextMenuPoint {
  return { x: rect.right - 188, y: rect.bottom + 2 };
}

/** Renders the shared fixed-position popover and wires dismiss behavior. */
function GitContextMenuPopover({ point, items, onClose }: GitContextMenuPopoverProps) {
  const open = point !== null;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useDismissOnOutsideClick(wrapperRef, open, close);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!point) return null;

  return (
    <div
      ref={wrapperRef}
      role="menu"
      className="fixed z-50 min-w-[188px] rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
      style={popoverPositionStyle(point)}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item.kind === "separator" ? (
          <MenuSeparator key={`separator-${previousMenuLabel(items, index) ?? "leading"}`} />
        ) : (
          <MenuButton
            key={item.label}
            label={item.label}
            disabled={item.disabled}
            title={item.title}
            destructive={item.destructive}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
          />
        ),
      )}
    </div>
  );
}

/** Keeps the context menu inside the viewport when dimensions are available. */
function popoverPositionStyle(point: GitContextMenuPoint): React.CSSProperties {
  if (typeof window === "undefined") return { left: point.x, top: point.y };
  return {
    left: Math.max(4, Math.min(point.x, window.innerWidth - 196)),
    top: Math.max(4, Math.min(point.y, window.innerHeight - 280)),
  };
}

/** Renders one context-menu button using the GitMoreMenu visual treatment. */
function MenuButton({
  label,
  disabled,
  title,
  destructive,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  title?: string;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      className={
        destructive
          ? "flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm git-destructive-text hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          : "flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** Renders the separator shared by file and group context menus. */
function MenuSeparator() {
  return <hr className="my-1 h-px border-0 bg-mist-border" />;
}

/** Removes leading/trailing/consecutive separators from generated menus. */
function collapseGitMenuSeparators(items: GitMenuSpec[]): GitMenuSpec[] {
  const out: GitMenuSpec[] = [];
  for (const item of items) {
    if (item.kind === "separator") {
      if (out.length === 0 || out[out.length - 1].kind === "separator") continue;
    }
    out.push(item);
  }
  while (out.length > 0 && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

/** Finds the closest previous item label to anchor a separator React key. */
function previousMenuLabel(items: GitMenuSpec[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "item") return item.label;
  }
  return null;
}

/** Reads the preload platform bridge when available and falls back to macOS. */
function detectPlatform(): string {
  if (typeof window !== "undefined" && window.host?.platform) return window.host.platform;
  const proc = (globalThis as { process?: { platform?: string } }).process;
  return proc?.platform ?? "darwin";
}

/** No-op placeholder for disabled future menu hooks. */
function noop(): void {}
