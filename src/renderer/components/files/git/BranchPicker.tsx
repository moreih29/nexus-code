/**
 * BranchPicker — VS Code-style "Checkout to..." quick-pick (matches the
 * `git.checkout` command). Combines checkout (existing local/remote) and
 * create-branch (new name) in a single filtered list with keyboard navigation.
 */

import { useMemo } from "react";
import { useGitStore } from "../../../state/stores/git";
import { CommandPalette } from "../../ui/palette/command-palette";
import {
  type BranchPickItem,
  createBranchPickerSource,
} from "./branch-picker-source";

interface BranchPickerProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}

export function BranchPicker({ workspaceId, open, onClose }: BranchPickerProps) {
  const listBranches = useGitStore((state) => state.listBranches);
  const checkout = useGitStore((state) => state.checkout);
  const checkoutTracking = useGitStore((state) => state.checkoutTracking);
  const createBranch = useGitStore((state) => state.createBranch);

  const source = useMemo(
    () =>
      createBranchPickerSource({
        workspaceId,
        listBranches,
        checkout,
        checkoutTracking,
        createBranch,
      }),
    [workspaceId, listBranches, checkout, checkoutTracking, createBranch],
  );

  return <CommandPalette<BranchPickItem> open={open} source={source} onClose={onClose} />;
}
