import i18next from "i18next";
import type { GitExpandedGroupKey, GitMergeMode, Tag } from "../../../../../shared/git/types";
import type { GitPushOptions } from "../../../../state/stores/git";
import type { FormDialogField } from "../../../ui/form-dialog";
import { FormDialog } from "../../../ui/form-dialog";
import { CommandPalette } from "../../../ui/palette/command-palette";
import type { PaletteSource } from "../../../ui/palette/types";
import { PromptDialog } from "../../../ui/prompt-dialog";
import { BranchCreateDialog } from "../branch/create-dialog";
import { BranchPicker } from "../branch/picker";
import type { CommitPickItem } from "../commit/picker-source";
import { ConfirmDiscardDialog } from "../dialogs/confirm-discard-dialog";
import { MergeOptionsDialog } from "../pickers/merge-options-dialog";
import type { MergeTargetPickItem } from "../pickers/merge-target-picker-source";
import type { RebaseTargetPickItem } from "../pickers/rebase-target-picker-source";
import { StashPicker } from "../pickers/stash-picker";
import { TagPicker } from "../pickers/tag-picker";
import type { GitPanelPickersState } from "../pickers/use-panel-pickers";
import type { GitDialogsState } from "./use-dialogs";

export interface GitDialogHostCallbacks {
  workspaceId: string;
  onDiscard: (relPaths: string[], source?: GitExpandedGroupKey) => void;
  onRemoveRemote: (remote: string) => void;
  onForcePush: (options: GitPushOptions) => void;
  onOpenBranchCreateDialog: (fromRef?: string) => void;
  onCloseBranchCreateDialog: () => void;
  onCreateBranch: (workspaceId: string, name: string, fromRef?: string) => Promise<void>;
  onConfirmMergeOption: (mode: GitMergeMode) => void;
  onConfirmPublish: () => void;
  onConfirmEmptyCommit: (message: string) => void;
  onConfirmStashGroup: (paths: string[], message: string) => void;
  onConfirmAddRemote: (name: string, url: string) => void;
  onRevealTagInHistory: (tag: Tag) => void;

  mergeTargetSource: PaletteSource<MergeTargetPickItem>;
  rebaseTargetSource: PaletteSource<RebaseTargetPickItem>;
  commitPickerSource: PaletteSource<CommitPickItem>;
  commitBranchSource: PaletteSource<MergeTargetPickItem>;

  addRemoteFields: FormDialogField[];

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
                title: i18next.t("files:git.dialogHost.forcePush.title"),
                description: i18next.t("files:git.dialogHost.forcePush.description"),
                relPaths: [],
                confirmLabel: i18next.t("files:git.dialogHost.forcePush.confirmLabel"),
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
        footer={i18next.t("files:git.dialogHost.footerMergeTarget")}
      />

      <CommandPalette<RebaseTargetPickItem>
        open={rebaseTargetPickerOpen}
        source={rebaseTargetSource}
        onClose={() => setRebaseTargetPickerOpen(false)}
        footer={i18next.t("files:git.dialogHost.footerRebaseTarget")}
      />

      <CommandPalette<CommitPickItem>
        open={commitPickerOpen}
        source={commitPickerSource}
        onClose={() => setCommitPickerOpen(false)}
        footer={i18next.t("files:git.dialogHost.footerCommitPicker")}
      />

      <CommandPalette<MergeTargetPickItem>
        open={commitBranchPickerOpen}
        source={commitBranchSource}
        onClose={() => setCommitBranchPickerOpen(false)}
        footer={i18next.t("files:git.dialogHost.footerCommitBranch")}
      />

      <BranchPicker
        workspaceId={workspaceId}
        open={branchCreateFromPickerOpen}
        mode="select-ref"
        title={i18next.t("files:git.dialogHost.createBranchFrom")}
        placeholder={i18next.t("files:git.dialogHost.createBranchFromPlaceholder")}
        onClose={() => setBranchCreateFromPickerOpen(false)}
        onSelectRef={(ref) => {
          setBranchCreateFromPickerOpen(false);
          onOpenBranchCreateDialog(ref);
        }}
        footer={i18next.t("files:git.dialogHost.footerCreateBranchFrom")}
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
        title={i18next.t("files:git.dialogHost.addRemote.title")}
        description={i18next.t("files:git.dialogHost.addRemote.description")}
        fields={addRemoteFields}
        submitLabel={i18next.t("files:git.dialogHost.addRemote.submitLabel")}
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
