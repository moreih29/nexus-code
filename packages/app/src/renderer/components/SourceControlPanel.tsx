import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useStore } from "zustand";

import type { GitBranch as GitBranchInfo, GitStatusEntry } from "../../../../shared/src/contracts/generated/git-lifecycle";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { EmptyState } from "./EmptyState";
import { ScrollArea } from "./ui/scroll-area";
import { shouldIgnoreKeyboardShortcut } from "../stores/keyboard-registry";
import {
  commitMessageHint,
  EMPTY_SOURCE_CONTROL_WORKSPACE_STATE,
  getSourceControlFileGroups,
  hasStagedFiles,
  sourceControlStateLabel,
  statusKindBadge,
  statusKindLabel,
  type SourceControlFileGroup,
  type SourceControlStore,
  type SourceControlWorkspaceState,
} from "../stores/source-control-store";

export interface SourceControlPanelWorkspace {
  id: WorkspaceId;
  absolutePath: string;
  displayName: string;
}

export interface SourceControlPanelProps {
  activeWorkspace: SourceControlPanelWorkspace | null;
  sourceControlStore: SourceControlStore;
  onOpenDiffTab?(path: string, staged: boolean): void;
}

export interface SourceControlPanelViewProps {
  activeWorkspaceName?: string | null;
  branchDropdownOpen: boolean;
  branchFilter: string;
  fileGroups: SourceControlFileGroup[];
  newBranchName: string;
  workspaceState: SourceControlWorkspaceState;
  canUseSourceControl: boolean;
  onBranchDropdownOpenChange?(open: boolean): void;
  onBranchFilterChange?(value: string): void;
  onCheckoutBranch?(ref: string): void;
  onClearPendingCheckout?(): void;
  onCommit?(amend: boolean): void;
  onCommitMessageChange?(message: string): void;
  onConfirmDiscardCheckout?(): void;
  onCreateBranch?(): void;
  onDeleteBranch?(name: string): void;
  onDiscardPaths?(paths: string[]): void;
  onNewBranchNameChange?(value: string): void;
  onRefresh?(): void;
  onStagePaths?(paths: string[]): void;
  onUnstagePaths?(paths: string[]): void;
  onViewDiff?(path: string, staged?: boolean): void;
}

export function SourceControlPanel({
  activeWorkspace,
  sourceControlStore,
  onOpenDiffTab,
}: SourceControlPanelProps): JSX.Element {
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branchFilter, setBranchFilter] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const workspaceState = useStore(sourceControlStore, (state) =>
    activeWorkspace ? state.workspaceById[activeWorkspace.id] : null,
  ) ?? EMPTY_SOURCE_CONTROL_WORKSPACE_STATE;
  const fileGroups = useMemo(() => getSourceControlFileGroups(workspaceState.summary), [workspaceState.summary]);

  useEffect(() => {
    setBranchDropdownOpen(false);
    setBranchFilter("");
    setNewBranchName("");

    if (!activeWorkspace) {
      return;
    }

    const input = {
      workspaceId: activeWorkspace.id,
      cwd: activeWorkspace.absolutePath,
    };
    const store = sourceControlStore.getState();
    void Promise.all([
      store.refreshStatus(input),
      store.loadBranches(input),
      store.startWatch(input),
    ]).catch((error) => {
      console.error("Source Control: failed to initialize git state.", error);
    });
  }, [activeWorkspace?.absolutePath, activeWorkspace?.id, sourceControlStore]);

  if (!activeWorkspace) {
    return (
      <SourceControlPanelView
        workspaceState={EMPTY_SOURCE_CONTROL_WORKSPACE_STATE}
        fileGroups={[]}
        canUseSourceControl={false}
        branchDropdownOpen={false}
        branchFilter=""
        newBranchName=""
      />
    );
  }

  const workspaceInput = {
    workspaceId: activeWorkspace.id,
    cwd: activeWorkspace.absolutePath,
  };

  return (
    <SourceControlPanelView
      activeWorkspaceName={activeWorkspace.displayName}
      branchDropdownOpen={branchDropdownOpen}
      branchFilter={branchFilter}
      fileGroups={fileGroups}
      newBranchName={newBranchName}
      workspaceState={workspaceState}
      canUseSourceControl={true}
      onBranchDropdownOpenChange={setBranchDropdownOpen}
      onBranchFilterChange={setBranchFilter}
      onCheckoutBranch={(ref) => {
        void sourceControlStore.getState().checkoutBranch(workspaceInput, ref).catch((error) => {
          console.error("Source Control: failed to checkout branch.", error);
        });
      }}
      onClearPendingCheckout={() => sourceControlStore.getState().clearPendingCheckout(activeWorkspace.id)}
      onCommit={(amend) => {
        void sourceControlStore.getState().commit(workspaceInput, { amend }).catch((error) => {
          console.error("Source Control: failed to commit.", error);
        });
      }}
      onCommitMessageChange={(message) => sourceControlStore.getState().setCommitMessage(activeWorkspace.id, message)}
      onConfirmDiscardCheckout={() => {
        const ref = sourceControlStore.getState().getWorkspaceState(activeWorkspace.id).pendingCheckout?.ref;
        if (!ref) {
          return;
        }
        void sourceControlStore.getState().checkoutBranch(workspaceInput, ref, { discardDirty: true }).catch((error) => {
          console.error("Source Control: failed to discard and checkout branch.", error);
        });
      }}
      onCreateBranch={() => {
        const branchName = newBranchName.trim();
        if (!branchName) {
          return;
        }
        setNewBranchName("");
        void sourceControlStore.getState().createBranch(workspaceInput, branchName).catch((error) => {
          console.error("Source Control: failed to create branch.", error);
        });
      }}
      onDeleteBranch={(name) => {
        void sourceControlStore.getState().deleteBranch(workspaceInput, name).catch((error) => {
          console.error("Source Control: failed to delete branch.", error);
        });
      }}
      onDiscardPaths={(paths) => {
        void sourceControlStore.getState().discardPaths(workspaceInput, paths).catch((error) => {
          console.error("Source Control: failed to discard paths.", error);
        });
      }}
      onNewBranchNameChange={setNewBranchName}
      onRefresh={() => {
        void Promise.all([
          sourceControlStore.getState().refreshStatus(workspaceInput),
          sourceControlStore.getState().loadBranches(workspaceInput),
        ]).catch((error) => {
          console.error("Source Control: failed to refresh git state.", error);
        });
      }}
      onStagePaths={(paths) => {
        void sourceControlStore.getState().stagePaths(workspaceInput, paths).catch((error) => {
          console.error("Source Control: failed to stage paths.", error);
        });
      }}
      onUnstagePaths={(paths) => {
        void sourceControlStore.getState().unstagePaths(workspaceInput, paths).catch((error) => {
          console.error("Source Control: failed to unstage paths.", error);
        });
      }}
      onViewDiff={(path, staged) => {
        void sourceControlStore.getState().viewDiff(workspaceInput, path, staged).then(() => {
          onOpenDiffTab?.(path, staged ?? false);
        }).catch((error) => {
          console.error("Source Control: failed to read diff.", error);
        });
      }}
    />
  );
}

export function SourceControlPanelView({
  activeWorkspaceName,
  branchDropdownOpen,
  branchFilter,
  fileGroups,
  newBranchName,
  workspaceState,
  canUseSourceControl,
  onBranchDropdownOpenChange,
  onBranchFilterChange,
  onCheckoutBranch,
  onClearPendingCheckout,
  onCommit,
  onCommitMessageChange,
  onConfirmDiscardCheckout,
  onCreateBranch,
  onDeleteBranch,
  onDiscardPaths,
  onNewBranchNameChange,
  onRefresh,
  onStagePaths,
  onUnstagePaths,
  onViewDiff,
}: SourceControlPanelViewProps): JSX.Element {
  if (!canUseSourceControl) {
    return (
      <div data-component="source-control-panel" className="h-full">
        <EmptyState
          icon={GitBranch}
          title="No workspace selected"
          description="Open a workspace to review changes, branches, and commits."
        />
      </div>
    );
  }

  const groups = fileGroups.length > 0 ? fileGroups : getSourceControlFileGroups(workspaceState.summary);
  const stateLabel = sourceControlStateLabel(workspaceState.summary);
  const staged = hasStagedFiles(workspaceState.summary);
  const commitHint = commitMessageHint(workspaceState.commitMessage);
  const operation = workspaceState.operation;
  const commitBusy = operation === "commit";
  const canCommit = workspaceState.commitMessage.trim().length > 0 && staged && !commitBusy;

  return (
    <section
      data-component="source-control-panel"
      data-source-control-state={stateLabel}
      className="relative flex h-full min-h-0 flex-col"
    >
      <SourceControlHeader
        activeWorkspaceName={activeWorkspaceName}
        branchDropdownOpen={branchDropdownOpen}
        branchFilter={branchFilter}
        branches={workspaceState.branches}
        loading={workspaceState.status === "loading" || operation === "status"}
        newBranchName={newBranchName}
        summary={workspaceState.summary}
        onBranchDropdownOpenChange={onBranchDropdownOpenChange}
        onBranchFilterChange={onBranchFilterChange}
        onCheckoutBranch={onCheckoutBranch}
        onCreateBranch={onCreateBranch}
        onDeleteBranch={onDeleteBranch}
        onNewBranchNameChange={onNewBranchNameChange}
        onRefresh={onRefresh}
      />

      <div className="shrink-0 border-b border-border p-3">
        <textarea
          data-source-control-commit-input="true"
          aria-label="Commit message"
          value={workspaceState.commitMessage}
          placeholder="Message (⌘Enter to commit, ⌘⇧Enter to amend)"
          className="min-h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onCommitMessageChange?.(event.target.value)}
          onKeyDown={(event) => handleCommitKeyDown(event, onCommit)}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className={cn(
            "text-[11px] text-muted-foreground",
            (commitHint.subjectLength > 50 || commitHint.bodyMaxLength > 72) && "text-status-attention",
          )}>
            Subject {commitHint.subjectLength}/50 · Body {commitHint.bodyMaxLength}/72
          </p>
          <Button
            type="button"
            data-action="source-control-commit"
            size="sm"
            disabled={!canCommit}
            onClick={() => onCommit?.(false)}
          >
            <GitCommitHorizontal aria-hidden="true" className="size-3.5" />
            Commit
          </Button>
        </div>
      </div>

      {workspaceState.errorMessage ? (
        <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
          {workspaceState.errorMessage}
        </div>
      ) : null}

      {workspaceState.status === "loading" && !workspaceState.summary ? (
        <PanelMessage>Loading source control…</PanelMessage>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2 p-2">
            {stateLabel === "clean" ? (
              <div className="rounded-md border border-border bg-background/70 px-3 py-2 text-xs text-muted-foreground">
                Clean working tree.
              </div>
            ) : null}
            {groups.map((group) => (
              <SourceControlGroup
                key={group.id}
                group={group}
                operation={operation}
                onDiscardPaths={onDiscardPaths}
                onStagePaths={onStagePaths}
                onUnstagePaths={onUnstagePaths}
                onViewDiff={onViewDiff}
              />
            ))}
            <DiffPreview workspaceState={workspaceState} />
          </div>
        </ScrollArea>
      )}

      {workspaceState.pendingCheckout ? (
        <DirtyCheckoutDialog
          pendingCheckout={workspaceState.pendingCheckout}
          onCancel={onClearPendingCheckout}
          onConfirmDiscard={onConfirmDiscardCheckout}
        />
      ) : null}
    </section>
  );
}

function SourceControlHeader({
  activeWorkspaceName,
  branchDropdownOpen,
  branchFilter,
  branches,
  loading,
  newBranchName,
  summary,
  onBranchDropdownOpenChange,
  onBranchFilterChange,
  onCheckoutBranch,
  onCreateBranch,
  onDeleteBranch,
  onNewBranchNameChange,
  onRefresh,
}: {
  activeWorkspaceName?: string | null;
  branchDropdownOpen: boolean;
  branchFilter: string;
  branches: GitBranchInfo[];
  loading: boolean;
  newBranchName: string;
  summary: SourceControlWorkspaceState["summary"];
  onBranchDropdownOpenChange?(open: boolean): void;
  onBranchFilterChange?(value: string): void;
  onCheckoutBranch?(ref: string): void;
  onCreateBranch?(): void;
  onDeleteBranch?(name: string): void;
  onNewBranchNameChange?(value: string): void;
  onRefresh?(): void;
}): JSX.Element {
  const branchName = summary?.branch ?? branches.find((branch) => branch.current)?.name ?? "No branch";
  const filteredBranches = filterBranches(branches, branchFilter);

  return (
    <header className="relative flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
      <div className="min-w-0">
        <h3 className="truncate text-xs font-semibold uppercase tracking-[0.14em] text-foreground">
          Source Control
        </h3>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {activeWorkspaceName ?? "Active workspace"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          data-action="source-control-branch-dropdown"
          variant="outline"
          size="xs"
          aria-expanded={branchDropdownOpen}
          onClick={() => onBranchDropdownOpenChange?.(!branchDropdownOpen)}
        >
          <GitBranch aria-hidden="true" className="size-3" />
          <span className="max-w-28 truncate">{branchName}</span>
          {summary && (summary.ahead > 0 || summary.behind > 0) ? (
            <span className="font-mono text-[10px] text-muted-foreground">↑{summary.ahead} ↓{summary.behind}</span>
          ) : null}
        </Button>
        <Button
          type="button"
          data-action="source-control-refresh"
          variant="outline"
          size="xs"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh source control"
        >
          <RefreshCw aria-hidden="true" className={cn("size-3", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {branchDropdownOpen ? (
        <div
          data-source-control-branch-dropdown="true"
          className="absolute right-3 top-11 z-20 w-72 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg"
        >
          <input
            aria-label="Filter branches"
            value={branchFilter}
            placeholder="Filter branches"
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => onBranchFilterChange?.(event.target.value)}
          />
          <ol className="mt-2 max-h-44 space-y-1 overflow-auto" aria-label="Branches">
            {filteredBranches.map((branch) => (
              <li key={branch.name} className="flex items-center gap-1">
                <button
                  type="button"
                  data-action="source-control-checkout-branch"
                  data-branch-current={branch.current ? "true" : "false"}
                  className={cn(
                    "min-w-0 flex-1 rounded-md px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground",
                    branch.current && "bg-accent text-accent-foreground",
                  )}
                  disabled={branch.current}
                  onClick={() => onCheckoutBranch?.(branch.name)}
                >
                  <span className="block truncate">{branch.current ? "✓ " : ""}{branch.name}</span>
                  {branch.upstream ? <span className="block truncate text-[10px] text-muted-foreground">{branch.upstream}</span> : null}
                </button>
                <Button
                  type="button"
                  data-action="source-control-delete-branch"
                  aria-label={`Delete ${branch.name}`}
                  variant="ghost"
                  size="icon-xs"
                  disabled={branch.current}
                  onClick={() => onDeleteBranch?.(branch.name)}
                >
                  <Trash2 aria-hidden="true" className="size-3" />
                </Button>
              </li>
            ))}
          </ol>
          <div className="mt-2 flex items-center gap-1 border-t border-border pt-2">
            <input
              aria-label="Create branch name"
              value={newBranchName}
              placeholder="new-branch"
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => onNewBranchNameChange?.(event.target.value)}
            />
            <Button
              type="button"
              data-action="source-control-create-branch"
              variant="outline"
              size="xs"
              disabled={!newBranchName.trim()}
              onClick={onCreateBranch}
            >
              <Plus aria-hidden="true" className="size-3" />
              Create
            </Button>
          </div>
        </div>
      ) : null}
    </header>
  );
}

function SourceControlGroup({
  group,
  operation,
  onDiscardPaths,
  onStagePaths,
  onUnstagePaths,
  onViewDiff,
}: {
  group: SourceControlFileGroup;
  operation: SourceControlWorkspaceState["operation"];
  onDiscardPaths?(paths: string[]): void;
  onStagePaths?(paths: string[]): void;
  onUnstagePaths?(paths: string[]): void;
  onViewDiff?(path: string, staged?: boolean): void;
}): JSX.Element {
  const paths = group.entries.map((entry) => entry.path);
  const busy = operation === "stage" || operation === "unstage" || operation === "discard";

  return (
    <details data-source-control-group={group.id} open className="rounded-md border border-border bg-background/70">
      <summary className="flex cursor-default list-none items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-xs font-medium text-foreground">
        <span>{group.label}</span>
        <div className="flex items-center gap-1">
          {group.id === "changes" ? (
            <Button
              type="button"
              data-action="source-control-stage-all"
              variant="ghost"
              size="xs"
              disabled={paths.length === 0 || busy}
              onClick={(event) => {
                event.preventDefault();
                onStagePaths?.(paths);
              }}
            >
              Stage All
            </Button>
          ) : null}
          {group.id === "staged" ? (
            <Button
              type="button"
              data-action="source-control-unstage-all"
              variant="ghost"
              size="xs"
              disabled={paths.length === 0 || busy}
              onClick={(event) => {
                event.preventDefault();
                onUnstagePaths?.(paths);
              }}
            >
              Unstage All
            </Button>
          ) : null}
          <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {group.entries.length}
          </span>
        </div>
      </summary>
      {group.entries.length > 0 ? (
        <ol className="space-y-1 p-1">
          {group.entries.map((entry) => (
            <SourceControlFileRow
              key={`${group.id}:${entry.path}:${entry.status}`}
              entry={entry}
              groupId={group.id}
              operation={operation}
              onDiscardPaths={onDiscardPaths}
              onStagePaths={onStagePaths}
              onUnstagePaths={onUnstagePaths}
              onViewDiff={onViewDiff}
            />
          ))}
        </ol>
      ) : (
        <p className="px-2 py-2 text-xs text-muted-foreground">No files.</p>
      )}
    </details>
  );
}

function SourceControlFileRow({
  entry,
  groupId,
  operation,
  onDiscardPaths,
  onStagePaths,
  onUnstagePaths,
  onViewDiff,
}: {
  entry: GitStatusEntry;
  groupId: SourceControlFileGroup["id"];
  operation: SourceControlWorkspaceState["operation"];
  onDiscardPaths?(paths: string[]): void;
  onStagePaths?(paths: string[]): void;
  onUnstagePaths?(paths: string[]): void;
  onViewDiff?(path: string, staged?: boolean): void;
}): JSX.Element {
  const staged = groupId === "staged";
  const busy = operation === "stage" || operation === "unstage" || operation === "discard" || operation === "diff";

  return (
    <li>
      <div className="group flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground">
        <button
          type="button"
          data-action="source-control-view-diff-row"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => onViewDiff?.(entry.path, staged)}
        >
          <span className="shrink-0 rounded border border-border px-1 py-0.5 font-mono text-[10px] uppercase leading-none text-muted-foreground">
            {statusKindBadge(entry.kind)}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono">{entry.path}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{statusKindLabel(entry.kind)}</span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
          {staged ? (
            <Button
              type="button"
              data-action="source-control-unstage-file"
              aria-label={`Unstage ${entry.path}`}
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              onClick={() => onUnstagePaths?.([entry.path])}
            >
              <X aria-hidden="true" className="size-3" />
            </Button>
          ) : (
            <Button
              type="button"
              data-action="source-control-stage-file"
              aria-label={`Stage ${entry.path}`}
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              onClick={() => onStagePaths?.([entry.path])}
            >
              <Plus aria-hidden="true" className="size-3" />
            </Button>
          )}
          <Button
            type="button"
            data-action="source-control-discard-file"
            aria-label={`Discard ${entry.path}`}
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            onClick={() => onDiscardPaths?.([entry.path])}
          >
            <RotateCcw aria-hidden="true" className="size-3" />
          </Button>
          <Button
            type="button"
            data-action="source-control-view-diff"
            aria-label={`View diff for ${entry.path}`}
            variant="ghost"
            size="icon-xs"
            disabled={operation === "diff"}
            onClick={() => onViewDiff?.(entry.path, staged)}
          >
            <GitCompare aria-hidden="true" className="size-3" />
          </Button>
        </div>
      </div>
    </li>
  );
}

function DiffPreview({ workspaceState }: { workspaceState: SourceControlWorkspaceState }): JSX.Element | null {
  if (!workspaceState.diff.path) {
    return null;
  }

  return (
    <section data-source-control-diff-preview="true" className="rounded-md border border-border bg-background/70">
      <header className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-xs font-medium">
        <span className="min-w-0 truncate">Diff · {workspaceState.diff.path}</span>
        {workspaceState.diff.loading ? <span className="text-[10px] text-muted-foreground">Loading</span> : null}
      </header>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[11px] leading-normal text-muted-foreground">
        {workspaceState.diff.loading ? "Loading diff…" : workspaceState.diff.text || "No textual diff available for this file."}
      </pre>
    </section>
  );
}

function DirtyCheckoutDialog({
  pendingCheckout,
  onCancel,
  onConfirmDiscard,
}: {
  pendingCheckout: NonNullable<SourceControlWorkspaceState["pendingCheckout"]>;
  onCancel?(): void;
  onConfirmDiscard?(): void;
}): JSX.Element {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        data-source-control-dirty-checkout="true"
        className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg"
      >
        <h4 className="text-sm font-semibold text-foreground">Checkout with local changes?</h4>
        <p className="mt-2 text-xs text-muted-foreground">
          {pendingCheckout.dirtyFileCount} changed file{pendingCheckout.dirtyFileCount === 1 ? "" : "s"} may be overwritten by checking out {pendingCheckout.ref}.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            data-action="source-control-stash-checkout"
            variant="outline"
            size="sm"
            disabled
            title="Stash is planned for v0.2."
          >
            <Upload aria-hidden="true" className="size-3.5" />
            Stash
          </Button>
          <Button
            type="button"
            data-action="source-control-discard-checkout"
            variant="destructive"
            size="sm"
            onClick={onConfirmDiscard}
          >
            Discard & Checkout
          </Button>
          <Button
            type="button"
            data-action="source-control-cancel-checkout"
            variant="ghost"
            size="sm"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function handleCommitKeyDown(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
  onCommit?: (amend: boolean) => void,
): void {
  if (shouldIgnoreKeyboardShortcut(event.nativeEvent)) {
    return;
  }

  if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) {
    return;
  }

  event.preventDefault();
  onCommit?.(event.shiftKey);
}

function filterBranches(branches: GitBranchInfo[], branchFilter: string): GitBranchInfo[] {
  const query = branchFilter.trim().toLowerCase();
  if (!query) {
    return branches;
  }

  return branches.filter((branch) => branch.name.toLowerCase().includes(query));
}

function PanelMessage({ children }: { children: string }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
