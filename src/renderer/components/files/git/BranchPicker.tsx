/**
 * BranchPicker — VS Code-style "Switch Branch" quick-pick. Combines
 * checkout (existing local/remote) and create-branch (new name) in a single
 * filtered list with keyboard navigation.
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
  const createBranch = useGitStore((state) => state.createBranch);

  const source = useMemo(
    () =>
      createBranchPickerSource({
        workspaceId,
        listBranches,
        checkout,
        createBranch,
      }),
    [workspaceId, listBranches, checkout, createBranch],
  );

  return <CommandPalette<BranchPickItem> open={open} source={source} onClose={onClose} />;
}
