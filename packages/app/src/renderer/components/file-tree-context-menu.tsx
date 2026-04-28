import type { ReactNode } from "react";
import {
  Copy,
  ExternalLink,
  FilePlus,
  FolderPlus,
  GitCompare,
  GitPullRequest,
  RotateCcw,
  Scissors,
  Search,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import type { WorkspaceFileKind, WorkspaceGitBadgeStatus } from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { FilePasteConflictStrategy } from "../../common/file-actions";
import type { FileClipboardItem, FileClipboardPendingCollision } from "../stores/file-clipboard-store";
import type { FileTreeCompareAnchor } from "../stores/file-tree-multi-select-store";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "./ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

export type FileTreeContextMenuKind = "file" | "folder" | "empty";
export type FileTreeContextMenuActionId =
  | "open"
  | "open-to-side"
  | "open-with-system"
  | "reveal"
  | "open-terminal"
  | "find-folder"
  | "cut"
  | "copy"
  | "paste"
  | "copy-path"
  | "copy-relative-path"
  | "rename"
  | "delete"
  | "new-file"
  | "new-folder"
  | "refresh"
  | "compare"
  | "stage"
  | "discard"
  | "view-diff";

export interface FileTreeContextMenuWorkspace {
  id: WorkspaceId;
  absolutePath: string;
  displayName: string;
}

export interface FileTreeContextMenuTarget {
  path: string;
  name: string;
  kind: WorkspaceFileKind;
  parentPath: string | null;
}

export interface FileTreeContextMenuActionPayload {
  workspaceId: WorkspaceId;
  path: string | null;
  kind: WorkspaceFileKind | "workspace";
  targetDirectory: string | null;
}

export interface FileTreeContextMenuProps {
  kind: FileTreeContextMenuKind;
  workspace: FileTreeContextMenuWorkspace;
  target?: FileTreeContextMenuTarget | null;
  sourceControlStatus?: WorkspaceGitBadgeStatus | null;
  sourceControlEnabled?: boolean;
  selectedItems?: FileClipboardItem[];
  compareAnchor?: FileTreeCompareAnchor | null;
  canPaste?: boolean;
  children: ReactNode;
  onOpen?(payload: FileTreeContextMenuActionPayload): void;
  onOpenToSide?(payload: FileTreeContextMenuActionPayload): void;
  onOpenWithSystemApp?(payload: FileTreeContextMenuActionPayload): void;
  onRevealInFinder?(payload: FileTreeContextMenuActionPayload): void;
  onOpenInTerminal?(payload: FileTreeContextMenuActionPayload): void;
  onBeginCreateFile?(parentPath?: string | null): void;
  onBeginCreateFolder?(parentPath?: string | null): void;
  onRefresh?(workspaceId: WorkspaceId): void;
  onCut?(items: FileClipboardItem[]): void;
  onCopy?(items: FileClipboardItem[]): void;
  onPaste?(payload: FileTreeContextMenuActionPayload): void;
  onCopyPath?(payload: FileTreeContextMenuActionPayload, pathKind: "absolute" | "relative"): void;
  onRename?(path: string, kind: WorkspaceFileKind): void;
  onDelete?(path: string, kind: WorkspaceFileKind): void;
  onDeleteItems?(items: FileClipboardItem[]): void;
  onCompare?(target: FileTreeContextMenuTarget, anchor: FileTreeCompareAnchor | null): void;
  onStage?(path: string): void;
  onDiscard?(path: string): void;
  onViewDiff?(path: string): void;
}

export interface FileTreeMenuItemDescriptor {
  id: FileTreeContextMenuActionId;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  disabledReason?: string;
  destructive?: boolean;
  separatorBefore?: boolean;
}

export interface CreateFileTreeContextMenuItemsInput {
  kind: FileTreeContextMenuKind;
  canPaste: boolean;
  sourceControlEnabled: boolean;
  hasSourceControlStatus: boolean;
  findInFolderEnabled?: boolean;
  compareEnabled?: boolean;
  compareAnchorName?: string | null;
}

const FIND_IN_FOLDER_DISABLED_REASON = "Folder-scoped SearchPanel handoff is deferred within the context-menu slice.";
const COMPARE_DISABLED_REASON = "Compare workflow is owned by T24.";
const SOURCE_CONTROL_CLEAN_DISABLED_REASON = "No source-control change is available for this path.";
const SOURCE_CONTROL_UNAVAILABLE_REASON = "Source Control store/API is unavailable.";

export function FileTreeContextMenu({
  kind,
  workspace,
  target = null,
  sourceControlStatus = null,
  sourceControlEnabled = false,
  selectedItems = [],
  compareAnchor = null,
  canPaste = false,
  children,
  ...handlers
}: FileTreeContextMenuProps): JSX.Element {
  const items = createFileTreeContextMenuItems({
    kind,
    canPaste,
    sourceControlEnabled,
    hasSourceControlStatus: Boolean(sourceControlStatus && sourceControlStatus !== "clean"),
    compareAnchorName: compareAnchor?.name ?? null,
    compareEnabled: kind === "file",
  });
  const payload = createMenuPayload(kind, workspace, target);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        data-file-tree-context-menu={kind}
        aria-label={fileTreeContextMenuLabel(kind, target, workspace)}
      >
        {items.map((item) => (
          <FileTreeContextMenuItem
            key={item.id}
            item={item}
            onSelect={(event) => {
              runFileTreeContextMenuAction(event, item.id, payload, target, handlers, {
                selectedItems,
                compareAnchor,
              });
            }}
          />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FileTreeContextMenuItem({
  item,
  onSelect,
}: {
  item: FileTreeMenuItemDescriptor;
  onSelect(event: MenuSelectEventLike): void;
}): JSX.Element {
  return (
    <>
      {item.separatorBefore ? <ContextMenuSeparator /> : null}
      <ContextMenuItem
        data-menu-item-id={item.id}
        disabled={item.disabled}
        title={item.disabledReason}
        variant={item.destructive ? "destructive" : "default"}
        onSelect={onSelect}
      >
        <MenuItemIcon id={item.id} destructive={item.destructive === true} />
        <span>{item.label}</span>
        {item.shortcut ? <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut> : null}
      </ContextMenuItem>
    </>
  );
}

export function createFileTreeContextMenuItems({
  kind,
  canPaste,
  sourceControlEnabled,
  hasSourceControlStatus,
  findInFolderEnabled = false,
  compareEnabled = false,
  compareAnchorName = null,
}: CreateFileTreeContextMenuItemsInput): FileTreeMenuItemDescriptor[] {
  const sourceControlDisabledReason = !sourceControlEnabled
    ? SOURCE_CONTROL_UNAVAILABLE_REASON
    : hasSourceControlStatus
      ? undefined
      : SOURCE_CONTROL_CLEAN_DISABLED_REASON;
  const sourceControlDisabled = sourceControlDisabledReason !== undefined;

  if (kind === "empty") {
    return [
      { id: "new-file", label: "New File", shortcut: "⌘N" },
      { id: "new-folder", label: "New Folder", shortcut: "⇧⌘N" },
      { id: "refresh", label: "Refresh", shortcut: "⌘R", separatorBefore: true },
      { id: "reveal", label: "Reveal Workspace in Finder" },
      { id: "open-terminal", label: "Open in Terminal" },
    ];
  }

  if (kind === "folder") {
    return [
      { id: "new-file", label: "New File", shortcut: "⌘N" },
      { id: "new-folder", label: "New Folder", shortcut: "⇧⌘N" },
      { id: "open-terminal", label: "Open in Terminal", separatorBefore: true },
      { id: "reveal", label: "Reveal in Finder" },
      {
        id: "find-folder",
        label: "Find in Folder",
        shortcut: "⇧⌘F",
        disabled: !findInFolderEnabled,
        disabledReason: findInFolderEnabled ? undefined : FIND_IN_FOLDER_DISABLED_REASON,
        separatorBefore: true,
      },
      { id: "cut", label: "Cut", shortcut: "⌘X", separatorBefore: true },
      { id: "copy", label: "Copy", shortcut: "⌘C" },
      { id: "paste", label: "Paste", shortcut: "⌘V", disabled: !canPaste, disabledReason: canPaste ? undefined : "Clipboard is empty." },
      { id: "copy-path", label: "Copy Path" },
      { id: "copy-relative-path", label: "Copy Relative Path" },
      { id: "rename", label: "Rename", shortcut: "F2", separatorBefore: true },
      { id: "delete", label: "Delete", shortcut: "⌫", destructive: true },
      { id: "stage", label: "Stage", disabled: sourceControlDisabled, disabledReason: sourceControlDisabledReason, separatorBefore: true },
      { id: "discard", label: "Discard Changes", disabled: sourceControlDisabled, disabledReason: sourceControlDisabledReason, destructive: true },
      { id: "view-diff", label: "View Diff", disabled: sourceControlDisabled, disabledReason: sourceControlDisabledReason },
    ];
  }

  return [
    { id: "open", label: "Open", shortcut: "↩" },
    { id: "open-to-side", label: "Open to the Side", shortcut: "⌘↩" },
    { id: "open-with-system", label: "Open With System App" },
    { id: "reveal", label: "Reveal in Finder", separatorBefore: true },
    { id: "open-terminal", label: "Open in Terminal" },
    {
      id: "find-folder",
      label: "Find in Folder",
      shortcut: "⇧⌘F",
      disabled: !findInFolderEnabled,
      disabledReason: findInFolderEnabled ? undefined : FIND_IN_FOLDER_DISABLED_REASON,
      separatorBefore: true,
    },
    { id: "cut", label: "Cut", shortcut: "⌘X", separatorBefore: true },
    { id: "copy", label: "Copy", shortcut: "⌘C" },
    { id: "paste", label: "Paste", shortcut: "⌘V", disabled: !canPaste, disabledReason: canPaste ? undefined : "Clipboard is empty." },
    { id: "copy-path", label: "Copy Path" },
    { id: "copy-relative-path", label: "Copy Relative Path" },
    { id: "rename", label: "Rename", shortcut: "F2", separatorBefore: true },
    { id: "delete", label: "Delete", shortcut: "⌫", destructive: true },
    {
      id: "compare",
      label: compareAnchorName ? `Compare with '${compareAnchorName}'` : "Select for Compare",
      disabled: !compareEnabled,
      disabledReason: compareEnabled ? undefined : COMPARE_DISABLED_REASON,
    },
    { id: "stage", label: "Stage", disabled: sourceControlDisabled, disabledReason: sourceControlDisabledReason, separatorBefore: true },
    { id: "discard", label: "Discard Changes", disabled: sourceControlDisabled, disabledReason: sourceControlDisabledReason, destructive: true },
    { id: "view-diff", label: "View Diff", disabled: sourceControlDisabled, disabledReason: sourceControlDisabledReason },
  ];
}

export function runFileTreeContextMenuAction(
  event: MenuSelectEventLike,
  actionId: FileTreeContextMenuActionId,
  payload: FileTreeContextMenuActionPayload,
  target: FileTreeContextMenuTarget | null,
  handlers: Omit<FileTreeContextMenuProps, "kind" | "workspace" | "target" | "children" | "sourceControlStatus" | "sourceControlEnabled" | "selectedItems" | "compareAnchor" | "canPaste">,
  options: {
    selectedItems?: readonly FileClipboardItem[];
    compareAnchor?: FileTreeCompareAnchor | null;
  } = {},
): void {
  if (isImeMenuSelectEvent(event)) {
    event.preventDefault();
    return;
  }

  const actionItems = contextActionItems(payload, target, options.selectedItems ?? []);

  switch (actionId) {
    case "open":
      handlers.onOpen?.(payload);
      return;
    case "open-to-side":
      handlers.onOpenToSide?.(payload);
      return;
    case "open-with-system":
      handlers.onOpenWithSystemApp?.(payload);
      return;
    case "reveal":
      handlers.onRevealInFinder?.(payload);
      return;
    case "open-terminal":
      handlers.onOpenInTerminal?.(payload);
      return;
    case "new-file":
      handlers.onBeginCreateFile?.(payload.targetDirectory);
      return;
    case "new-folder":
      handlers.onBeginCreateFolder?.(payload.targetDirectory);
      return;
    case "refresh":
      handlers.onRefresh?.(payload.workspaceId);
      return;
    case "cut":
      if (actionItems.length > 0) {
        handlers.onCut?.(actionItems);
      }
      return;
    case "copy":
      if (actionItems.length > 0) {
        handlers.onCopy?.(actionItems);
      }
      return;
    case "paste":
      handlers.onPaste?.(payload);
      return;
    case "copy-path":
      handlers.onCopyPath?.(payload, "absolute");
      return;
    case "copy-relative-path":
      handlers.onCopyPath?.(payload, "relative");
      return;
    case "rename":
      if (target) {
        handlers.onRename?.(target.path, target.kind);
      }
      return;
    case "delete":
      if (actionItems.length > 1) {
        handlers.onDeleteItems?.(actionItems);
      } else if (target) {
        handlers.onDelete?.(target.path, target.kind);
      }
      return;
    case "stage":
      if (target) {
        handlers.onStage?.(target.path);
      }
      return;
    case "discard":
      if (target) {
        handlers.onDiscard?.(target.path);
      }
      return;
    case "view-diff":
      if (target) {
        handlers.onViewDiff?.(target.path);
      }
      return;
    case "compare":
      if (target) {
        handlers.onCompare?.(target, options.compareAnchor ?? null);
      }
      return;
    case "find-folder":
      return;
  }
}

function contextActionItems(
  payload: FileTreeContextMenuActionPayload,
  target: FileTreeContextMenuTarget | null,
  selectedItems: readonly FileClipboardItem[],
): FileClipboardItem[] {
  if (target && selectedItems.some((item) => item.workspaceId === payload.workspaceId && item.path === target.path)) {
    return [...selectedItems];
  }

  return target ? [{ workspaceId: payload.workspaceId, path: target.path, kind: target.kind }] : [];
}

export function FileClipboardCollisionDialog({
  pendingCollision,
  onResolve,
  onCancel,
}: {
  pendingCollision: Pick<FileClipboardPendingCollision, "collisions"> | null;
  onResolve(strategy: Exclude<FilePasteConflictStrategy, "prompt">): void;
  onCancel(): void;
}): JSX.Element {
  if (!pendingCollision) {
    return <></>;
  }

  const firstCollision = pendingCollision?.collisions[0] ?? null;
  const collisionCount = pendingCollision?.collisions.length ?? 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-component="file-clipboard-collision-dialog">
        <DialogHeader>
          <DialogTitle>Replace existing file?</DialogTitle>
          <DialogDescription>
            {collisionCount === 1 && firstCollision
              ? `${firstCollision.targetPath} already exists.`
              : `${collisionCount} pasted items already exist.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="outline" onClick={() => onResolve("keep-both")}>
            Keep Both
          </Button>
          <Button type="button" variant="destructive" onClick={() => onResolve("replace")}>
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface MenuSelectEventLike {
  preventDefault(): void;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
  isComposing?: boolean;
  keyCode?: number;
}

export function isImeMenuSelectEvent(event: MenuSelectEventLike): boolean {
  return (
    event.isComposing === true ||
    event.nativeEvent?.isComposing === true ||
    event.keyCode === 229 ||
    event.nativeEvent?.keyCode === 229
  );
}

function createMenuPayload(
  kind: FileTreeContextMenuKind,
  workspace: FileTreeContextMenuWorkspace,
  target: FileTreeContextMenuTarget | null,
): FileTreeContextMenuActionPayload {
  if (!target) {
    return {
      workspaceId: workspace.id,
      path: null,
      kind: "workspace",
      targetDirectory: null,
    };
  }

  return {
    workspaceId: workspace.id,
    path: target.path,
    kind: target.kind,
    targetDirectory: target.kind === "directory" ? target.path : target.parentPath,
  };
}

function fileTreeContextMenuLabel(
  kind: FileTreeContextMenuKind,
  target: FileTreeContextMenuTarget | null,
  workspace: FileTreeContextMenuWorkspace,
): string {
  if (kind === "empty") {
    return `${workspace.displayName} file tree menu`;
  }

  return `${target?.name ?? workspace.displayName} ${kind} menu`;
}

function MenuItemIcon({
  id,
  destructive,
}: {
  id: FileTreeContextMenuActionId;
  destructive: boolean;
}): JSX.Element | null {
  const className = cn("text-muted-foreground", destructive && "text-destructive");

  switch (id) {
    case "new-file":
      return <FilePlus aria-hidden="true" className={className} />;
    case "new-folder":
      return <FolderPlus aria-hidden="true" className={className} />;
    case "open-with-system":
    case "reveal":
      return <ExternalLink aria-hidden="true" className={className} />;
    case "open-terminal":
      return <SquareTerminal aria-hidden="true" className={className} />;
    case "find-folder":
      return <Search aria-hidden="true" className={className} />;
    case "cut":
      return <Scissors aria-hidden="true" className={className} />;
    case "copy":
    case "copy-path":
    case "copy-relative-path":
      return <Copy aria-hidden="true" className={className} />;
    case "delete":
      return <Trash2 aria-hidden="true" className={className} />;
    case "compare":
    case "view-diff":
      return <GitCompare aria-hidden="true" className={className} />;
    case "stage":
      return <GitPullRequest aria-hidden="true" className={className} />;
    case "discard":
      return <RotateCcw aria-hidden="true" className={className} />;
    default:
      return null;
  }
}
