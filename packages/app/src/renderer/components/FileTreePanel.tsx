import {
  Check,
  ChevronDown,
  ChevronRight,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";

import type {
  E4FileKind,
  E4FileTreeNode,
  E4GitBadgeStatus,
} from "../../../../shared/src/contracts/e4-editor";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import type { OpenSessionWorkspace } from "../../../../shared/src/contracts/workspace-shell";
import type {
  EditorFileTreeState,
  EditorPendingExplorerDelete,
  EditorPendingExplorerEdit,
  EditorTreeSelectionMovement,
} from "../stores/editor-store";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { EmptyState } from "./EmptyState";
import { ScrollArea } from "./ui/scroll-area";

export interface FileTreePanelProps {
  activeWorkspace: OpenSessionWorkspace | null;
  fileTree: EditorFileTreeState;
  expandedPaths: Record<string, true>;
  gitBadgeByPath: Record<string, E4GitBadgeStatus>;
  selectedTreePath?: string | null;
  pendingExplorerEdit?: EditorPendingExplorerEdit | null;
  pendingExplorerDelete?: EditorPendingExplorerDelete | null;
  onRefresh(workspaceId: WorkspaceId): void;
  onToggleDirectory(path: string): void;
  onOpenFile(workspaceId: WorkspaceId, path: string): void;
  onCreateNode(workspaceId: WorkspaceId, path: string, kind: E4FileKind): void;
  onDeleteNode(workspaceId: WorkspaceId, path: string, kind: E4FileKind): void;
  onRenameNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): void;
  onSelectTreePath?(path: string | null): void;
  onBeginCreateFile?(parentPath?: string | null): void;
  onBeginCreateFolder?(parentPath?: string | null): void;
  onBeginRename?(path: string, kind: E4FileKind): void;
  onBeginDelete?(path: string, kind: E4FileKind): void;
  onCancelExplorerEdit?(): void;
  onCollapseAll?(workspaceId: WorkspaceId): void;
  onMoveTreeSelection?(movement: EditorTreeSelectionMovement): void;
}

export function FileTreePanel(props: FileTreePanelProps): JSX.Element {
  const workspaceId = props.activeWorkspace?.id ?? null;

  return (
    <section
      data-component="file-tree-panel"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-sidebar-border bg-sidebar/80 text-sidebar-foreground"
    >
      <header className="flex shrink-0 flex-col gap-2 border-b border-sidebar-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold uppercase tracking-[0.14em] text-sidebar-foreground">
              Files
            </h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {props.activeWorkspace?.displayName ?? "No workspace selected"}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <Button
            type="button"
            data-action="file-tree-new-file"
            variant="ghost"
            size="xs"
            disabled={!workspaceId || !props.onBeginCreateFile}
            className="justify-start"
            onClick={() => {
              props.onBeginCreateFile?.();
            }}
          >
            <FilePlus aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            New File
          </Button>
          <Button
            type="button"
            data-action="file-tree-new-folder"
            variant="ghost"
            size="xs"
            disabled={!workspaceId || !props.onBeginCreateFolder}
            className="justify-start"
            onClick={() => {
              props.onBeginCreateFolder?.();
            }}
          >
            <FolderPlus aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            New Folder
          </Button>
          <Button
            type="button"
            data-action="file-tree-refresh"
            variant="ghost"
            size="xs"
            disabled={!workspaceId || props.fileTree.loading}
            className="justify-start"
            onClick={() => {
              if (workspaceId) {
                props.onRefresh(workspaceId);
              }
            }}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn("size-3.5", props.fileTree.loading && "animate-spin")}
              strokeWidth={1.75}
            />
            Refresh
          </Button>
          <Button
            type="button"
            data-action="file-tree-collapse-all"
            variant="ghost"
            size="xs"
            disabled={!workspaceId || !props.onCollapseAll}
            className="justify-start"
            onClick={() => {
              if (workspaceId) {
                props.onCollapseAll?.(workspaceId);
              }
            }}
          >
            <ChevronRight aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            Collapse All
          </Button>
        </div>
      </header>

      <FileTreePanelBody {...props} />
    </section>
  );
}

function FileTreePanelBody(props: FileTreePanelProps): JSX.Element {
  const workspace = props.activeWorkspace;
  if (!workspace) {
    return (
      <div className="min-h-0 flex-1">
        <EmptyState
          icon={FolderOpen}
          title="No workspace selected"
          description="Open a workspace to browse files."
        />
      </div>
    );
  }

  if (props.fileTree.errorMessage) {
    return (
      <div className="min-h-0 flex-1">
        <EmptyState
          icon={Folder}
          title="Files unavailable"
          description={props.fileTree.errorMessage}
        />
      </div>
    );
  }

  if (props.fileTree.loading && props.fileTree.nodes.length === 0) {
    return <PanelMessage>Loading files…</PanelMessage>;
  }

  const rootCreateEdit = pendingCreateForParent(props.pendingExplorerEdit, workspace.id, null);
  if (props.fileTree.nodes.length === 0 && !rootCreateEdit) {
    return (
      <div className="min-h-0 flex-1">
        <EmptyState
          icon={Folder}
          title="No files"
          description={`Create a file or folder in ${workspace.displayName} to begin editing.`}
        />
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ol
        role="tree"
        tabIndex={0}
        data-action="file-tree"
        data-active-path={props.selectedTreePath ?? ""}
        aria-label={`${workspace.displayName} files`}
        aria-activedescendant={props.selectedTreePath ? treeItemId(workspace.id, props.selectedTreePath) : undefined}
        aria-busy={props.fileTree.loading ? "true" : undefined}
        className="space-y-0.5 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={(event) => {
          handleTreeKeyDown(event, workspace.id, props);
        }}
      >
        {rootCreateEdit ? (
          <FileTreeCreateRow
            edit={rootCreateEdit}
            depth={0}
            workspaceId={workspace.id}
            onCreateNode={props.onCreateNode}
            onCancelExplorerEdit={props.onCancelExplorerEdit}
          />
        ) : null}
        {props.fileTree.nodes.map((node) => (
          <FileTreeNodeRow
            key={node.path}
            node={node}
            depth={0}
            parentPath={null}
            workspaceId={workspace.id}
            selectedTreePath={props.selectedTreePath ?? null}
            pendingExplorerEdit={props.pendingExplorerEdit ?? null}
            pendingExplorerDelete={props.pendingExplorerDelete ?? null}
            expandedPaths={props.expandedPaths}
            gitBadgeByPath={props.gitBadgeByPath}
            onToggleDirectory={props.onToggleDirectory}
            onOpenFile={props.onOpenFile}
            onDeleteNode={props.onDeleteNode}
            onRenameNode={props.onRenameNode}
            onSelectTreePath={props.onSelectTreePath}
            onBeginRename={props.onBeginRename}
            onBeginDelete={props.onBeginDelete}
            onCancelExplorerEdit={props.onCancelExplorerEdit}
            onCreateNode={props.onCreateNode}
          />
        ))}
      </ol>
    </ScrollArea>
  );
}

function FileTreeNodeRow({
  node,
  depth,
  parentPath,
  workspaceId,
  selectedTreePath,
  pendingExplorerEdit,
  pendingExplorerDelete,
  expandedPaths,
  gitBadgeByPath,
  onToggleDirectory,
  onOpenFile,
  onDeleteNode,
  onRenameNode,
  onSelectTreePath,
  onBeginRename,
  onBeginDelete,
  onCancelExplorerEdit,
  onCreateNode,
}: {
  node: E4FileTreeNode;
  depth: number;
  parentPath: string | null;
  workspaceId: WorkspaceId;
  selectedTreePath: string | null;
  pendingExplorerEdit: EditorPendingExplorerEdit | null;
  pendingExplorerDelete: EditorPendingExplorerDelete | null;
  expandedPaths: Record<string, true>;
  gitBadgeByPath: Record<string, E4GitBadgeStatus>;
  onToggleDirectory(path: string): void;
  onOpenFile(workspaceId: WorkspaceId, path: string): void;
  onDeleteNode(workspaceId: WorkspaceId, path: string, kind: E4FileKind): void;
  onRenameNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): void;
  onSelectTreePath?(path: string | null): void;
  onBeginRename?(path: string, kind: E4FileKind): void;
  onBeginDelete?(path: string, kind: E4FileKind): void;
  onCancelExplorerEdit?(): void;
  onCreateNode(workspaceId: WorkspaceId, path: string, kind: E4FileKind): void;
}): JSX.Element {
  const isDirectory = node.kind === "directory";
  const childCreateEdit = pendingCreateForParent(pendingExplorerEdit, workspaceId, node.path);
  const expanded = Boolean(expandedPaths[node.path]) || Boolean(childCreateEdit);
  const isSelected = selectedTreePath === node.path;
  const isRenaming = pendingRenameForPath(pendingExplorerEdit, workspaceId, node.path);
  const isDeleting = pendingDeleteForPath(pendingExplorerDelete, workspaceId, node.path);
  const Icon = isDirectory ? (expanded ? FolderOpen : Folder) : File;
  const badge = gitBadgeByPath[node.path] ?? node.gitBadge ?? null;

  return (
    <li
      id={treeItemId(workspaceId, node.path)}
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={isDirectory ? expanded : undefined}
      data-file-tree-row="true"
      data-file-tree-kind={node.kind}
      data-file-tree-path={node.path}
      data-selected={isSelected ? "true" : "false"}
      data-active={isSelected ? "true" : "false"}
      className="outline-none"
    >
      <div
        className={cn(
          "group flex min-h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs text-sidebar-foreground hover:bg-accent hover:text-accent-foreground",
          isSelected && "bg-accent text-accent-foreground ring-1 ring-ring/30",
          isDeleting && "bg-destructive/10 text-destructive ring-1 ring-destructive/25",
        )}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {isDirectory ? (
          <button
            type="button"
            data-action="file-tree-toggle"
            data-path={node.path}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              onSelectTreePath?.(node.path);
              onToggleDirectory(node.path);
            }}
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            ) : (
              <ChevronRight aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            )}
          </button>
        ) : (
          <span className="size-5 shrink-0" aria-hidden="true" />
        )}

        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />

        {isRenaming ? (
          <FileTreeRenameForm
            node={node}
            workspaceId={workspaceId}
            parentPath={parentPath}
            onRenameNode={onRenameNode}
            onCancelExplorerEdit={onCancelExplorerEdit}
          />
        ) : (
          <button
            type="button"
            data-action={isDirectory ? "file-tree-toggle-row" : "file-tree-open-file"}
            data-path={node.path}
            aria-current={isSelected ? "true" : undefined}
            className="min-w-0 flex-1 truncate rounded-sm py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              onSelectTreePath?.(node.path);
              if (isDirectory) {
                onToggleDirectory(node.path);
              } else {
                onOpenFile(workspaceId, node.path);
              }
            }}
          >
            {node.name}
          </button>
        )}

        {!isRenaming ? <GitBadge path={node.path} status={badge} /> : null}

        {!isRenaming ? (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            <Button
              type="button"
              data-action="file-tree-rename"
              data-path={node.path}
              aria-label={`Rename ${node.name}`}
              variant="ghost"
              size="icon-xs"
              className="size-6 text-muted-foreground hover:text-foreground"
              disabled={!onBeginRename}
              onClick={() => {
                onBeginRename?.(node.path, node.kind);
              }}
            >
              <Pencil aria-hidden="true" className="size-3" strokeWidth={1.75} />
            </Button>
            <Button
              type="button"
              data-action="file-tree-delete"
              data-path={node.path}
              aria-label={`Delete ${node.name}`}
              variant="ghost"
              size="icon-xs"
              className="size-6 text-muted-foreground hover:text-destructive"
              disabled={!onBeginDelete}
              onClick={() => {
                onBeginDelete?.(node.path, node.kind);
              }}
            >
              <Trash2 aria-hidden="true" className="size-3" strokeWidth={1.75} />
            </Button>
          </div>
        ) : null}
      </div>

      {isDeleting ? (
        <FileTreeDeleteConfirmation
          node={node}
          depth={depth}
          workspaceId={workspaceId}
          onDeleteNode={onDeleteNode}
          onCancelExplorerEdit={onCancelExplorerEdit}
        />
      ) : null}

      {isDirectory && expanded ? (
        <ol role="group" className="space-y-0.5" aria-label={`${node.name} children`}>
          {childCreateEdit ? (
            <FileTreeCreateRow
              edit={childCreateEdit}
              depth={depth + 1}
              workspaceId={workspaceId}
              onCreateNode={onCreateNode}
              onCancelExplorerEdit={onCancelExplorerEdit}
            />
          ) : null}
          {node.children?.map((child) => (
            <FileTreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              parentPath={node.path}
              workspaceId={workspaceId}
              selectedTreePath={selectedTreePath}
              pendingExplorerEdit={pendingExplorerEdit}
              pendingExplorerDelete={pendingExplorerDelete}
              expandedPaths={expandedPaths}
              gitBadgeByPath={gitBadgeByPath}
              onToggleDirectory={onToggleDirectory}
              onOpenFile={onOpenFile}
              onDeleteNode={onDeleteNode}
              onRenameNode={onRenameNode}
              onSelectTreePath={onSelectTreePath}
              onBeginRename={onBeginRename}
              onBeginDelete={onBeginDelete}
              onCancelExplorerEdit={onCancelExplorerEdit}
              onCreateNode={onCreateNode}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function FileTreeCreateRow({
  edit,
  depth,
  workspaceId,
  onCreateNode,
  onCancelExplorerEdit,
}: {
  edit: Extract<EditorPendingExplorerEdit, { type: "create" }>;
  depth: number;
  workspaceId: WorkspaceId;
  onCreateNode(workspaceId: WorkspaceId, path: string, kind: E4FileKind): void;
  onCancelExplorerEdit?(): void;
}): JSX.Element {
  const Icon = edit.kind === "directory" ? Folder : File;
  const label = edit.kind === "directory" ? "New folder name" : "New file name";

  return (
    <li
      role="treeitem"
      data-action="file-tree-create-row"
      data-file-tree-kind={edit.kind}
      data-parent-path={edit.parentPath ?? ""}
      aria-selected="false"
    >
      <form
        data-action="file-tree-create-form"
        className="flex min-h-7 min-w-0 items-center gap-1 rounded-md bg-accent/60 px-1.5 text-xs text-accent-foreground ring-1 ring-ring/25"
        style={{ paddingLeft: `${depth * 12 + 31}px` }}
        onSubmit={(event) => {
          handleCreateSubmit(event, workspaceId, edit, onCreateNode);
        }}
        onKeyDown={(event) => {
          handleEditFormKeyDown(event, onCancelExplorerEdit);
        }}
      >
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <input
          name="basename"
          aria-label={label}
          autoFocus
          className="h-6 min-w-0 flex-1 rounded-sm border border-sidebar-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={edit.kind === "directory" ? "folder-name" : "file-name"}
        />
        <Button type="submit" data-action="file-tree-create-confirm" variant="outline" size="icon-xs" aria-label="Create">
          <Check aria-hidden="true" className="size-3" strokeWidth={1.75} />
        </Button>
        <Button
          type="button"
          data-action="file-tree-cancel-edit"
          variant="ghost"
          size="icon-xs"
          aria-label="Cancel create"
          onClick={() => {
            onCancelExplorerEdit?.();
          }}
        >
          <X aria-hidden="true" className="size-3" strokeWidth={1.75} />
        </Button>
      </form>
    </li>
  );
}

function FileTreeRenameForm({
  node,
  workspaceId,
  parentPath,
  onRenameNode,
  onCancelExplorerEdit,
}: {
  node: E4FileTreeNode;
  workspaceId: WorkspaceId;
  parentPath: string | null;
  onRenameNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): void;
  onCancelExplorerEdit?(): void;
}): JSX.Element {
  return (
    <form
      data-action="file-tree-rename-form"
      data-path={node.path}
      className="flex min-w-0 flex-1 items-center gap-1 py-0.5"
      onSubmit={(event) => {
        handleRenameSubmit(event, workspaceId, node.path, parentPath, onRenameNode, onCancelExplorerEdit);
      }}
      onKeyDown={(event) => {
        handleEditFormKeyDown(event, onCancelExplorerEdit);
      }}
    >
      <input
        name="basename"
        aria-label={`Rename ${node.name} basename`}
        autoFocus
        defaultValue={basenameForPath(node.path)}
        className="h-6 min-w-0 flex-1 rounded-sm border border-sidebar-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button type="submit" data-action="file-tree-rename-confirm" variant="outline" size="icon-xs" aria-label="Rename">
        <Check aria-hidden="true" className="size-3" strokeWidth={1.75} />
      </Button>
      <Button
        type="button"
        data-action="file-tree-cancel-edit"
        variant="ghost"
        size="icon-xs"
        aria-label="Cancel rename"
        onClick={() => {
          onCancelExplorerEdit?.();
        }}
      >
        <X aria-hidden="true" className="size-3" strokeWidth={1.75} />
      </Button>
    </form>
  );
}

function FileTreeDeleteConfirmation({
  node,
  depth,
  workspaceId,
  onDeleteNode,
  onCancelExplorerEdit,
}: {
  node: E4FileTreeNode;
  depth: number;
  workspaceId: WorkspaceId;
  onDeleteNode(workspaceId: WorkspaceId, path: string, kind: E4FileKind): void;
  onCancelExplorerEdit?(): void;
}): JSX.Element {
  return (
    <div
      data-action="file-tree-delete-confirmation"
      className="mt-0.5 flex min-h-7 min-w-0 items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
      style={{ marginLeft: `${depth * 12 + 30}px` }}
    >
      <span className="min-w-0 flex-1 truncate">Delete {node.path}?</span>
      <Button
        type="button"
        data-action="file-tree-confirm-delete"
        variant="destructive"
        size="xs"
        onClick={() => {
          onDeleteNode(workspaceId, node.path, node.kind);
        }}
      >
        Delete
      </Button>
      <Button
        type="button"
        data-action="file-tree-cancel-delete"
        variant="ghost"
        size="xs"
        onClick={() => {
          onCancelExplorerEdit?.();
        }}
      >
        Cancel
      </Button>
    </div>
  );
}

function GitBadge({ path, status }: { path: string; status: E4GitBadgeStatus | null }): JSX.Element | null {
  if (!status || status === "clean") {
    return null;
  }

  return (
    <span
      data-git-badge-status={status}
      aria-label={`${path} git status: ${gitBadgeLabel(status)}`}
      className="shrink-0 rounded border border-sidebar-border px-1 py-0.5 font-mono text-[10px] uppercase leading-none text-muted-foreground"
    >
      {gitBadgeText(status)}
    </span>
  );
}

function PanelMessage({ children }: { children: string }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function handleTreeKeyDown(
  event: KeyboardEvent<HTMLOListElement>,
  workspaceId: WorkspaceId,
  props: FileTreePanelProps,
): void {
  if (isTextEditingTarget(event.target)) {
    return;
  }

  const selectedPath = props.selectedTreePath ?? null;
  const selectedNode = selectedPath ? findFileTreeNodeByPath(props.fileTree.nodes, selectedPath) : null;
  const movement = keyboardMovementForKey(event.key);
  if (movement) {
    event.preventDefault();
    props.onMoveTreeSelection?.(movement);
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    if (!selectedNode) {
      if (event.key === " ") {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    if (selectedNode.kind === "directory") {
      props.onToggleDirectory(selectedNode.path);
    } else {
      props.onOpenFile(workspaceId, selectedNode.path);
    }
    return;
  }

  if (event.key === "F2") {
    event.preventDefault();
    if (!selectedNode) {
      return;
    }
    props.onBeginRename?.(selectedNode.path, selectedNode.kind);
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    if (!selectedNode) {
      return;
    }
    props.onBeginDelete?.(selectedNode.path, selectedNode.kind);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    props.onCancelExplorerEdit?.();
  }
}

function keyboardMovementForKey(key: string): EditorTreeSelectionMovement | null {
  switch (key) {
    case "ArrowUp":
      return "previous";
    case "ArrowDown":
      return "next";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "ArrowLeft":
      return "parent";
    case "ArrowRight":
      return "child";
    default:
      return null;
  }
}

function handleCreateSubmit(
  event: FormEvent<HTMLFormElement>,
  workspaceId: WorkspaceId,
  edit: Extract<EditorPendingExplorerEdit, { type: "create" }>,
  onCreateNode: FileTreePanelProps["onCreateNode"],
): void {
  event.preventDefault();
  const basename = readBasenameInput(event.currentTarget);
  if (!basename) {
    return;
  }

  onCreateNode(workspaceId, joinPath(edit.parentPath, basename), edit.kind);
}

function handleRenameSubmit(
  event: FormEvent<HTMLFormElement>,
  workspaceId: WorkspaceId,
  oldPath: string,
  parentPath: string | null,
  onRenameNode: FileTreePanelProps["onRenameNode"],
  onCancelExplorerEdit?: FileTreePanelProps["onCancelExplorerEdit"],
): void {
  event.preventDefault();
  const basename = readBasenameInput(event.currentTarget);
  if (!basename) {
    return;
  }

  const nextPath = joinPath(parentPath, basename);
  if (nextPath === oldPath) {
    onCancelExplorerEdit?.();
    return;
  }

  onRenameNode(workspaceId, oldPath, nextPath);
}

function handleEditFormKeyDown(
  event: KeyboardEvent<HTMLFormElement>,
  onCancelExplorerEdit?: FileTreePanelProps["onCancelExplorerEdit"],
): void {
  if (event.key !== "Escape") {
    return;
  }

  event.preventDefault();
  onCancelExplorerEdit?.();
}

function readBasenameInput(form: HTMLFormElement): string {
  const basenameInput = form.elements.namedItem("basename");
  if (!hasValue(basenameInput)) {
    return "";
  }

  const basename = String(basenameInput.value).trim();
  if (!basename || basename.includes("/")) {
    return "";
  }

  return basename;
}

function hasValue(value: unknown): value is { value: unknown } {
  return typeof value === "object" && value !== null && "value" in value;
}

function pendingCreateForParent(
  edit: EditorPendingExplorerEdit | null | undefined,
  workspaceId: WorkspaceId,
  parentPath: string | null,
): Extract<EditorPendingExplorerEdit, { type: "create" }> | null {
  if (
    edit?.type === "create" &&
    edit.workspaceId === workspaceId &&
    (edit.parentPath ?? null) === parentPath
  ) {
    return edit;
  }

  return null;
}

function pendingRenameForPath(
  edit: EditorPendingExplorerEdit | null | undefined,
  workspaceId: WorkspaceId,
  path: string,
): boolean {
  return edit?.type === "rename" && edit.workspaceId === workspaceId && edit.path === path;
}

function pendingDeleteForPath(
  pendingDelete: EditorPendingExplorerDelete | null | undefined,
  workspaceId: WorkspaceId,
  path: string,
): boolean {
  return pendingDelete?.workspaceId === workspaceId && pendingDelete.path === path;
}

function findFileTreeNodeByPath(nodes: readonly E4FileTreeNode[], path: string): E4FileTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }

    if (node.children) {
      const descendant = findFileTreeNodeByPath(node.children, path);
      if (descendant) {
        return descendant;
      }
    }
  }

  return null;
}

function basenameForPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

function joinPath(parentPath: string | null | undefined, basename: string): string {
  return parentPath ? `${parentPath}/${basename}` : basename;
}

function treeItemId(workspaceId: WorkspaceId, path: string): string {
  return `file-tree-${String(workspaceId).replace(/[^a-zA-Z0-9_-]/g, "_")}-${path.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  const maybeElement = target as { isContentEditable?: boolean; tagName?: string } | null;
  const tagName = maybeElement?.tagName?.toUpperCase();
  return maybeElement?.isContentEditable === true || tagName === "INPUT" || tagName === "TEXTAREA";
}

export function gitBadgeText(status: E4GitBadgeStatus): string {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "staged":
      return "S";
    case "ignored":
      return "I";
    case "conflicted":
      return "!";
    case "clean":
      return "";
  }
}

export function gitBadgeLabel(status: E4GitBadgeStatus): string {
  switch (status) {
    case "modified":
      return "modified";
    case "added":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "untracked":
      return "untracked";
    case "staged":
      return "staged";
    case "ignored":
      return "ignored";
    case "conflicted":
      return "conflicted";
    case "clean":
      return "clean";
  }
}
