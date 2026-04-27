import {
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
} from "lucide-react";
import type { FormEvent } from "react";

import type {
  E4FileKind,
  E4FileTreeNode,
  E4GitBadgeStatus,
} from "../../../../shared/src/contracts/e4-editor";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import type { OpenSessionWorkspace } from "../../../../shared/src/contracts/workspace-shell";
import type { EditorFileTreeState } from "../stores/editor-store";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { EmptyState } from "./EmptyState";
import { ScrollArea } from "./ui/scroll-area";

export interface FileTreePanelProps {
  activeWorkspace: OpenSessionWorkspace | null;
  fileTree: EditorFileTreeState;
  expandedPaths: Record<string, true>;
  gitBadgeByPath: Record<string, E4GitBadgeStatus>;
  onRefresh(workspaceId: WorkspaceId): void;
  onToggleDirectory(path: string): void;
  onOpenFile(workspaceId: WorkspaceId, path: string): void;
  onCreateNode(workspaceId: WorkspaceId, path: string, kind: E4FileKind): void;
  onDeleteNode(workspaceId: WorkspaceId, path: string, kind: E4FileKind): void;
  onRenameNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): void;
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
          <Button
            type="button"
            data-action="file-tree-refresh"
            aria-label="Refresh files"
            variant="ghost"
            size="icon-xs"
            disabled={!workspaceId || props.fileTree.loading}
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
          </Button>
        </div>
        <form
          data-action="file-tree-create-form"
          className="flex min-w-0 items-center gap-1"
          onSubmit={(event) => {
            if (!workspaceId) {
              event.preventDefault();
              return;
            }
            handleCreateSubmit(event, workspaceId, props.onCreateNode);
          }}
        >
          <input
            name="path"
            aria-label="New file or folder path"
            placeholder="path/to/file"
            disabled={!workspaceId}
            className="h-7 min-w-0 flex-1 rounded-md border border-sidebar-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Button
            type="submit"
            name="kind"
            value="file"
            data-action="file-tree-new-file"
            aria-label="Create file"
            variant="ghost"
            size="icon-xs"
            disabled={!workspaceId}
          >
            <FilePlus aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          </Button>
          <Button
            type="submit"
            name="kind"
            value="directory"
            data-action="file-tree-new-folder"
            aria-label="Create folder"
            variant="ghost"
            size="icon-xs"
            disabled={!workspaceId}
          >
            <FolderPlus aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          </Button>
        </form>
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

  if (props.fileTree.nodes.length === 0) {
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
      <ol className="space-y-0.5 p-2" aria-label={`${workspace.displayName} files`}>
        {props.fileTree.nodes.map((node) => (
          <FileTreeNodeRow
            key={node.path}
            node={node}
            depth={0}
            workspaceId={workspace.id}
            expandedPaths={props.expandedPaths}
            gitBadgeByPath={props.gitBadgeByPath}
            onToggleDirectory={props.onToggleDirectory}
            onOpenFile={props.onOpenFile}
            onDeleteNode={props.onDeleteNode}
            onRenameNode={props.onRenameNode}
          />
        ))}
      </ol>
    </ScrollArea>
  );
}

function FileTreeNodeRow({
  node,
  depth,
  workspaceId,
  expandedPaths,
  gitBadgeByPath,
  onToggleDirectory,
  onOpenFile,
  onDeleteNode,
  onRenameNode,
}: {
  node: E4FileTreeNode;
  depth: number;
  workspaceId: WorkspaceId;
  expandedPaths: Record<string, true>;
  gitBadgeByPath: Record<string, E4GitBadgeStatus>;
  onToggleDirectory(path: string): void;
  onOpenFile(workspaceId: WorkspaceId, path: string): void;
  onDeleteNode(workspaceId: WorkspaceId, path: string, kind: E4FileKind): void;
  onRenameNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): void;
}): JSX.Element {
  const isDirectory = node.kind === "directory";
  const expanded = Boolean(expandedPaths[node.path]);
  const Icon = isDirectory ? (expanded ? FolderOpen : Folder) : File;
  const badge = gitBadgeByPath[node.path] ?? node.gitBadge ?? null;

  return (
    <li data-file-tree-kind={node.kind} data-file-tree-path={node.path}>
      <div
        className="group flex min-h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs text-sidebar-foreground hover:bg-accent hover:text-accent-foreground"
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
            onClick={() => onToggleDirectory(node.path)}
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

        <button
          type="button"
          data-action={isDirectory ? "file-tree-toggle-row" : "file-tree-open-file"}
          data-path={node.path}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            if (isDirectory) {
              onToggleDirectory(node.path);
            } else {
              onOpenFile(workspaceId, node.path);
            }
          }}
        >
          <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </button>

        <GitBadge path={node.path} status={badge} />

        <details className="relative shrink-0">
          <summary
            data-action="file-tree-rename"
            data-path={node.path}
            aria-label={`Rename ${node.name}`}
            className="flex size-6 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 focus-visible:opacity-100 [&::-webkit-details-marker]:hidden"
          >
            <Pencil aria-hidden="true" className="size-3" strokeWidth={1.75} />
          </summary>
          <form
            data-action="file-tree-rename-form"
            className="absolute right-0 z-10 mt-1 flex w-64 gap-1 rounded-md border border-sidebar-border bg-popover p-2 shadow-lg"
            onSubmit={(event) => {
              handleRenameSubmit(event, workspaceId, node.path, onRenameNode);
            }}
          >
            <input
              name="path"
              aria-label={`Rename ${node.name} path`}
              defaultValue={node.path}
              className="h-7 min-w-0 flex-1 rounded-md border border-sidebar-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button type="submit" data-action="file-tree-rename-confirm" variant="outline" size="xs">
              Rename
            </Button>
          </form>
        </details>
        <details className="relative shrink-0">
          <summary
            data-action="file-tree-delete"
            data-path={node.path}
            aria-label={`Delete ${node.name}`}
            className="flex size-6 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 focus-visible:opacity-100 [&::-webkit-details-marker]:hidden"
          >
            <Trash2 aria-hidden="true" className="size-3" strokeWidth={1.75} />
          </summary>
          <div className="absolute right-0 z-10 mt-1 w-56 rounded-md border border-sidebar-border bg-popover p-2 text-xs text-popover-foreground shadow-lg">
            <p className="truncate">Delete {node.path}?</p>
            <div className="mt-2 flex justify-end gap-1">
              <Button
                type="button"
                data-action="file-tree-confirm-delete"
                variant="destructive"
                size="xs"
                onClick={(event) => {
                  closeClosestDetails(event.currentTarget);
                  onDeleteNode(workspaceId, node.path, node.kind);
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        </details>
      </div>

      {isDirectory && expanded && node.children && node.children.length > 0 ? (
        <ol className="space-y-0.5" aria-label={`${node.name} children`}>
          {node.children.map((child) => (
            <FileTreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              workspaceId={workspaceId}
              expandedPaths={expandedPaths}
              gitBadgeByPath={gitBadgeByPath}
              onToggleDirectory={onToggleDirectory}
              onOpenFile={onOpenFile}
              onDeleteNode={onDeleteNode}
              onRenameNode={onRenameNode}
            />
          ))}
        </ol>
      ) : null}
    </li>
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

function handleCreateSubmit(
  event: FormEvent<HTMLFormElement>,
  workspaceId: WorkspaceId,
  onCreateNode: FileTreePanelProps["onCreateNode"],
): void {
  event.preventDefault();
  const path = readPathInput(event.currentTarget);
  if (!path) {
    return;
  }

  const kind = readSubmitterKind(event.nativeEvent);
  onCreateNode(workspaceId, path, kind);
  event.currentTarget.reset();
}

function handleRenameSubmit(
  event: FormEvent<HTMLFormElement>,
  workspaceId: WorkspaceId,
  oldPath: string,
  onRenameNode: FileTreePanelProps["onRenameNode"],
): void {
  event.preventDefault();
  const nextPath = readPathInput(event.currentTarget);
  if (!nextPath || nextPath === oldPath) {
    return;
  }

  closeClosestDetails(event.currentTarget);
  onRenameNode(workspaceId, oldPath, nextPath);
}

function readPathInput(form: HTMLFormElement): string {
  const pathInput = form.elements.namedItem("path");
  if (!hasValue(pathInput)) {
    return "";
  }

  return String(pathInput.value).trim();
}

function readSubmitterKind(nativeEvent: Event): E4FileKind {
  const submitter = "submitter" in nativeEvent ? nativeEvent.submitter : null;
  if (hasValue(submitter) && submitter.value === "directory") {
    return "directory";
  }

  return "file";
}

function hasValue(value: unknown): value is { value: unknown } {
  return typeof value === "object" && value !== null && "value" in value;
}

function closeClosestDetails(target: EventTarget | null): void {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return;
  }

  target.closest("details")?.removeAttribute("open");
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
