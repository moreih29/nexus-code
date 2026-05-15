/**
 * Aggregates the `open`/`mode` state for every secondary picker the git panel
 * mounts (branch, merge target, rebase target, commit, branch-create source,
 * stash, tag). Keeping these flags in a dedicated hook keeps the panel
 * component's top-level useState block focused on the data it actually
 * renders, not on picker plumbing.
 *
 * Variable names match the original inline `useState` bindings so the panel
 * can destructure without touching downstream call sites.
 */

import { useState } from "react";
import type { BranchPickerMode } from "../branch/BranchPicker";
import type { StashPickerMode } from "./stash-picker-source";
import type { TagPickerMode } from "./tag-picker-source";

export interface GitPanelPickersState {
  branchPickerOpen: boolean;
  setBranchPickerOpen: (open: boolean) => void;
  branchPickerMode: BranchPickerMode;
  setBranchPickerMode: (mode: BranchPickerMode) => void;
  mergeTargetPickerOpen: boolean;
  setMergeTargetPickerOpen: (open: boolean) => void;
  rebaseTargetPickerOpen: boolean;
  setRebaseTargetPickerOpen: (open: boolean) => void;
  commitPickerOpen: boolean;
  setCommitPickerOpen: (open: boolean) => void;
  commitBranchPickerOpen: boolean;
  setCommitBranchPickerOpen: (open: boolean) => void;
  commitPickerRef: string | null;
  setCommitPickerRef: (ref: string | null) => void;
  branchCreateFromPickerOpen: boolean;
  setBranchCreateFromPickerOpen: (open: boolean) => void;
  stashPickerOpen: boolean;
  setStashPickerOpen: (open: boolean) => void;
  stashPickerMode: StashPickerMode;
  setStashPickerMode: (mode: StashPickerMode) => void;
  tagPickerOpen: boolean;
  setTagPickerOpen: (open: boolean) => void;
  tagPickerMode: TagPickerMode;
  setTagPickerMode: (mode: TagPickerMode) => void;
  tagPickerRemote: string | null;
  setTagPickerRemote: (remote: string | null) => void;
}

export function useGitPanelPickers(): GitPanelPickersState {
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branchPickerMode, setBranchPickerMode] = useState<BranchPickerMode>("switch");
  const [mergeTargetPickerOpen, setMergeTargetPickerOpen] = useState(false);
  const [rebaseTargetPickerOpen, setRebaseTargetPickerOpen] = useState(false);
  const [commitPickerOpen, setCommitPickerOpen] = useState(false);
  const [commitBranchPickerOpen, setCommitBranchPickerOpen] = useState(false);
  const [commitPickerRef, setCommitPickerRef] = useState<string | null>(null);
  const [branchCreateFromPickerOpen, setBranchCreateFromPickerOpen] = useState(false);
  const [stashPickerOpen, setStashPickerOpen] = useState(false);
  const [stashPickerMode, setStashPickerMode] = useState<StashPickerMode>("apply");
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [tagPickerMode, setTagPickerMode] = useState<TagPickerMode>("browse");
  const [tagPickerRemote, setTagPickerRemote] = useState<string | null>(null);

  return {
    branchPickerOpen,
    setBranchPickerOpen,
    branchPickerMode,
    setBranchPickerMode,
    mergeTargetPickerOpen,
    setMergeTargetPickerOpen,
    rebaseTargetPickerOpen,
    setRebaseTargetPickerOpen,
    commitPickerOpen,
    setCommitPickerOpen,
    commitBranchPickerOpen,
    setCommitBranchPickerOpen,
    commitPickerRef,
    setCommitPickerRef,
    branchCreateFromPickerOpen,
    setBranchCreateFromPickerOpen,
    stashPickerOpen,
    setStashPickerOpen,
    stashPickerMode,
    setStashPickerMode,
    tagPickerOpen,
    setTagPickerOpen,
    tagPickerMode,
    setTagPickerMode,
    tagPickerRemote,
    setTagPickerRemote,
  };
}
