/**
 * Git file/group context menus for the Source Control panel.
 *
 * A row keeps where its menu is open; the menu is the shared
 * DropdownMenuAtPoint. Its items come from builders that tests assert
 * without a DOM.
 */
import i18next from "i18next";
import type { GitExpandedGroupKey } from "../../../../../shared/git/types";
import { revealInOSLabel } from "../../../../utils/reveal-label";
import {
  DropdownMenuAtPoint,
  DropdownMenuItem,
  type DropdownMenuPoint,
  DropdownMenuSeparator,
} from "../../../ui/dropdown-menu";

export type GitContextMenuPoint = DropdownMenuPoint;

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
  const t = i18next.t.bind(i18next);
  if (groupKey === "merge") {
    // Conflict rows open the in-app editor with the conflict-resolution
    // CodeLens UI — there is no external-editor escape hatch for this group.
    return collapseGitMenuSeparators([
      { kind: "item", label: t("files:git.contextMenu.openDiff"), onSelect: actions.openChanges },
      {
        kind: "item",
        label: t("files:git.contextMenu.markResolved"),
        disabled: !actions.markResolved,
        onSelect: actions.markResolved ?? noop,
      },
      { kind: "separator" },
      {
        kind: "item",
        label: t("files:git.contextMenu.discard"),
        destructive: true,
        onSelect: actions.discard ?? noop,
      },
    ]);
  }

  const items: GitMenuSpec[] = [
    { kind: "item", label: t("files:git.contextMenu.openFile"), onSelect: actions.openFile },
  ];

  if (groupKey !== "untracked") {
    items.push({
      kind: "item",
      label: t("files:git.contextMenu.openChanges"),
      onSelect: actions.openChanges,
    });
  }

  items.push({ kind: "separator" });
  if (groupKey === "staged") {
    if (actions.unstage)
      items.push({
        kind: "item",
        label: t("files:git.contextMenu.unstage"),
        onSelect: actions.unstage,
      });
  } else if (actions.stage) {
    items.push({ kind: "item", label: t("files:git.contextMenu.stage"), onSelect: actions.stage });
  }

  if (groupKey !== "staged" && actions.discard) {
    items.push({
      kind: "item",
      label: t("files:git.contextMenu.discard"),
      destructive: true,
      onSelect: actions.discard,
    });
  }

  items.push(
    { kind: "separator" },
    { kind: "item", label: revealInOSLabel(), onSelect: actions.revealInOS },
    { kind: "item", label: t("files:git.contextMenu.copyPath"), onSelect: actions.copyPath },
    {
      kind: "item",
      label: t("files:git.contextMenu.copyRelativePath"),
      onSelect: actions.copyRelativePath,
    },
  );

  items.push(
    { kind: "separator" },
    {
      kind: "item",
      label: t("files:git.contextMenu.addToGitignore"),
      onSelect: actions.addToGitignore,
    },
  );

  return collapseGitMenuSeparators(items);
}

/** Builds the group-header menu, keeping unsupported future operations disabled. */
export function buildGitGroupContextMenuItems(
  groupKey: GitExpandedGroupKey,
  actions: GitGroupContextMenuActions,
): GitMenuSpec[] {
  const t = i18next.t.bind(i18next);
  if (groupKey === "merge") {
    return collapseGitMenuSeparators([
      {
        kind: "item",
        label: t("files:git.contextMenu.stageAllResolved"),
        disabled: true,
        onSelect: actions.stageAll ?? noop,
      },
      { kind: "separator" },
      {
        kind: "item",
        label: t("files:git.contextMenu.stashChangesInGroup"),
        disabled: true,
        onSelect: actions.stashGroup ?? noop,
      },
    ]);
  }

  const items: GitMenuSpec[] = [];
  if (groupKey === "staged" && actions.unstageAll) {
    items.push({
      kind: "item",
      label: t("files:git.contextMenu.unstageAll"),
      onSelect: actions.unstageAll,
    });
  }
  if (groupKey !== "staged" && actions.stageAll) {
    items.push({
      kind: "item",
      label: t("files:git.contextMenu.stageAll"),
      onSelect: actions.stageAll,
    });
  }
  if (groupKey !== "staged" && actions.discardAll) {
    items.push({
      kind: "item",
      label: t("files:git.contextMenu.discardAll"),
      destructive: true,
      onSelect: actions.discardAll,
    });
  }

  items.push(
    { kind: "separator" },
    {
      kind: "item",
      label: t("files:git.contextMenu.stashChangesInGroup"),
      disabled: !actions.stashGroup,
      onSelect: actions.stashGroup ?? noop,
    },
  );

  if (actions.addToGitignore) {
    items.push(
      { kind: "separator" },
      {
        kind: "item",
        label: t("files:git.contextMenu.addToGitignore"),
        onSelect: actions.addToGitignore,
      },
    );
  }

  return collapseGitMenuSeparators(items);
}

/** Converts a mouse event into a fixed-position context-menu anchor point. */
export function pointFromMouseEvent(event: React.MouseEvent): GitContextMenuPoint {
  return { x: event.clientX, y: event.clientY };
}

/** The point under a kebab button that its menu's right edge lines up with. */
export function pointFromButtonRect(rect: DOMRect): GitContextMenuPoint {
  return { x: rect.right, y: rect.bottom + 2, align: "end" };
}

/** Renders the menu at its point. */
function GitContextMenuPopover({ point, items, onClose }: GitContextMenuPopoverProps) {
  return (
    <DropdownMenuAtPoint point={point} onClose={onClose}>
      {items.map((item, index) =>
        item.kind === "separator" ? (
          <DropdownMenuSeparator
            key={`separator-${previousMenuLabel(items, index) ?? "leading"}`}
          />
        ) : (
          <DropdownMenuItem
            key={item.label}
            disabled={item.disabled}
            tooltip={item.title}
            className={item.destructive ? "git-destructive-text" : undefined}
            onSelect={item.onSelect}
          >
            {item.label}
          </DropdownMenuItem>
        ),
      )}
    </DropdownMenuAtPoint>
  );
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

/** No-op placeholder for disabled future menu hooks. */
function noop(): void {}
