import {
  Check,
  ChevronsDownUp,
  ChevronDown,
  ChevronRight,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  X,
  GitCompare,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Tree } from "react-arborist";
import { useStore } from "zustand";
import type {
  NodeApi as ArboristNodeApi,
  NodeRendererProps,
  RowRendererProps,
  TreeApi as ArboristTreeApi,
} from "react-arborist";

import type {
  WorkspaceFileKind,
  WorkspaceFileTreeNode,
  WorkspaceGitBadgeStatus,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace } from "../../../../shared/src/contracts/workspace/workspace-shell";
import type {
  EditorFileTreeState,
  EditorPendingExplorerDelete,
  EditorPendingExplorerEdit,
  EditorTreeSelectionMovement,
} from "../services/editor-model-service";
import type {
  FileClipboardItem,
  FileClipboardPendingCollision,
} from "../stores/file-clipboard-store";
import {
  fileTreeMultiSelectStore,
  type FileTreeCompareAnchor,
} from "../stores/file-tree-multi-select-store";
import type {
  FileExternalDragInRequest,
  FileExternalDragInResult,
  FilePasteConflictStrategy,
} from "../../common/file-actions";
import { cn } from "@/lib/utils";
import { FileIcon } from "./file-icon";
import { EmptyState } from "./EmptyState";
import { Button } from "./ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import {
  FileClipboardCollisionDialog,
  FileTreeContextMenu,
  type FileTreeContextMenuActionPayload,
} from "./file-tree-context-menu";
import {
  dataTransferHasExternalFiles,
  dropPositionFromClientY,
  isLargeExternalFile,
  readFileTreeDragDataTransfer,
  resolveDropTargetDirectory,
  resolveFileTreeMoveDestinationPath,
  validateFileTreeDrop,
  writeFileTreeDragDataTransfer,
  type FileTreeDropIndicatorState,
  type FileTreeDropInvalidReason,
  type FileTreeDropPosition,
} from "./file-tree-dnd/drag-and-drop";

export const FILE_TREE_ROW_HEIGHT = 22;
export const FILE_TREE_INDENT = 8;
const FILE_TREE_DEFAULT_HEIGHT = 360;
const FILE_TREE_OVERSCAN_COUNT = 12;

export interface FileTreePanelProps {
  activeWorkspace: OpenSessionWorkspace | null;
  workspaceTabId?: string;
  fileTree: EditorFileTreeState;
  expandedPaths: Record<string, true>;
  gitBadgeByPath: Record<string, WorkspaceGitBadgeStatus>;
  branchSubLine?: string | null;
  selectedTreePath?: string | null;
  pendingExplorerEdit?: EditorPendingExplorerEdit | null;
  pendingExplorerDelete?: EditorPendingExplorerDelete | null;
  onRefresh(workspaceId: WorkspaceId): void;
  onToggleDirectory(path: string): void;
  onOpenFile(workspaceId: WorkspaceId, path: string): void;
  onCreateNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): void;
  onDeleteNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): void;
  onRenameNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): void;
  onSelectTreePath?(path: string | null): void;
  onBeginCreateFile?(parentPath?: string | null): void;
  onBeginCreateFolder?(parentPath?: string | null): void;
  onBeginRename?(path: string, kind: WorkspaceFileKind): void;
  onBeginDelete?(path: string, kind: WorkspaceFileKind): void;
  onCancelExplorerEdit?(): void;
  onCollapseAll?(workspaceId: WorkspaceId): void;
  onMoveTreeSelection?(movement: EditorTreeSelectionMovement): void;
  onOpenFileToSide?(workspaceId: WorkspaceId, path: string): void;
  onRevealInFinder?(payload: FileTreeContextMenuActionPayload): void;
  onOpenWithSystemApp?(payload: FileTreeContextMenuActionPayload): void;
  onOpenInTerminal?(payload: FileTreeContextMenuActionPayload): void;
  onCopyPath?(payload: FileTreeContextMenuActionPayload, pathKind: "absolute" | "relative"): void;
  canPaste?: boolean;
  pendingClipboardCollision?: FileClipboardPendingCollision | null;
  onClipboardCut?(items: FileClipboardItem[]): void;
  onClipboardCopy?(items: FileClipboardItem[]): void;
  onClipboardPaste?(payload: FileTreeContextMenuActionPayload): void;
  onClipboardResolveCollision?(strategy: Exclude<FilePasteConflictStrategy, "prompt">): void;
  onClipboardCancelCollision?(): void;
  resolveExternalFilePath?(file: File): string;
  onExternalFilesDrop?(request: FileExternalDragInRequest): Promise<FileExternalDragInResult>;
  onStartFileDrag?(workspaceId: WorkspaceId, paths: string[]): void;
  onCompareFiles?(leftPath: string, rightPath: string): void;
  sourceControlAvailable?: boolean;
  onStagePath?(path: string): void;
  onDiscardPath?(path: string): void;
  onViewDiff?(path: string): void;
}

type FileTreeEntry =
  | FileTreeNodeEntry
  | FileTreeCreateEntry
  | FileTreeDeleteEntry;

interface FileTreeNodeEntry {
  entryType: "node";
  id: string;
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  node: WorkspaceFileTreeNode;
  parentPath: string | null;
  children?: FileTreeEntry[];
}

interface FileTreeCreateEntry {
  entryType: "create";
  id: string;
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  parentPath: string | null;
  edit: Extract<EditorPendingExplorerEdit, { type: "create" }>;
  children?: undefined;
}

interface FileTreeDeleteEntry {
  entryType: "delete";
  id: string;
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  parentPath: string | null;
  target: WorkspaceFileTreeNode;
  children?: undefined;
}

interface FileTreeNativeDropIndicator {
  targetPath: string | null;
  targetDirectory: string | null;
  state: FileTreeDropIndicatorState;
  position: FileTreeDropPosition;
  reason: FileTreeDropInvalidReason | "non-directory-target" | null;
}

interface PendingExternalDropCollision {
  request: FileExternalDragInRequest;
  collisions: FileExternalDragInResult["collisions"];
}

interface ExternalDragFileDescriptor {
  absolutePath: string;
  name: string;
  size: number;
}

export interface CreateFileTreeArboristDataInput {
  nodes: readonly WorkspaceFileTreeNode[];
  workspaceId: WorkspaceId;
  expandedPaths: Record<string, true>;
  pendingExplorerEdit?: EditorPendingExplorerEdit | null;
  pendingExplorerDelete?: EditorPendingExplorerDelete | null;
}

export function FileTreePanel(props: FileTreePanelProps): JSX.Element {
  const workspaceId = props.activeWorkspace?.id ?? null;

  return (
    <section
      data-component="file-tree-panel"
      role="tabpanel"
      aria-labelledby={props.workspaceTabId}
      aria-label={props.workspaceTabId ? undefined : "File tree"}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-sidebar-border bg-sidebar/80 text-sidebar-foreground"
    >
      <FileClipboardCollisionDialog
        pendingCollision={props.pendingClipboardCollision ?? null}
        onResolve={(strategy) => props.onClipboardResolveCollision?.(strategy)}
        onCancel={() => props.onClipboardCancelCollision?.()}
      />
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <FolderOpen
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={1.75}
          />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-sidebar-foreground">
              {props.activeWorkspace?.displayName ?? "No workspace selected"}
            </h2>
            <p
              className={cn(
                "mt-0.5 truncate text-xs text-muted-foreground",
                props.branchSubLine
                  ? "font-mono normal-case tracking-normal"
                  : "font-medium uppercase tracking-[0.14em]",
              )}
            >
              {props.branchSubLine ?? "Files"}
            </p>
          </div>
        </div>
        <TooltipProvider>
          <div className="flex shrink-0 items-center gap-1" aria-label="File tree actions">
            <FileTreeToolbarIconButton
              data-action="file-tree-new-file"
              label="New File"
              icon={FilePlus}
              disabled={!workspaceId || !props.onBeginCreateFile}
              onClick={() => {
                props.onBeginCreateFile?.();
              }}
            />
            <FileTreeToolbarIconButton
              data-action="file-tree-new-folder"
              label="New Folder"
              icon={FolderPlus}
              disabled={!workspaceId || !props.onBeginCreateFolder}
              onClick={() => {
                props.onBeginCreateFolder?.();
              }}
            />
            <FileTreeToolbarIconButton
              data-action="file-tree-refresh"
              label="Refresh"
              icon={RefreshCw}
              disabled={!workspaceId || props.fileTree.loading}
              iconClassName={props.fileTree.loading ? "animate-spin" : undefined}
              onClick={() => {
                if (workspaceId) {
                  props.onRefresh(workspaceId);
                }
              }}
            />
            <FileTreeToolbarIconButton
              data-action="file-tree-collapse-all"
              label="Collapse All"
              icon={ChevronsDownUp}
              disabled={!workspaceId || !props.onCollapseAll}
              onClick={() => {
                if (workspaceId) {
                  props.onCollapseAll?.(workspaceId);
                }
              }}
            />
          </div>
        </TooltipProvider>
        {props.activeWorkspace ? (
          <span className="sr-only" data-workspace-owner-path="true">
            {props.activeWorkspace.absolutePath}
          </span>
        ) : null}
      </header>

      <FileTreePanelBody {...props} />
    </section>
  );
}

interface FileTreeToolbarIconButtonProps {
  "data-action": string;
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  iconClassName?: string;
  onClick(): void;
}

function FileTreeToolbarIconButton({
  "data-action": dataAction,
  label,
  icon: Icon,
  disabled,
  iconClassName,
  onClick,
}: FileTreeToolbarIconButtonProps): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          data-action={dataAction}
          aria-label={label}
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={onClick}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-3.5", iconClassName)}
            strokeWidth={1.75}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
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
      <FileTreeEmptyContextMenu props={props} workspace={workspace}>
        <div className="min-h-0 flex-1">
        <EmptyState
          icon={Folder}
          title="No files"
          description={`Create a file or folder in ${workspace.displayName} to begin editing.`}
        />
        </div>
      </FileTreeEmptyContextMenu>
    );
  }

  return <FileTreeArboristViewport {...props} activeWorkspace={workspace} />;
}

function FileTreeEmptyContextMenu({
  props,
  workspace,
  children,
}: {
  props: FileTreePanelProps;
  workspace: OpenSessionWorkspace;
  children: ReactNode;
}): JSX.Element {
  return (
    <FileTreeContextMenu
      kind="empty"
      workspace={workspace}
      canPaste={props.canPaste === true}
      sourceControlEnabled={props.sourceControlAvailable === true}
      onBeginCreateFile={props.onBeginCreateFile}
      onBeginCreateFolder={props.onBeginCreateFolder}
      onRefresh={props.onRefresh}
      onRevealInFinder={props.onRevealInFinder}
      onOpenInTerminal={props.onOpenInTerminal}
      onPaste={props.onClipboardPaste}
      onCopyPath={props.onCopyPath}
    >
      {children}
    </FileTreeContextMenu>
  );
}

function FileTreeArboristViewport(
  props: FileTreePanelProps & { activeWorkspace: OpenSessionWorkspace },
): JSX.Element {
  const workspace = props.activeWorkspace;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<ArboristTreeApi<FileTreeEntry> | undefined>(undefined);
  const syncingOpenStateRef = useRef(false);
  const [nativeDropIndicator, setNativeDropIndicator] = useState<FileTreeNativeDropIndicator | null>(null);
  const [externalDropNotice, setExternalDropNotice] = useState<string | null>(null);
  const [pendingExternalCollision, setPendingExternalCollision] =
    useState<PendingExternalDropCollision | null>(null);
  const bounds = useElementBounds(hostRef);
  const selectedTreePath = props.selectedTreePath ?? null;
  const multiSelectedPaths = useStore(fileTreeMultiSelectStore, (state) => state.selectedPaths);
  const compareAnchor = useStore(fileTreeMultiSelectStore, (state) => state.compareAnchor);
  const expandedPathSignature = expandedPathsSignature(props.expandedPaths);
  const treeData = useMemo(
    () =>
      createFileTreeArboristData({
        nodes: props.fileTree.nodes,
        workspaceId: workspace.id,
        expandedPaths: props.expandedPaths,
        pendingExplorerEdit: props.pendingExplorerEdit ?? null,
        pendingExplorerDelete: props.pendingExplorerDelete ?? null,
      }),
    [
      props.expandedPaths,
      props.fileTree.nodes,
      props.pendingExplorerDelete,
      props.pendingExplorerEdit,
      workspace.id,
    ],
  );
  const visiblePaths = useMemo(() => visibleNodePathsForMultiSelect(treeData), [treeData]);
  const initialOpenState = useMemo(
    () => createArboristOpenState(props.expandedPaths, props.pendingExplorerEdit, workspace.id),
    [expandedPathSignature, props.expandedPaths, props.pendingExplorerEdit, workspace.id],
  );

  useEffect(() => {
    annotateArboristTreeElement(hostRef.current, workspace, selectedTreePath, props.fileTree.loading);
  }, [props.fileTree.loading, selectedTreePath, workspace]);

  useEffect(() => {
    syncArboristOpenState(
      treeRef.current,
      props.fileTree.nodes,
      createArboristOpenState(props.expandedPaths, props.pendingExplorerEdit, workspace.id),
      syncingOpenStateRef,
    );
  }, [expandedPathSignature, props.expandedPaths, props.fileTree.nodes, props.pendingExplorerEdit, workspace.id]);

  useEffect(() => {
    if (selectedTreePath) {
      const tree = treeRef.current;
      if (tree?.hasFocus && !tree.isFocused(selectedTreePath)) {
        tree.focus(selectedTreePath, { scroll: false });
      }
      void tree?.scrollTo(selectedTreePath, "smart");
    }
  }, [selectedTreePath, treeData]);

  const height = Math.max(1, Math.floor(bounds.height || FILE_TREE_DEFAULT_HEIGHT));
  const width = bounds.width > 0 ? Math.floor(bounds.width) : "100%";
  const RowRenderer = useMemo(
    () =>
      function FileTreeRowRenderer(rowProps: RowRendererProps<FileTreeEntry>): JSX.Element {
        return (
          <FileTreeArboristRow
            {...rowProps}
            workspaceId={workspace.id}
            multiSelectedPaths={multiSelectedPaths}
            compareAnchorPath={compareAnchor?.workspaceId === workspace.id ? compareAnchor.path : null}
          />
        );
      },
    [compareAnchor?.path, compareAnchor?.workspaceId, multiSelectedPaths, workspace.id],
  );
  const handleExternalDropRequest = useCallback(async (request: FileExternalDragInRequest) => {
    if (!props.onExternalFilesDrop) {
      return;
    }

    const result = await props.onExternalFilesDrop(request);
    if (result.largeFiles.length > 0) {
      const count = result.largeFiles.length;
      console.warn(`File tree: copying ${count} large external file${count === 1 ? "" : "s"}.`);
      setExternalDropNotice(`Copying ${count} large file${count === 1 ? "" : "s"}…`);
    }

    if (result.collisions.length > 0) {
      setPendingExternalCollision({
        request,
        collisions: result.collisions,
      });
      return;
    }

    setPendingExternalCollision(null);
    if (result.largeFiles.length === 0) {
      setExternalDropNotice(null);
    }
  }, [props]);
  const resolvePendingExternalCollision = useCallback((strategy: Exclude<FilePasteConflictStrategy, "prompt">) => {
    const pending = pendingExternalCollision;
    if (!pending) {
      return;
    }

    void handleExternalDropRequest({
      ...pending.request,
      conflictStrategy: strategy,
    });
  }, [handleExternalDropRequest, pendingExternalCollision]);
  const cancelPendingExternalCollision = useCallback(() => {
    setPendingExternalCollision(null);
  }, []);
  const handleNativeDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasExternalFiles(event.dataTransfer)) {
      return;
    }

    const indicator = createNativeDropIndicatorFromEvent({
      event,
      workspaceId: workspace.id,
      gitBadgeByPath: props.gitBadgeByPath,
      fileTreeNodes: props.fileTree.nodes,
    });

    if (!indicator) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = indicator.state === "invalid" ? "none" : "copy";
    setNativeDropIndicator(indicator);
  }, [props.fileTree.nodes, props.gitBadgeByPath, workspace.id]);
  const handleNativeDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasExternalFiles(event.dataTransfer)) {
      return;
    }

    const indicator = createNativeDropIndicatorFromEvent({
      event,
      workspaceId: workspace.id,
      gitBadgeByPath: props.gitBadgeByPath,
      fileTreeNodes: props.fileTree.nodes,
    });

    if (!indicator) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setNativeDropIndicator(null);

    if (indicator.state === "invalid") {
      return;
    }

    const files = externalDragFilesFromDataTransfer(event.dataTransfer, props.resolveExternalFilePath);
    if (files.length === 0 || !props.onExternalFilesDrop) {
      return;
    }

    if (files.some((file) => isLargeExternalFile(file.size))) {
      setExternalDropNotice("Copying large file…");
    }

    void handleExternalDropRequest({
      type: "file-actions/external-drag-in",
      workspaceId: workspace.id,
      targetDirectory: indicator.targetDirectory,
      files,
      conflictStrategy: "prompt",
    });
  }, [
    handleExternalDropRequest,
    props.fileTree.nodes,
    props.gitBadgeByPath,
    props.onExternalFilesDrop,
    props.resolveExternalFilePath,
    workspace.id,
  ]);
  const NodeRenderer = useMemo(
    () =>
      function FileTreeNodeRenderer(nodeProps: NodeRendererProps<FileTreeEntry>): JSX.Element {
        return (
          <FileTreeEntryContent
            {...nodeProps}
            activeWorkspace={workspace}
            panelProps={props}
            workspaceId={workspace.id}
            gitBadgeByPath={props.gitBadgeByPath}
            nativeDropIndicator={nativeDropIndicator}
            pendingExplorerEdit={props.pendingExplorerEdit ?? null}
            pendingExplorerDelete={props.pendingExplorerDelete ?? null}
            onToggleDirectory={props.onToggleDirectory}
            onOpenFile={props.onOpenFile}
            onDeleteNode={props.onDeleteNode}
            onRenameNode={props.onRenameNode}
            onBeginRename={props.onBeginRename}
            onBeginDelete={props.onBeginDelete}
            onCancelExplorerEdit={props.onCancelExplorerEdit}
            onCreateNode={props.onCreateNode}
            multiSelectedPaths={multiSelectedPaths}
            compareAnchor={compareAnchor?.workspaceId === workspace.id ? compareAnchor : null}
            visiblePaths={visiblePaths}
          />
        );
      },
    [
      props.gitBadgeByPath,
      nativeDropIndicator,
      props.onBeginDelete,
      props.onBeginRename,
      props.onCancelExplorerEdit,
      props.onCreateNode,
      props.onDeleteNode,
      props.onOpenFile,
      props.onRenameNode,
      props.onToggleDirectory,
      props.pendingExplorerDelete,
      props.pendingExplorerEdit,
      visiblePaths,
      multiSelectedPaths,
      compareAnchor,
      workspace.id,
    ],
  );

  return (
    <>
      <FileClipboardCollisionDialog
        pendingCollision={pendingExternalCollision}
        onResolve={resolvePendingExternalCollision}
        onCancel={cancelPendingExternalCollision}
      />
      <FileTreeEmptyContextMenu props={props} workspace={workspace}>
      <div
      ref={hostRef}
      className="min-h-0 flex-1 p-2"
      data-action="file-tree-host"
      data-file-tree-external-drop-notice={externalDropNotice ?? undefined}
      onFocusCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) {
          return;
        }
        const tree = treeRef.current;
        if (selectedTreePath && tree && !tree.isFocused(selectedTreePath)) {
          tree.focus(selectedTreePath, { scroll: false });
        }
      }}
      onKeyDownCapture={(event) => {
        handleTreeKeyDown(event, workspace.id, props, visiblePaths);
      }}
      onDragOverCapture={handleNativeDragOver}
      onDragLeaveCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setNativeDropIndicator(null);
      }}
      onDropCapture={handleNativeDrop}
    >
      {externalDropNotice ? (
        <div
          data-file-tree-external-drop-indicator="large-file"
          className="mb-2 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-xs text-primary"
        >
          {externalDropNotice}
        </div>
      ) : null}
      <Tree<FileTreeEntry>
        ref={treeRef}
        data={treeData}
        idAccessor="id"
        childrenAccessor={(entry) => entry.children ?? null}
        rowHeight={FILE_TREE_ROW_HEIGHT}
        indent={FILE_TREE_INDENT}
        height={height}
        width={width}
        overscanCount={FILE_TREE_OVERSCAN_COUNT}
        initialOpenState={initialOpenState}
        openByDefault={false}
        selection={selectedTreePath ?? undefined}
        selectionFollowsFocus
        disableMultiSelection
        disableDrag={(entry) => entry.entryType !== "node"}
        disableDrop={({ parentNode, dragNodes }) =>
          isFileTreeDropDisabled({
            workspaceId: workspace.id,
            parentNode,
            dragNodes,
            gitBadgeByPath: props.gitBadgeByPath,
          })
        }
        disableEdit
        renderCursor={FileTreeDropCursor}
        className="outline-none"
        rowClassName="outline-none"
        renderRow={RowRenderer}
        onMove={({ dragIds, dragNodes, parentId }) => {
          handleArboristMove({
            workspaceId: workspace.id,
            dragIds,
            dragNodes,
            parentId,
            gitBadgeByPath: props.gitBadgeByPath,
            onRenameNode: props.onRenameNode,
          });
        }}
        onToggle={(id) => {
          if (syncingOpenStateRef.current || isSyntheticFileTreeEntryId(id)) {
            return;
          }
          props.onToggleDirectory(id);
        }}
        onSelect={(nodes) => {
          const selectedNode = nodes.find((node) => node.data.entryType === "node");
          if (selectedNode) {
            props.onSelectTreePath?.(selectedNode.id);
          } else if (nodes.length === 0) {
            props.onSelectTreePath?.(null);
          }
        }}
        onActivate={(node) => {
          if (node.data.entryType !== "node") {
            return;
          }
          if (node.data.kind === "directory") {
            props.onToggleDirectory(node.data.path);
          } else {
            props.onOpenFile(workspace.id, node.data.path);
          }
        }}
      >
        {NodeRenderer}
      </Tree>
      </div>
      </FileTreeEmptyContextMenu>
    </>
  );
}

function FileTreeArboristRow({
  node,
  attrs,
  innerRef,
  children,
  workspaceId,
  multiSelectedPaths,
  compareAnchorPath,
}: RowRendererProps<FileTreeEntry> & {
  workspaceId: WorkspaceId;
  multiSelectedPaths: ReadonlySet<string>;
  compareAnchorPath: string | null;
}): JSX.Element {
  const entry = node.data;
  const isActualNode = entry.entryType === "node";
  const isDirectory = isActualNode && entry.kind === "directory";
  const multiSelected = isActualNode && multiSelectedPaths.has(entry.path);
  const compareAnchored = isActualNode && compareAnchorPath === entry.path;
  const rowId = isActualNode ? treeItemId(workspaceId, entry.path) : treeItemId(workspaceId, entry.id);

  return (
    <div
      {...attrs}
      ref={innerRef}
      id={rowId}
      role="treeitem"
      aria-selected={isActualNode ? node.isSelected || multiSelected : false}
      aria-expanded={isDirectory ? node.isOpen : undefined}
      data-action={entry.entryType === "create" ? "file-tree-create-row" : undefined}
      data-file-tree-row="true"
      data-file-tree-kind={entry.kind}
      data-file-tree-path={isActualNode ? entry.path : undefined}
      data-parent-path={entry.parentPath ?? ""}
      data-selected={isActualNode && node.isSelected ? "true" : "false"}
      data-multi-selected={multiSelected ? "true" : "false"}
      data-compare-anchor={compareAnchored ? "true" : "false"}
      data-active={isActualNode && node.isSelected ? "true" : "false"}
      className={cn("outline-none", attrs.className)}
      onFocus={(event) => {
        attrs.onFocus?.(event);
        event.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}

function FileTreeEntryContent({
  node,
  dragHandle,
  style,
  activeWorkspace,
  panelProps,
  workspaceId,
  gitBadgeByPath,
  nativeDropIndicator,
  pendingExplorerEdit,
  pendingExplorerDelete,
  onToggleDirectory,
  onOpenFile,
  onDeleteNode,
  onRenameNode,
  onBeginRename,
  onBeginDelete,
  onCancelExplorerEdit,
  onCreateNode,
  multiSelectedPaths,
  compareAnchor,
  visiblePaths,
}: NodeRendererProps<FileTreeEntry> & {
  activeWorkspace: OpenSessionWorkspace;
  panelProps: FileTreePanelProps;
  workspaceId: WorkspaceId;
  gitBadgeByPath: Record<string, WorkspaceGitBadgeStatus>;
  nativeDropIndicator: FileTreeNativeDropIndicator | null;
  pendingExplorerEdit: EditorPendingExplorerEdit | null;
  pendingExplorerDelete: EditorPendingExplorerDelete | null;
  onToggleDirectory(path: string): void;
  onOpenFile(workspaceId: WorkspaceId, path: string): void;
  onDeleteNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): void;
  onRenameNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): void;
  onBeginRename?(path: string, kind: WorkspaceFileKind): void;
  onBeginDelete?(path: string, kind: WorkspaceFileKind): void;
  onCancelExplorerEdit?(): void;
  onCreateNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): void;
  multiSelectedPaths: ReadonlySet<string>;
  compareAnchor: FileTreeCompareAnchor | null;
  visiblePaths: readonly string[];
}): JSX.Element {
  const entry = node.data;
  if (entry.entryType === "create") {
    return (
      <FileTreeCreateRow
        edit={entry.edit}
        depth={node.level}
        style={style}
        workspaceId={workspaceId}
        onCreateNode={onCreateNode}
        onCancelExplorerEdit={onCancelExplorerEdit}
      />
    );
  }

  if (entry.entryType === "delete") {
    return (
      <FileTreeDeleteConfirmation
        node={entry.target}
        depth={node.level}
        style={style}
        workspaceId={workspaceId}
        onDeleteNode={onDeleteNode}
        onCancelExplorerEdit={onCancelExplorerEdit}
      />
    );
  }

  return (
    <FileTreeNodeRow
      entry={entry}
      arboristNode={node}
      dragHandle={dragHandle}
      style={style}
      activeWorkspace={activeWorkspace}
      panelProps={panelProps}
      workspaceId={workspaceId}
      pendingExplorerEdit={pendingExplorerEdit}
      pendingExplorerDelete={pendingExplorerDelete}
      gitBadgeByPath={gitBadgeByPath}
      nativeDropIndicator={nativeDropIndicator}
      multiSelectedPaths={multiSelectedPaths}
      compareAnchor={compareAnchor}
      visiblePaths={visiblePaths}
      onToggleDirectory={onToggleDirectory}
      onOpenFile={onOpenFile}
      onRenameNode={onRenameNode}
      onBeginRename={onBeginRename}
      onBeginDelete={onBeginDelete}
      onCancelExplorerEdit={onCancelExplorerEdit}
    />
  );
}

function FileTreeNodeRow({
  entry,
  arboristNode,
  dragHandle,
  style,
  activeWorkspace,
  panelProps,
  workspaceId,
  pendingExplorerEdit,
  pendingExplorerDelete,
  gitBadgeByPath,
  nativeDropIndicator,
  multiSelectedPaths,
  compareAnchor,
  visiblePaths,
  onToggleDirectory,
  onOpenFile,
  onRenameNode,
  onBeginRename,
  onBeginDelete,
  onCancelExplorerEdit,
}: {
  entry: FileTreeNodeEntry;
  arboristNode: ArboristNodeApi<FileTreeEntry>;
  dragHandle?: (el: HTMLDivElement | null) => void;
  style: CSSProperties;
  activeWorkspace: OpenSessionWorkspace;
  panelProps: FileTreePanelProps;
  workspaceId: WorkspaceId;
  pendingExplorerEdit: EditorPendingExplorerEdit | null;
  pendingExplorerDelete: EditorPendingExplorerDelete | null;
  gitBadgeByPath: Record<string, WorkspaceGitBadgeStatus>;
  nativeDropIndicator: FileTreeNativeDropIndicator | null;
  multiSelectedPaths: ReadonlySet<string>;
  compareAnchor: FileTreeCompareAnchor | null;
  visiblePaths: readonly string[];
  onToggleDirectory(path: string): void;
  onOpenFile(workspaceId: WorkspaceId, path: string): void;
  onRenameNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): void;
  onBeginRename?(path: string, kind: WorkspaceFileKind): void;
  onBeginDelete?(path: string, kind: WorkspaceFileKind): void;
  onCancelExplorerEdit?(): void;
}): JSX.Element {
  const node = entry.node;
  const isDirectory = node.kind === "directory";
  const isSelected = arboristNode.isSelected;
  const isMultiSelected = multiSelectedPaths.has(node.path);
  const isCompareAnchor = compareAnchor?.path === node.path;
  const isRenaming = pendingRenameForPath(pendingExplorerEdit, workspaceId, node.path);
  const isDeleting = pendingDeleteForPath(pendingExplorerDelete, workspaceId, node.path);
  const badge = gitBadgeByPath[node.path] ?? node.gitBadge ?? null;
  const nativeIndicatorForRow =
    nativeDropIndicator?.targetPath === node.path ? nativeDropIndicator : null;

  const rowContent = (
    <div
      ref={dragHandle}
      className={cn(
        "group relative flex h-[22px] min-w-0 items-center gap-1 rounded-sm px-1 text-xs leading-none text-sidebar-foreground hover:bg-accent/40",
        isSelected && arboristNode.isFocused && "bg-accent text-accent-foreground",
        isSelected && !arboristNode.isFocused && "bg-muted/40 text-sidebar-foreground",
        isMultiSelected && "bg-accent text-accent-foreground ring-1 ring-primary/30",
        isCompareAnchor && !isMultiSelected && "ring-1 ring-primary/20",
        isDeleting && "bg-destructive/10 text-destructive ring-1 ring-destructive/25",
        (arboristNode.willReceiveDrop || nativeIndicatorForRow?.state === "over") &&
          "bg-accent/20 ring-1 ring-primary/30",
        nativeIndicatorForRow?.state === "invalid" && "cursor-not-allowed bg-destructive/10",
      )}
      style={style}
      data-file-tree-drop-indicator={nativeIndicatorForRow?.state}
      data-file-tree-drop-position={nativeIndicatorForRow?.position}
      data-file-tree-drop-invalid-reason={nativeIndicatorForRow?.reason ?? undefined}
      draggable={!isRenaming && !isDeleting}
      onDragStart={(event) => {
        if (isRenaming || isDeleting) {
          event.preventDefault();
          return;
        }
        writeFileTreeDragDataTransfer(event.dataTransfer, {
          workspaceId,
          path: node.path,
          kind: node.kind,
        });
        panelProps.onStartFileDrag?.(workspaceId, fileTreeDragPathsForNode(workspaceId, node.path, node.kind, multiSelectedPaths, panelProps.fileTree.nodes));
      }}
      onContextMenu={(event) => {
        event.stopPropagation();
      }}
    >
      {nativeIndicatorForRow?.state === "insert" ? (
        <FileTreeNativeInsertIndicator position={nativeIndicatorForRow.position} />
      ) : null}
      <IndentGuides depth={arboristNode.level} />
      {isDirectory ? (
        <button
          type="button"
          data-action="file-tree-toggle"
          data-path={node.path}
          aria-expanded={arboristNode.isOpen}
          aria-label={`${arboristNode.isOpen ? "Collapse" : "Expand"} ${node.name}`}
          className="z-10 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            stopReactEvent(event);
            arboristNode.select();
            arboristNode.toggle();
          }}
        >
          {arboristNode.isOpen ? (
            <ChevronDown aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          ) : (
            <ChevronRight aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          )}
        </button>
      ) : (
        <span className="size-4 shrink-0" aria-hidden="true" />
      )}

      <FileIcon
        name={node.name}
        kind={isDirectory ? "folder" : "file"}
        folderState={isDirectory ? (arboristNode.isOpen ? "open" : "closed") : undefined}
        className="z-10"
      />
      {isCompareAnchor ? (
        <GitCompare
          data-file-tree-compare-anchor-marker="true"
          aria-label={`${node.name} is selected for compare`}
          className="z-10 size-3 shrink-0 text-primary"
          strokeWidth={1.75}
        />
      ) : null}

      {isRenaming ? (
        <FileTreeRenameForm
          node={node}
          workspaceId={workspaceId}
          parentPath={entry.parentPath}
          onRenameNode={onRenameNode}
          onCancelExplorerEdit={onCancelExplorerEdit}
        />
      ) : (
        <button
          type="button"
          data-action={isDirectory ? "file-tree-toggle-row" : "file-tree-open-file"}
          data-path={node.path}
          aria-current={isSelected ? "true" : undefined}
          className="z-10 h-[18px] min-w-0 flex-1 truncate rounded-sm px-1 text-left leading-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            stopReactEvent(event);
            if (handleMultiSelectClick(event, node.path, visiblePaths, panelProps)) {
              arboristNode.select();
              return;
            }
            fileTreeMultiSelectStore.getState().clearSelect();
            arboristNode.select();
            if (isDirectory) {
              arboristNode.toggle();
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
        <div className="z-10 flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            type="button"
            data-action="file-tree-rename"
            data-path={node.path}
            aria-label={`Rename ${node.name}`}
            variant="ghost"
            size="icon-xs"
            className="size-5 text-muted-foreground hover:text-foreground"
            disabled={!onBeginRename}
            onClick={(event) => {
              stopReactEvent(event);
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
            className="size-5 text-muted-foreground hover:text-destructive"
            disabled={!onBeginDelete}
            onClick={(event) => {
              stopReactEvent(event);
              onBeginDelete?.(node.path, node.kind);
            }}
          >
            <Trash2 aria-hidden="true" className="size-3" strokeWidth={1.75} />
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <FileTreeContextMenu
      kind={isDirectory ? "folder" : "file"}
      workspace={activeWorkspace}
      target={{
        path: node.path,
        name: node.name,
        kind: node.kind,
        parentPath: entry.parentPath,
      }}
      sourceControlStatus={badge}
      sourceControlEnabled={panelProps.sourceControlAvailable === true}
      selectedItems={selectedItemsForContextMenu(workspaceId, node.path, multiSelectedPaths, panelProps.fileTree.nodes)}
      compareAnchor={compareAnchor}
      canPaste={panelProps.canPaste === true}
      onOpen={(payload) => {
        if (payload.kind === "file" && payload.path) {
          onOpenFile(workspaceId, payload.path);
        }
      }}
      onOpenToSide={(payload) => {
        if (payload.kind === "file" && payload.path) {
          panelProps.onOpenFileToSide?.(workspaceId, payload.path);
        }
      }}
      onOpenWithSystemApp={panelProps.onOpenWithSystemApp}
      onRevealInFinder={panelProps.onRevealInFinder}
      onOpenInTerminal={panelProps.onOpenInTerminal}
      onBeginCreateFile={panelProps.onBeginCreateFile}
      onBeginCreateFolder={panelProps.onBeginCreateFolder}
      onCut={panelProps.onClipboardCut}
      onCopy={panelProps.onClipboardCopy}
      onPaste={panelProps.onClipboardPaste}
      onCopyPath={panelProps.onCopyPath}
      onRename={(path, kind) => onBeginRename?.(path, kind)}
      onDelete={(path, kind) => onBeginDelete?.(path, kind)}
      onDeleteItems={(items) => {
        if (items.length <= 1) {
          const item = items[0];
          if (item) {
            onBeginDelete?.(item.path, item.kind);
          }
          return;
        }
        if (confirmMultiDelete(items)) {
          for (const item of items) {
            panelProps.onDeleteNode(item.workspaceId, item.path, item.kind);
          }
        }
      }}
      onCompare={(target, anchor) => {
        if (anchor && anchor.path !== target.path) {
          panelProps.onCompareFiles?.(anchor.path, target.path);
          fileTreeMultiSelectStore.getState().clearCompareAnchor();
          return;
        }
        fileTreeMultiSelectStore.getState().setCompareAnchor({
          workspaceId,
          path: target.path,
          name: target.name,
          kind: target.kind,
        });
      }}
      onStage={panelProps.onStagePath}
      onDiscard={panelProps.onDiscardPath}
      onViewDiff={panelProps.onViewDiff}
    >
      {rowContent}
    </FileTreeContextMenu>
  );
}

function FileTreeCreateRow({
  edit,
  depth,
  style,
  workspaceId,
  onCreateNode,
  onCancelExplorerEdit,
}: {
  edit: Extract<EditorPendingExplorerEdit, { type: "create" }>;
  depth: number;
  style: CSSProperties;
  workspaceId: WorkspaceId;
  onCreateNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): void;
  onCancelExplorerEdit?(): void;
}): JSX.Element {
  const label = edit.kind === "directory" ? "New folder name" : "New file name";

  return (
    <form
      data-action="file-tree-create-form"
      className="relative flex h-[22px] min-w-0 items-center gap-1 rounded-sm bg-accent/40 px-1 text-xs text-accent-foreground ring-1 ring-ring/25"
      style={style}
      onSubmit={(event) => {
        handleCreateSubmit(event, workspaceId, edit, onCreateNode);
      }}
      onKeyDown={(event) => {
        handleEditFormKeyDown(event, onCancelExplorerEdit);
      }}
    >
      <IndentGuides depth={depth} />
      <span className="size-4 shrink-0" aria-hidden="true" />
      <FileIcon
        name={edit.kind === "directory" ? "folder" : "file"}
        kind={edit.kind === "directory" ? "folder" : "file"}
        folderState={edit.kind === "directory" ? "closed" : undefined}
        className="z-10"
      />
      <input
        name="basename"
        aria-label={label}
        autoFocus
        className="z-10 h-5 min-w-0 flex-1 rounded-sm border border-sidebar-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        placeholder={edit.kind === "directory" ? "folder-name" : "file-name"}
      />
      <Button
        type="submit"
        data-action="file-tree-create-confirm"
        variant="outline"
        size="icon-xs"
        aria-label="Create"
        className="z-10 size-5"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <Check aria-hidden="true" className="size-3" strokeWidth={1.75} />
      </Button>
      <Button
        type="button"
        data-action="file-tree-cancel-edit"
        variant="ghost"
        size="icon-xs"
        aria-label="Cancel create"
        className="z-10 size-5"
        onClick={(event) => {
          stopReactEvent(event);
          onCancelExplorerEdit?.();
        }}
      >
        <X aria-hidden="true" className="size-3" strokeWidth={1.75} />
      </Button>
    </form>
  );
}

function FileTreeRenameForm({
  node,
  workspaceId,
  parentPath,
  onRenameNode,
  onCancelExplorerEdit,
}: {
  node: WorkspaceFileTreeNode;
  workspaceId: WorkspaceId;
  parentPath: string | null;
  onRenameNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): void;
  onCancelExplorerEdit?(): void;
}): JSX.Element {
  return (
    <form
      data-action="file-tree-rename-form"
      data-path={node.path}
      className="z-10 flex h-5 min-w-0 flex-1 items-center gap-1"
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
        className="h-5 min-w-0 flex-1 rounded-sm border border-sidebar-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button
        type="submit"
        data-action="file-tree-rename-confirm"
        variant="outline"
        size="icon-xs"
        aria-label="Rename"
        className="size-5"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <Check aria-hidden="true" className="size-3" strokeWidth={1.75} />
      </Button>
      <Button
        type="button"
        data-action="file-tree-cancel-edit"
        variant="ghost"
        size="icon-xs"
        aria-label="Cancel rename"
        className="size-5"
        onClick={(event) => {
          stopReactEvent(event);
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
  style,
  workspaceId,
  onDeleteNode,
  onCancelExplorerEdit,
}: {
  node: WorkspaceFileTreeNode;
  depth: number;
  style: CSSProperties;
  workspaceId: WorkspaceId;
  onDeleteNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): void;
  onCancelExplorerEdit?(): void;
}): JSX.Element {
  return (
    <div
      data-action="file-tree-delete-confirmation"
      className="relative flex h-[22px] min-w-0 items-center gap-2 rounded-sm border border-destructive/30 bg-destructive/10 px-1 text-xs text-destructive"
      style={style}
    >
      <IndentGuides depth={depth} />
      <span className="z-10 min-w-0 flex-1 truncate">Delete {node.path}?</span>
      <Button
        type="button"
        data-action="file-tree-confirm-delete"
        variant="destructive"
        size="xs"
        className="z-10 h-5 px-1.5"
        onClick={(event) => {
          stopReactEvent(event);
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
        className="z-10 h-5 px-1.5"
        onClick={(event) => {
          stopReactEvent(event);
          onCancelExplorerEdit?.();
        }}
      >
        Cancel
      </Button>
    </div>
  );
}

function IndentGuides({ depth }: { depth: number }): JSX.Element | null {
  if (depth <= 0) {
    return null;
  }

  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-0 block">
      {Array.from({ length: depth }, (_, index) => (
        <span
          key={index}
          data-file-tree-indent-guide="true"
          className="absolute top-0 block h-full w-px bg-sidebar-border/70"
          style={{ left: index * FILE_TREE_INDENT + FILE_TREE_INDENT / 2 }}
        />
      ))}
    </span>
  );
}

function GitBadge({ path, status }: { path: string; status: WorkspaceGitBadgeStatus | null }): JSX.Element | null {
  if (!status || status === "clean") {
    return null;
  }

  return (
    <span
      data-git-badge-status={status}
      aria-label={`${path} git status: ${gitBadgeLabel(status)}`}
      className="z-10 shrink-0 rounded border border-sidebar-border px-1 py-0 font-mono text-[10px] uppercase leading-3 text-muted-foreground"
    >
      {gitBadgeText(status)}
    </span>
  );
}

function FileTreeNativeInsertIndicator({
  position,
}: {
  position: FileTreeDropPosition;
}): JSX.Element {
  const isAbove = position === "insert-above";
  return (
    <span
      aria-hidden="true"
      data-file-tree-native-insert-indicator="true"
      className={cn(
        "pointer-events-none absolute left-0 right-0 z-20 h-px bg-primary",
        isAbove ? "top-0" : "bottom-0",
      )}
    />
  );
}

function FileTreeDropCursor({ top, left }: { top: number; left: number; indent: number }): JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-file-tree-drop-cursor="insert"
      className="absolute right-2 z-30 h-px rounded-full bg-primary"
      style={{ top, left }}
    />
  );
}

function PanelMessage({ children }: { children: string }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function isFileTreeDropDisabled({
  workspaceId,
  parentNode,
  dragNodes,
  gitBadgeByPath,
}: {
  workspaceId: WorkspaceId;
  parentNode: ArboristNodeApi<FileTreeEntry>;
  dragNodes: ArboristNodeApi<FileTreeEntry>[];
  gitBadgeByPath: Record<string, WorkspaceGitBadgeStatus>;
}): boolean {
  const draggedEntries = dragNodes
    .map((node) => node.data)
    .filter((entry): entry is FileTreeNodeEntry => entry.entryType === "node");
  const parentEntry = parentNode.data.entryType === "node" ? parentNode.data : null;
  const targetParentPath = parentEntry?.path ?? null;
  const validation = validateFileTreeDrop({
    sourceWorkspaceId: workspaceId,
    targetWorkspaceId: workspaceId,
    draggedNodes: draggedEntries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      gitStatus: gitBadgeByPath[entry.path] ?? entry.node.gitBadge ?? null,
    })),
    targetParentPath,
    targetGitStatus: targetParentPath
      ? gitBadgeByPath[targetParentPath] ?? parentEntry?.node.gitBadge ?? null
      : null,
  });
  return !validation.valid;
}

function handleArboristMove({
  workspaceId,
  dragIds,
  dragNodes,
  parentId,
  gitBadgeByPath,
  onRenameNode,
}: {
  workspaceId: WorkspaceId;
  dragIds: string[];
  dragNodes: ArboristNodeApi<FileTreeEntry>[];
  parentId: string | null;
  gitBadgeByPath: Record<string, WorkspaceGitBadgeStatus>;
  onRenameNode: FileTreePanelProps["onRenameNode"];
}): void {
  if (dragIds.length !== 1 || dragNodes.length !== 1) {
    return;
  }

  const draggedEntry = dragNodes[0]?.data;
  if (draggedEntry?.entryType !== "node") {
    return;
  }

  const validation = validateFileTreeDrop({
    sourceWorkspaceId: workspaceId,
    targetWorkspaceId: workspaceId,
    draggedNodes: [{
      path: draggedEntry.path,
      kind: draggedEntry.kind,
      gitStatus: gitBadgeByPath[draggedEntry.path] ?? draggedEntry.node.gitBadge ?? null,
    }],
    targetParentPath: parentId,
    targetGitStatus: parentId ? gitBadgeByPath[parentId] ?? null : null,
  });
  if (!validation.valid) {
    return;
  }

  const nextPath = resolveFileTreeMoveDestinationPath({
    draggedPath: draggedEntry.path,
    targetParentPath: parentId,
  });
  if (nextPath === draggedEntry.path) {
    return;
  }

  onRenameNode(workspaceId, draggedEntry.path, nextPath);
}

export function createNativeDropIndicatorFromEvent({
  event,
  workspaceId,
  gitBadgeByPath,
  fileTreeNodes,
}: {
  event: DragEvent<HTMLElement>;
  workspaceId: WorkspaceId;
  gitBadgeByPath: Record<string, WorkspaceGitBadgeStatus>;
  fileTreeNodes: readonly WorkspaceFileTreeNode[];
}): FileTreeNativeDropIndicator | null {
  const fileTreeDragData = readFileTreeDragDataTransfer(event.dataTransfer);
  const hasExternalFiles = dataTransferHasExternalFiles(event.dataTransfer);
  if (!fileTreeDragData && !hasExternalFiles) {
    return null;
  }

  const target = nativeDropTargetFromEvent(event, gitBadgeByPath, fileTreeNodes);
  const position = target
    ? dropPositionFromClientY({
        clientY: event.clientY,
        rowTop: target.rowTop,
        rowHeight: target.rowHeight,
      })
    : "over";
  const dropTarget = target?.node
    ? {
        path: target.node.path,
        kind: target.node.kind,
        parentPath: target.parentPath,
        gitStatus: target.gitStatus,
      }
    : null;
  const resolution = resolveDropTargetDirectory(dropTarget, position);
  let state = resolution.indicatorState;
  let reason: FileTreeNativeDropIndicator["reason"] =
    state === "invalid" ? "non-directory-target" : null;
  const targetGitStatus = target?.gitStatus ??
    (resolution.targetDirectory ? gitBadgeByPath[resolution.targetDirectory] ?? null : null);

  if (targetGitStatus === "ignored") {
    state = "invalid";
    reason = "git-ignored";
  }

  if (fileTreeDragData && state !== "invalid") {
    const validation = validateFileTreeDrop({
      sourceWorkspaceId: fileTreeDragData.workspaceId,
      targetWorkspaceId: workspaceId,
      draggedNodes: [{
        path: fileTreeDragData.path,
        kind: fileTreeDragData.kind,
        gitStatus: gitBadgeByPath[fileTreeDragData.path] ?? null,
      }],
      targetParentPath: resolution.targetDirectory,
      targetGitStatus,
    });
    if (!validation.valid) {
      state = "invalid";
      reason = validation.reason;
    }
  }

  return {
    targetPath: target?.node?.path ?? null,
    targetDirectory: resolution.targetDirectory,
    state,
    position,
    reason,
  };
}

export function externalDragFilesFromDataTransfer(
  dataTransfer: Pick<DataTransfer, "files">,
  resolveExternalFilePath?: (file: File) => string,
): ExternalDragFileDescriptor[] {
  return Array.from(dataTransfer.files)
    .map((file) => {
      const absolutePath = resolveExternalFilePath?.(file) ?? pathForDraggedFile(file);
      if (!absolutePath) {
        return null;
      }
      return {
        absolutePath,
        name: file.name,
        size: file.size,
      };
    })
    .filter((file): file is ExternalDragFileDescriptor => file !== null);
}

function nativeDropTargetFromEvent(
  event: DragEvent<HTMLElement>,
  gitBadgeByPath: Record<string, WorkspaceGitBadgeStatus>,
  fileTreeNodes: readonly WorkspaceFileTreeNode[],
): {
  node: WorkspaceFileTreeNode | null;
  parentPath: string | null;
  gitStatus: WorkspaceGitBadgeStatus | null;
  rowTop: number;
  rowHeight: number;
} | null {
  const targetElement = event.target as { closest?: (selector: string) => HTMLElement | null } | null;
  const row = targetElement?.closest?.('[data-file-tree-row="true"]') ?? null;
  if (!row) {
    return null;
  }

  const rowPath = row.dataset.fileTreePath ?? null;
  const node = rowPath ? findFileTreeNodeByPath(fileTreeNodes, rowPath) : null;
  const parentPath = row.dataset.parentPath
    ? row.dataset.parentPath
    : node
      ? parentPathForNode(fileTreeNodes, rowPath ?? "")
      : null;
  const rect = row.getBoundingClientRect();
  return {
    node,
    parentPath,
    gitStatus: rowPath ? gitBadgeByPath[rowPath] ?? node?.gitBadge ?? null : null,
    rowTop: rect.top,
    rowHeight: rect.height,
  };
}

function parentPathForNode(nodes: readonly WorkspaceFileTreeNode[], path: string): string | null {
  const found = findFileTreeNodeParentPath(nodes, path, null);
  return found ?? null;
}

function findFileTreeNodeParentPath(
  nodes: readonly WorkspaceFileTreeNode[],
  path: string,
  parentPath: string | null,
): string | null | undefined {
  for (const node of nodes) {
    if (node.path === path) {
      return parentPath;
    }

    const found = findFileTreeNodeParentPath(node.children ?? [], path, node.path);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function pathForDraggedFile(file: File): string {
  return typeof (file as { path?: unknown }).path === "string"
    ? String((file as { path: string }).path)
    : "";
}

export function createFileTreeArboristData({
  nodes,
  workspaceId,
  expandedPaths,
  pendingExplorerEdit,
  pendingExplorerDelete,
}: CreateFileTreeArboristDataInput): FileTreeEntry[] {
  const pendingRootCreate = pendingCreateForParent(pendingExplorerEdit, workspaceId, null);
  const entries: FileTreeEntry[] = [];

  if (pendingRootCreate) {
    entries.push(createSyntheticCreateEntry(pendingRootCreate));
  }

  entries.push(
    ...createNodeEntries({
      nodes,
      workspaceId,
      parentPath: null,
      expandedPaths,
      pendingExplorerEdit,
      pendingExplorerDelete,
    }),
  );

  return entries;
}

function createNodeEntries({
  nodes,
  workspaceId,
  parentPath,
  expandedPaths,
  pendingExplorerEdit,
  pendingExplorerDelete,
}: {
  nodes: readonly WorkspaceFileTreeNode[];
  workspaceId: WorkspaceId;
  parentPath: string | null;
  expandedPaths: Record<string, true>;
  pendingExplorerEdit?: EditorPendingExplorerEdit | null;
  pendingExplorerDelete?: EditorPendingExplorerDelete | null;
}): FileTreeEntry[] {
  const entries: FileTreeEntry[] = [];

  for (const node of nodes) {
    const isDirectory = node.kind === "directory";
    const isExpanded = Boolean(expandedPaths[node.path]);
    const isDeleting = pendingDeleteForPath(pendingExplorerDelete, workspaceId, node.path);
    const children = isDirectory
      ? createDirectoryChildren({
          node,
          workspaceId,
          expandedPaths,
          pendingExplorerEdit,
          pendingExplorerDelete,
          includeDeleteConfirmation: isDeleting && isExpanded,
        })
      : undefined;

    entries.push({
      entryType: "node",
      id: node.path,
      name: node.name,
      path: node.path,
      kind: node.kind,
      node,
      parentPath,
      children,
    });

    if (isDeleting && (!isDirectory || !isExpanded)) {
      entries.push(createSyntheticDeleteEntry(node, parentPath));
    }
  }

  return entries;
}

function createDirectoryChildren({
  node,
  workspaceId,
  expandedPaths,
  pendingExplorerEdit,
  pendingExplorerDelete,
  includeDeleteConfirmation,
}: {
  node: WorkspaceFileTreeNode;
  workspaceId: WorkspaceId;
  expandedPaths: Record<string, true>;
  pendingExplorerEdit?: EditorPendingExplorerEdit | null;
  pendingExplorerDelete?: EditorPendingExplorerDelete | null;
  includeDeleteConfirmation: boolean;
}): FileTreeEntry[] {
  const children: FileTreeEntry[] = [];
  const pendingCreate = pendingCreateForParent(pendingExplorerEdit, workspaceId, node.path);

  if (includeDeleteConfirmation) {
    children.push(createSyntheticDeleteEntry(node, node.path));
  }

  if (pendingCreate) {
    children.push(createSyntheticCreateEntry(pendingCreate));
  }

  children.push(
    ...createNodeEntries({
      nodes: node.children ?? [],
      workspaceId,
      parentPath: node.path,
      expandedPaths,
      pendingExplorerEdit,
      pendingExplorerDelete,
    }),
  );

  return children;
}

function createSyntheticCreateEntry(
  edit: Extract<EditorPendingExplorerEdit, { type: "create" }>,
): FileTreeCreateEntry {
  const parentSegment = edit.parentPath ?? "root";
  return {
    entryType: "create",
    id: `__nexus_create__:${edit.workspaceId}:${parentSegment}:${edit.kind}`,
    name: edit.kind === "directory" ? "New folder" : "New file",
    path: "",
    kind: edit.kind,
    parentPath: edit.parentPath ?? null,
    edit,
  };
}

function createSyntheticDeleteEntry(
  node: WorkspaceFileTreeNode,
  parentPath: string | null,
): FileTreeDeleteEntry {
  return {
    entryType: "delete",
    id: `__nexus_delete__:${node.path}`,
    name: `Delete ${node.name}`,
    path: node.path,
    kind: node.kind,
    parentPath,
    target: node,
  };
}

function createArboristOpenState(
  expandedPaths: Record<string, true>,
  pendingExplorerEdit: EditorPendingExplorerEdit | null | undefined,
  workspaceId: WorkspaceId,
): Record<string, boolean> {
  const openState: Record<string, boolean> = {};
  for (const path of Object.keys(expandedPaths)) {
    openState[path] = true;
  }

  if (pendingExplorerEdit?.type === "create" && pendingExplorerEdit.workspaceId === workspaceId && pendingExplorerEdit.parentPath) {
    openState[pendingExplorerEdit.parentPath] = true;
  }

  return openState;
}

function syncArboristOpenState(
  tree: ArboristTreeApi<FileTreeEntry> | undefined,
  nodes: readonly WorkspaceFileTreeNode[],
  desiredOpenState: Record<string, boolean>,
  syncingOpenStateRef: { current: boolean },
): void {
  if (!tree) {
    return;
  }

  const directoryPaths = collectDirectoryPaths(nodes);
  syncingOpenStateRef.current = true;
  try {
    for (const path of directoryPaths) {
      const shouldBeOpen = Boolean(desiredOpenState[path]);
      if (tree.isOpen(path) === shouldBeOpen) {
        continue;
      }

      if (shouldBeOpen) {
        tree.open(path);
      } else {
        tree.close(path);
      }
    }
  } finally {
    syncingOpenStateRef.current = false;
  }
}

function collectDirectoryPaths(nodes: readonly WorkspaceFileTreeNode[]): string[] {
  const paths: string[] = [];
  const walk = (treeNodes: readonly WorkspaceFileTreeNode[]): void => {
    for (const node of treeNodes) {
      if (node.kind === "directory") {
        paths.push(node.path);
        walk(node.children ?? []);
      }
    }
  };
  walk(nodes);
  return paths;
}

function expandedPathsSignature(expandedPaths: Record<string, true>): string {
  return Object.keys(expandedPaths).sort().join("\u0000");
}

function useElementBounds(ref: { current: HTMLElement | null }): { width: number; height: number } {
  const [bounds, setBounds] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const updateBounds = (): void => {
      const rect = element.getBoundingClientRect();
      setBounds((currentBounds) => {
        const nextBounds = {
          width: Math.max(0, rect.width),
          height: Math.max(0, rect.height),
        };
        if (currentBounds.width === nextBounds.width && currentBounds.height === nextBounds.height) {
          return currentBounds;
        }
        return nextBounds;
      });
    };

    updateBounds();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateBounds);
      observer.observe(element);
      return () => {
        observer.disconnect();
      };
    }

    window.addEventListener("resize", updateBounds);
    return () => {
      window.removeEventListener("resize", updateBounds);
    };
  }, [ref]);

  return bounds;
}

function annotateArboristTreeElement(
  host: HTMLElement | null,
  workspace: OpenSessionWorkspace,
  selectedTreePath: string | null,
  loading: boolean,
): void {
  const treeElement = host?.querySelector<HTMLElement>('[role="tree"]') ?? null;
  if (!treeElement) {
    return;
  }

  treeElement.setAttribute("data-action", "file-tree");
  treeElement.setAttribute("data-active-path", selectedTreePath ?? "");
  treeElement.setAttribute("aria-label", `${workspace.displayName} files`);
  treeElement.setAttribute("aria-multiselectable", "true");

  if (selectedTreePath) {
    treeElement.setAttribute("aria-activedescendant", treeItemId(workspace.id, selectedTreePath));
  } else {
    treeElement.removeAttribute("aria-activedescendant");
  }

  if (loading) {
    treeElement.setAttribute("aria-busy", "true");
  } else {
    treeElement.removeAttribute("aria-busy");
  }
}

export function handleTreeKeyDown(
  event: KeyboardEvent<HTMLElement>,
  workspaceId: WorkspaceId,
  props: FileTreePanelProps,
  visiblePaths: readonly string[] = visibleNodePathsForMultiSelect(
    createFileTreeArboristData({
      nodes: props.fileTree.nodes,
      workspaceId,
      expandedPaths: props.expandedPaths,
      pendingExplorerEdit: props.pendingExplorerEdit ?? null,
      pendingExplorerDelete: props.pendingExplorerDelete ?? null,
    }),
  ),
): void {
  if (isTextEditingTarget(event.target)) {
    return;
  }

  if (isImeCompositionEvent(event)) {
    event.stopPropagation();
    return;
  }

  const selectedPath = props.selectedTreePath ?? null;
  const selectedNode = selectedPath ? findFileTreeNodeByPath(props.fileTree.nodes, selectedPath) : null;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
    stopKeyboardEvent(event);
    fileTreeMultiSelectStore.getState().selectAll(
      currentFolderChildPaths(props.fileTree.nodes, selectedPath),
    );
    return;
  }

  if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    stopKeyboardEvent(event);
    const selectedIndex = selectedPath ? visiblePaths.indexOf(selectedPath) : -1;
    const fallbackIndex = event.key === "ArrowUp" ? visiblePaths.length - 1 : 0;
    const nextIndex = selectedIndex < 0
      ? fallbackIndex
      : Math.min(
          Math.max(selectedIndex + (event.key === "ArrowUp" ? -1 : 1), 0),
          visiblePaths.length - 1,
        );
    const nextPath = visiblePaths[nextIndex] ?? selectedPath;
    if (nextPath) {
      const state = fileTreeMultiSelectStore.getState();
      state.rangeSelect(state.lastAnchor ?? selectedPath ?? nextPath, nextPath, visiblePaths);
      props.onSelectTreePath?.(nextPath);
    }
    return;
  }

  const movement = keyboardMovementForKey(event.key);
  if (movement) {
    stopKeyboardEvent(event);
    props.onMoveTreeSelection?.(movement);
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    if (!selectedNode) {
      if (event.key === " ") {
        stopKeyboardEvent(event);
      }
      return;
    }
    stopKeyboardEvent(event);
    if (selectedNode.kind === "directory") {
      props.onToggleDirectory(selectedNode.path);
    } else {
      props.onOpenFile(workspaceId, selectedNode.path);
    }
    return;
  }

  if (event.key === "F2") {
    stopKeyboardEvent(event);
    if (!selectedNode) {
      return;
    }
    props.onBeginRename?.(selectedNode.path, selectedNode.kind);
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    stopKeyboardEvent(event);
    const multiItems = selectedPath
      ? selectedItemsForContextMenu(
          workspaceId,
          selectedPath,
          fileTreeMultiSelectStore.getState().selectedPaths,
          props.fileTree.nodes,
        )
      : [];
    if (multiItems.length > 1) {
      if (confirmMultiDelete(multiItems)) {
        for (const item of multiItems) {
          props.onDeleteNode(item.workspaceId, item.path, item.kind);
        }
      }
      return;
    }
    if (!selectedNode) {
      return;
    }
    props.onBeginDelete?.(selectedNode.path, selectedNode.kind);
    return;
  }

  if (event.key === "Escape") {
    stopKeyboardEvent(event);
    fileTreeMultiSelectStore.getState().clearSelect();
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

export function handleCreateSubmit(
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

export function handleRenameSubmit(
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

export function handleEditFormKeyDown(
  event: KeyboardEvent<HTMLFormElement>,
  onCancelExplorerEdit?: FileTreePanelProps["onCancelExplorerEdit"],
): void {
  event.stopPropagation();

  if (isImeCompositionEvent(event) || event.key !== "Escape") {
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

function findFileTreeNodeByPath(nodes: readonly WorkspaceFileTreeNode[], path: string): WorkspaceFileTreeNode | null {
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

function visibleNodePathsForMultiSelect(entries: readonly FileTreeEntry[]): string[] {
  const paths: string[] = [];
  const walk = (items: readonly FileTreeEntry[]): void => {
    for (const item of items) {
      if (item.entryType === "node") {
        paths.push(item.path);
        walk(item.children ?? []);
      }
    }
  };
  walk(entries);
  return paths;
}

function currentFolderChildPaths(
  nodes: readonly WorkspaceFileTreeNode[],
  selectedPath: string | null,
): string[] {
  const selectedNode = selectedPath ? findFileTreeNodeByPath(nodes, selectedPath) : null;
  const parentPath = selectedNode?.kind === "directory"
    ? selectedNode.path
    : selectedPath
      ? parentPathForNode(nodes, selectedPath)
      : null;
  const folderChildren = parentPath
    ? findFileTreeNodeByPath(nodes, parentPath)?.children ?? []
    : nodes;
  return folderChildren.map((node) => node.path);
}

function handleMultiSelectClick(
  event: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  path: string,
  visiblePaths: readonly string[],
  panelProps: FileTreePanelProps,
): boolean {
  const store = fileTreeMultiSelectStore.getState();
  if (event.metaKey || event.ctrlKey) {
    store.toggleSelect(path);
    panelProps.onSelectTreePath?.(path);
    return true;
  }

  if (event.shiftKey) {
    store.rangeSelect(store.lastAnchor ?? panelProps.selectedTreePath ?? path, path, visiblePaths);
    panelProps.onSelectTreePath?.(path);
    return true;
  }

  return false;
}

function selectedItemsForContextMenu(
  workspaceId: WorkspaceId,
  targetPath: string,
  selectedPaths: ReadonlySet<string>,
  nodes: readonly WorkspaceFileTreeNode[],
): FileClipboardItem[] {
  const paths = selectedPaths.has(targetPath) ? Array.from(selectedPaths) : [targetPath];
  return paths
    .map((path) => {
      const node = findFileTreeNodeByPath(nodes, path);
      return node ? { workspaceId, path, kind: node.kind } : null;
    })
    .filter((item): item is FileClipboardItem => item !== null);
}

function fileTreeDragPathsForNode(
  workspaceId: WorkspaceId,
  targetPath: string,
  targetKind: WorkspaceFileKind,
  selectedPaths: ReadonlySet<string>,
  nodes: readonly WorkspaceFileTreeNode[],
): string[] {
  const items = selectedItemsForContextMenu(workspaceId, targetPath, selectedPaths, nodes);
  if (items.length === 0) {
    return [targetPath];
  }
  if (!items.some((item) => item.path === targetPath && item.kind === targetKind)) {
    return [targetPath];
  }
  return items.map((item) => item.path);
}

function confirmMultiDelete(items: readonly FileClipboardItem[]): boolean {
  const message = `Delete ${items.length} files? This cannot be undone.`;
  if (typeof globalThis.confirm !== "function") {
    return true;
  }
  return globalThis.confirm(message);
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

function isImeCompositionEvent(event: KeyboardEvent<HTMLElement>): boolean {
  const eventWithComposition = event as KeyboardEvent<HTMLElement> & {
    isComposing?: boolean;
    keyCode?: number;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
  };
  return (
    eventWithComposition.isComposing === true ||
    eventWithComposition.nativeEvent?.isComposing === true ||
    eventWithComposition.keyCode === 229 ||
    eventWithComposition.nativeEvent?.keyCode === 229
  );
}

function stopKeyboardEvent(event: KeyboardEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

function stopReactEvent(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

function isSyntheticFileTreeEntryId(id: string): boolean {
  return id.startsWith("__nexus_create__:") || id.startsWith("__nexus_delete__:");
}

export function gitBadgeText(status: WorkspaceGitBadgeStatus): string {
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

export function gitBadgeLabel(status: WorkspaceGitBadgeStatus): string {
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
