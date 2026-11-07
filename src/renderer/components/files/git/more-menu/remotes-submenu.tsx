/**
 * Remotes flyout for GitMoreMenu, including the read-only current-remote
 * list, the Add Remote action, and a nested Remove Remote picker that lets
 * the user explicitly choose which remote to delete before the parent
 * dialog appears.
 */
import { useTranslation } from "react-i18next";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuText,
} from "../../../ui/dropdown-menu";
import { buildGitRemotesMenuModel } from "../utils/more-menu-model";

export function RemotesSubmenu({
  remotes,
  disabled,
  onAddRemote,
  onRemoveRemote,
}: {
  remotes: readonly string[];
  disabled?: boolean;
  onAddRemote: () => void;
  onRemoveRemote: (remote: string) => void;
}) {
  const { t } = useTranslation("files");
  const model = buildGitRemotesMenuModel(remotes);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        {t("git.moreMenu.remote.label")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {model.map((item) =>
          item.kind === "remote" ? (
            <DropdownMenuText key={item.remote}>{item.label}</DropdownMenuText>
          ) : item.kind === "empty" ? (
            <DropdownMenuText key="empty" muted>
              {item.label}
            </DropdownMenuText>
          ) : null,
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onAddRemote} disabled={disabled}>
          {t("git.moreMenu.remote.addRemote")}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            disabled={disabled || remotes.length === 0}
            tooltip={remotes.length === 0 ? t("git.moreMenu.remote.noRemotesTitle") : undefined}
          >
            {t("git.moreMenu.remote.removeRemote")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {remotes.map((remote) => (
              <DropdownMenuItem key={remote} onSelect={() => onRemoveRemote(remote)}>
                {remote}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
