import { MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GitAutofetchIntervalMin, RepoCapabilities } from "../../../../../shared/git/types";
import { Button } from "../../../ui/button";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import type { GitTagPickerMenuMode } from "../utils/more-menu-model";
import { AutofetchSubmenu } from "./autofetch-submenu";
import { BranchSubmenu } from "./branch-submenu";
import { RemotesSubmenu } from "./remotes-submenu";
import { StashSubmenu } from "./stash-submenu";
import { TagSubmenu } from "./tag-submenu";

interface GitMoreMenuProps {
  disabled?: boolean;
  canInit?: boolean;
  gitMissing?: boolean;
  hasChanges?: boolean;
  capabilities?: RepoCapabilities;
  onRefresh: () => void;
  onInit: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onStash: () => void;
  onStashPop: () => void;
  onOpenStashes: () => void;
  onDropStash: () => void;
  onOpenTags: (mode: GitTagPickerMenuMode, remote?: string) => void;
  onSwitchBranch: () => void;
  onMergeBranch: () => void;
  onRebaseBranch: () => void;
  onCreateBranch: () => void;
  onCreateBranchFrom: () => void;
  onRenameBranch: () => void;
  onDeleteBranch: () => void;
  onDeleteRemoteBranch: () => void;
  onPushTags: (remote: string) => void;
  onAddRemote: () => void;
  onRemoveRemote: (remote: string) => void;
  onDiscardAll: () => void;
  autofetchIntervalMin: GitAutofetchIntervalMin;
  lastFetchedAt: number | null;
  onSetAutofetchInterval: (intervalMin: GitAutofetchIntervalMin) => void;
}

export function GitMoreMenu({
  disabled = false,
  canInit = false,
  gitMissing = false,
  hasChanges = false,
  capabilities,
  onRefresh,
  onInit,
  onFetch,
  onPull,
  onPush,
  onStash,
  onStashPop,
  onOpenStashes,
  onDropStash,
  onOpenTags,
  onSwitchBranch,
  onMergeBranch,
  onRebaseBranch,
  onCreateBranch,
  onCreateBranchFrom,
  onRenameBranch,
  onDeleteBranch,
  onDeleteRemoteBranch,
  onPushTags,
  onAddRemote,
  onRemoveRemote,
  onDiscardAll,
  autofetchIntervalMin,
  lastFetchedAt,
  onSetAutofetchInterval,
}: GitMoreMenuProps) {
  const { t } = useTranslation("files");

  const repoBusy = disabled || canInit || gitMissing;
  const remotes = capabilities?.remotes ?? [];
  const hasRemote = (capabilities?.remotes.length ?? 0) > 0;
  const hasHead = capabilities?.hasHEAD ?? false;
  const stashCount = capabilities?.stashCount ?? 0;

  const noRemoteReason = hasRemote ? undefined : t("git.moreMenu.addRemoteFirst");

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          aria-label={t("git.panel.header.moreActions")}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onRefresh} disabled={disabled}>
          {t("git.moreMenu.refresh")}
        </DropdownMenuItem>
        {canInit ? (
          <DropdownMenuItem onSelect={onInit} disabled={disabled}>
            {t("git.moreMenu.initRepo")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onFetch}
          disabled={repoBusy || !hasRemote}
          tooltip={noRemoteReason}
        >
          {t("git.moreMenu.fetch")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onPull}
          disabled={repoBusy || !hasRemote}
          tooltip={noRemoteReason}
        >
          {t("git.moreMenu.pull")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onPush}
          disabled={repoBusy || !hasRemote}
          tooltip={noRemoteReason}
        >
          {t("git.moreMenu.push")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSwitchBranch} disabled={repoBusy}>
          {t("git.moreMenu.checkoutTo")}
        </DropdownMenuItem>
        <BranchSubmenu
          disabled={repoBusy}
          hasHead={hasHead}
          onMergeBranch={onMergeBranch}
          onRebaseBranch={onRebaseBranch}
          onCreateBranch={onCreateBranch}
          onCreateBranchFrom={onCreateBranchFrom}
          onRenameBranch={onRenameBranch}
          onDeleteBranch={onDeleteBranch}
          onDeleteRemoteBranch={onDeleteRemoteBranch}
        />
        <RemotesSubmenu
          remotes={remotes}
          disabled={repoBusy}
          onAddRemote={onAddRemote}
          onRemoveRemote={onRemoveRemote}
        />
        <StashSubmenu
          disabled={repoBusy}
          hasHead={hasHead}
          stashCount={stashCount}
          onStash={onStash}
          onStashPop={onStashPop}
          onOpenStashes={onOpenStashes}
          onDropStash={onDropStash}
        />
        <TagSubmenu
          disabled={repoBusy}
          hasHead={hasHead}
          remotes={remotes}
          onOpenTags={onOpenTags}
          onPushTags={onPushTags}
        />
        <DropdownMenuSeparator />
        <AutofetchSubmenu
          selected={autofetchIntervalMin}
          lastFetchedAt={lastFetchedAt}
          disabled={disabled}
          onSelect={onSetAutofetchInterval}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onDiscardAll}
          disabled={repoBusy || !hasChanges}
          className="git-destructive-text"
        >
          {t("git.moreMenu.discardAllChanges")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
