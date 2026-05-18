/**
 * Aggregates the `open`/`request` state for every dialog the git panel mounts
 * (discard, branchCreate, mergeOptions, publish, emptyCommit, stashGroup,
 * addRemote, removeRemote, forcePush, contextBanner).
 *
 * Mirrors the useGitPanelPickers pattern: all state lives here so the panel
 * component's top-level useState block stays focused on data it actually
 * renders, not on dialog plumbing.
 *
 * Variable names match the original inline `useState` bindings so the panel
 * can destructure without touching downstream call sites.
 */

import { useState } from "react";
import type { BranchList } from "../../../../../shared/git/types";
import type { GitPushOptions } from "../../../../state/stores/git";
import type { PromptRequest } from "../../../ui/prompt-dialog";
import type { BranchCreateRequest } from "../branch/create-dialog";
import type { DiscardConfirmRequest } from "../dialogs/confirm-discard-dialog";
import type { MergeOptionsRequest } from "../pickers/merge-options-dialog";

export interface GitDialogsState {
  discardRequest: DiscardConfirmRequest | null;
  setDiscardRequest: (request: DiscardConfirmRequest | null) => void;

  branchCreateRequest: BranchCreateRequest | null;
  setBranchCreateRequest: (request: BranchCreateRequest | null) => void;
  branchCreateBranchList: BranchList | null;
  setBranchCreateBranchList: (list: BranchList | null) => void;
  branchCreateBranchListLoading: boolean;
  setBranchCreateBranchListLoading: (loading: boolean) => void;

  mergeOptionsRequest: MergeOptionsRequest | null;
  setMergeOptionsRequest: (request: MergeOptionsRequest | null) => void;

  publishRequest: PromptRequest | null;
  setPublishRequest: (request: PromptRequest | null) => void;

  emptyCommitRequest: PromptRequest | null;
  setEmptyCommitRequest: (request: PromptRequest | null) => void;

  stashGroupRequest: { paths: string[]; prompt: PromptRequest } | null;
  setStashGroupRequest: (request: { paths: string[]; prompt: PromptRequest } | null) => void;

  addRemoteOpen: boolean;
  setAddRemoteOpen: (open: boolean) => void;

  removeRemoteRequest: { remote: string; confirm: DiscardConfirmRequest } | null;
  setRemoveRemoteRequest: (
    request: { remote: string; confirm: DiscardConfirmRequest } | null,
  ) => void;

  forcePushRequest: GitPushOptions | null;
  setForcePushRequest: (request: GitPushOptions | null) => void;

  contextBanner: { variant: "info" | "error"; message: string } | null;
  setContextBanner: (banner: { variant: "info" | "error"; message: string } | null) => void;
}

export function useGitDialogs(): GitDialogsState {
  const [discardRequest, setDiscardRequest] = useState<DiscardConfirmRequest | null>(null);

  const [branchCreateRequest, setBranchCreateRequest] = useState<BranchCreateRequest | null>(null);
  const [branchCreateBranchList, setBranchCreateBranchList] = useState<BranchList | null>(null);
  const [branchCreateBranchListLoading, setBranchCreateBranchListLoading] = useState(false);

  const [mergeOptionsRequest, setMergeOptionsRequest] = useState<MergeOptionsRequest | null>(null);
  const [publishRequest, setPublishRequest] = useState<PromptRequest | null>(null);
  const [emptyCommitRequest, setEmptyCommitRequest] = useState<PromptRequest | null>(null);
  const [stashGroupRequest, setStashGroupRequest] = useState<{
    paths: string[];
    prompt: PromptRequest;
  } | null>(null);
  const [addRemoteOpen, setAddRemoteOpen] = useState(false);
  const [removeRemoteRequest, setRemoveRemoteRequest] = useState<{
    remote: string;
    confirm: DiscardConfirmRequest;
  } | null>(null);
  const [forcePushRequest, setForcePushRequest] = useState<GitPushOptions | null>(null);
  const [contextBanner, setContextBanner] = useState<{
    variant: "info" | "error";
    message: string;
  } | null>(null);

  return {
    discardRequest,
    setDiscardRequest,
    branchCreateRequest,
    setBranchCreateRequest,
    branchCreateBranchList,
    setBranchCreateBranchList,
    branchCreateBranchListLoading,
    setBranchCreateBranchListLoading,
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
    removeRemoteRequest,
    setRemoveRemoteRequest,
    forcePushRequest,
    setForcePushRequest,
    contextBanner,
    setContextBanner,
  };
}
