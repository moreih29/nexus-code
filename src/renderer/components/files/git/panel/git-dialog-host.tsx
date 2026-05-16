/**
 * GitDialogHost renders all modal dialogs that the git panel orchestrates.
 * It owns no state — state lives in useGitDialogs / useGitPanelPickers.
 * All git store calls are passed in as callbacks from the thin container.
 *
 * 12 logical dialogs: discard, removeRemote, forcePush, branchPicker,
 * mergeTargetPicker, rebaseTargetPicker, commitPicker, commitBranchPicker,
 * branchCreateFromPicker, stashPicker, tagPicker, mergeOptions, publish,
 * emptyCommit, branchCreate, stashGroup, addRemote.
 */

import type { FormDialogField } from "../../../ui/form-dialog";
import { FormDialog } from "../../../ui/form-dialog";
import { CommandPalette } from "../../../ui/palette/command-palette";
import type { PaletteSource } from "../../../ui/palette/types";
import { PromptDialog } from "../../../ui/prompt-dialog";
import { BranchCreateDialog } from "../branch/create-dialog";
import { BranchPicker } from "../branch/picker";
import type { CommitPickItem } from "../commit/picker-source";
import { ConfirmDiscardDialog } from "../clone/confirm-discard-dialog";
import { MergeOptionsDialog } from "../pickers/merge-options-dialog";
import type { MergeTargetPickItem } from "../pickers/merge-target-picker-source";
import type { RebaseTargetPickItem } from "../pickers/rebase-target-picker-source";
import { StashPicker } from "../pickers/stash-picker";
import { TagPicker } from "../pickers/tag-picker";
import type { GitPanelPickersState } from "../pickers/use-git-panel-pickers";
import type { GitDialogsState } from "./use-git-dialogs";
import type { GitExpandedGroupKey, GitMergeMode, Tag } from "../../../../../shared/git/types";
import type { GitPushOptions } from "../../../../state/stores/git";

export interface GitDialogHostCallbacks {
  workspaceId: string;
  /** Runs the confirmed discard. */
  onDiscard: (relPaths: string[], source?: GitExpandedGroupKey) => void;
  /** Runs the confirmed remove remote. */
  onRemoveRemote: (remote: string) => void;
  /** Runs the confirmed force push. */
  onForcePush: (options: GitPushOptions) => void;
  /** Opens the branch-create dialog (after prefetching the branch list). */
  onOpenBranchCreateDialog: (fromRef?: string) => void;
  /** Closes the branch-create dialog (also invalidates the in-flight branch list load). */
  onCloseBranchCreateDialog: () => void;
  /** Runs branch creation. */
  onCreateBranch: (
    workspaceId: string,
    name: string,
    fromRef?: string,
  ) => Promise<void>;
  /** Called when the user confirms a merge mode selection. */
  onConfirmMergeOption: (mode: GitMergeMode) => void;
  /** Runs push-with-publish. */
  onConfirmPublish: () => void;
  /** Runs empty commit with the given message. */
  onConfirmEmptyCommit: (message: string) => void;
  /** Runs stash-group with the given paths and message. */
  onConfirmStashGroup: (paths: string[], message: string) => void;
  /** Runs add-remote. */
  onConfirmAddRemote: (name: string, url: string) => void;
  /** Retargets the History panel to the selected tag. */
  onRevealTagInHistory: (tag: Tag) => void;

  // Source objects for command palettes
  mergeTargetSource: PaletteSource<MergeTargetPickItem>;
  rebaseTargetSource: PaletteSource<RebaseTargetPickItem>;
  commitPickerSource: PaletteSource<CommitPickItem>;
  commitBranchSource: PaletteSource<MergeTargetPickItem>;

  // Form fields for the add-remote dialog
  addRemoteFields: FormDialogField[];

  // In-flight busy flags for each dialog
  discardBusy: boolean;
  removeRemoteBusy: boolean;
  forcePushBusy: boolean;
  branchCreateBusy: boolean;
  mergeBusy: boolean;
  publishBusy: boolean;
  emptyCommitBusy: boolean;
  stashGroupBusy: boolean;
  addRemoteBusy: boolean;
}

interface GitDialogHostProps {
  dialogs: GitDialogsState;
  pickers: GitPanelPickersState;
  callbacks: GitDialogHostCallbacks;
}

export function GitDialogHost({ dialogs, pickers, callbacks }: GitDialogHostProps) {
  const {
    discardRequest,
    setDiscardRequest,
    removeRemoteRequest,
    setRemoveRemoteRequest,
    forcePushRequest,
    setForcePushRequest,
    branchCreateRequest,
    branchCreateBranchList,
    branchCreateBranchListLoading,
    mergeOptionsRequest,
    setMergeOptionsRequest,
    publishRequest,
    setPublishRequest,
    emptyCommitRequest,
    setEmptyCommitRequest,
    stashGroupRequest,
    setStashGroupRequest,
    addRemoteOpen,
    setAddRemoteOpen,
  } = dialogs;

  const {
    branchPickerOpen,
    setBranchPickerOpen,
    branchPickerMode,
    mergeTargetPickerOpen,
    setMergeTargetPickerOpen,
    rebaseTargetPickerOpen,
    setRebaseTargetPickerOpen,
    commitPickerOpen,
    setCommitPickerOpen,
    commitBranchPickerOpen,
    setCommitBranchPickerOpen,
    branchCreateFromPickerOpen,
    setBranchCreateFromPickerOpen,
    stashPickerOpen,
    setStashPickerOpen,
    stashPickerMode,
    tagPickerOpen,
    setTagPickerOpen,
    tagPickerMode,
    tagPickerRemote,
  } = pickers;

  const {
    workspaceId,
    onDiscard,
    onRemoveRemote,
    onForcePush,
    onOpenBranchCreateDialog,
    onCloseBranchCreateDialog,
    onCreateBranch,
    onConfirmMergeOption,
    onConfirmPublish,
    onConfirmEmptyCommit,
    onConfirmStashGroup,
    onConfirmAddRemote,
    onRevealTagInHistory,
    mergeTargetSource,
    rebaseTargetSource,
    commitPickerSource,
    commitBranchSource,
    addRemoteFields,
    discardBusy,
    removeRemoteBusy,
    forcePushBusy,
    branchCreateBusy,
    mergeBusy,
    publishBusy,
    emptyCommitBusy,
    stashGroupBusy,
    addRemoteBusy,
  } = callbacks;

  return (
    <>
      <ConfirmDiscardDialog
        request={discardRequest}
        busy={discardBusy}
        onCancel={() => setDiscardRequest(null)}
        onConfirm={(request) => {
          setDiscardRequest(null);
          onDiscard(request.relPaths, request.source);
        }}
      />
      <ConfirmDiscardDialog
        request={removeRemoteRequest?.confirm ?? null}
        busy={removeRemoteBusy}
        onCancel={() => setRemoveRemoteRequest(null)}
        onConfirm={() => {
          const remote = removeRemoteRequest?.remote;
          setRemoveRemoteRequest(null);
          if (!remote) return;
          onRemoveRemote(remote);
        }}
      />
      <ConfirmDiscardDialog
        request={
          forcePushRequest
            ? {
                title: "Force push will overwrite remote. Are you sure?",
                description: "Uses --force-with-lease and stops if the remote changed again.",
                relPaths: [],
                confirmLabel: "Force Push",
              }
            : null
        }
        busy={forcePushBusy}
        onCancel={() => setForcePushRequest(null)}
        onConfirm={() => {
          const options = forcePushRequest;
          setForcePushRequest(null);
          if (!options) return;
          onForcePush(options);
        }}
      />

      <BranchPicker
        workspaceId={workspaceId}
        open={branchPickerOpen}
        mode={branchPickerMode}
        onClose={() => setBranchPickerOpen(false)}
      />

      <CommandPalette<MergeTargetPickItem>
        open={mergeTargetPickerOpen}
        source={mergeTargetSource}
        onClose={() => setMergeTargetPickerOpen(false)}
        footer="Enter choose merge target · Current branch hidden"
      />

      <CommandPalette<RebaseTargetPickItem>
        open={rebaseTargetPickerOpen}
        source={rebaseTargetSource}
        onClose={() => setRebaseTargetPickerOpen(false)}
        footer="Enter choose rebase target · Current branch hidden"
      />

      <CommandPalette<CommitPickItem>
        open={commitPickerOpen}
        source={commitPickerSource}
        onClose={() => setCommitPickerOpen(false)}
        footer="Enter cherry-pick one commit · Multi-pick is not enabled"
      />

      <CommandPalette<MergeTargetPickItem>
        open={commitBranchPickerOpen}
        source={commitBranchSource}
        onClose={() => setCommitBranchPickerOpen(false)}
        footer="Enter choose branch · Current branch hidden"
      />

      <BranchPicker
        workspaceId={workspaceId}
        open={branchCreateFromPickerOpen}
        mode="select-ref"
        title="Create branch from"
        placeholder="Select a branch to create from…"
        onClose={() => setBranchCreateFromPickerOpen(false)}
        onSelectRef={(ref) => {
          setBranchCreateFromPickerOpen(false);
          onOpenBranchCreateDialog(ref);
        }}
        footer="Enter choose start point · Working tree is not changed"
      />

      <StashPicker
        workspaceId={workspaceId}
        open={stashPickerOpen}
        mode={stashPickerMode}
        onClose={() => setStashPickerOpen(false)}
      />

      <TagPicker
        workspaceId={workspaceId}
        open={tagPickerOpen}
        mode={tagPickerMode}
        selectedRemote={tagPickerRemote}
        onClose={() => setTagPickerOpen(false)}
        onRequestReopen={() => setTagPickerOpen(true)}
        onRevealTag={onRevealTagInHistory}
      />

      <MergeOptionsDialog
        request={mergeOptionsRequest}
        busy={mergeBusy}
        onCancel={() => setMergeOptionsRequest(null)}
        onConfirm={(_option, mode) => {
          onConfirmMergeOption(mode);
        }}
      />

      <PromptDialog
        request={publishRequest}
        busy={publishBusy}
        onCancel={() => setPublishRequest(null)}
        onConfirm={() => {
          setPublishRequest(null);
          onConfirmPublish();
        }}
      />
      <PromptDialog
        request={emptyCommitRequest}
        busy={emptyCommitBusy}
        onCancel={() => setEmptyCommitRequest(null)}
        onConfirm={(value) => {
          setEmptyCommitRequest(null);
          onConfirmEmptyCommit(value);
        }}
      />
      <BranchCreateDialog
        request={branchCreateRequest}
        branchList={branchCreateBranchList}
        loadingExistingBranches={branchCreateBranchListLoading}
        busy={branchCreateBusy}
        onCancel={onCloseBranchCreateDialog}
        onSubmit={(name) => {
          const request = branchCreateRequest;
          onCloseBranchCreateDialog();
          if (!request) return;
          void onCreateBranch(workspaceId, name, request.fromRef);
        }}
      />
      <PromptDialog
        request={stashGroupRequest?.prompt ?? null}
        busy={stashGroupBusy}
        onCancel={() => setStashGroupRequest(null)}
        onConfirm={(value) => {
          const request = stashGroupRequest;
          setStashGroupRequest(null);
          if (!request) return;
          onConfirmStashGroup(request.paths, value);
        }}
      />
      <FormDialog
        open={addRemoteOpen}
        title="Add remote"
        description="Configure a local Git remote. The URL pattern is checked locally without a network probe."
        fields={addRemoteFields}
        submitLabel="Add Remote"
        errorClassName="git-destructive-text"
        busy={addRemoteBusy}
        onCancel={() => setAddRemoteOpen(false)}
        onSubmit={({ values }) => {
          setAddRemoteOpen(false);
          onConfirmAddRemote(values.name ?? "", values.url ?? "");
        }}
      />
    </>
  );
}
