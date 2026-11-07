/**
 * Stash flyout for GitMoreMenu. The model decides which entries are visible
 * and which are disabled (stash count, HEAD presence); this view only routes
 * the resulting pick onto the matching handler.
 */
import { useTranslation } from "react-i18next";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../../../ui/dropdown-menu";
import { buildGitStashMenuModel, type GitStashMenuItemId } from "../utils/more-menu-model";

export function StashSubmenu({
  disabled,
  hasHead,
  stashCount,
  onStash,
  onStashPop,
  onOpenStashes,
  onDropStash,
}: {
  disabled?: boolean;
  hasHead: boolean;
  stashCount: number;
  onStash: () => void;
  onStashPop: () => void;
  onOpenStashes: () => void;
  onDropStash: () => void;
}) {
  const { t } = useTranslation("files");
  const model = buildGitStashMenuModel({ disabled, hasHead, stashCount });
  const handlers: Record<GitStashMenuItemId, () => void> = {
    stash: onStash,
    "stash-pop": onStashPop,
    "open-stashes": onOpenStashes,
    "drop-stash": onDropStash,
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        {t("git.moreMenu.stash.label")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {model.map((item) =>
          item.kind === "separator" ? (
            <DropdownMenuSeparator key="stash-separator" />
          ) : (
            <DropdownMenuItem
              key={item.id}
              disabled={item.disabled}
              tooltip={item.title}
              onSelect={handlers[item.id]}
            >
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
