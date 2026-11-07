/**
 * Tag flyout for GitMoreMenu plus its two nested remote-picker submenus.
 * Tag entries route to either the existing picker dialog or, when multiple
 * remotes are configured, into a second-level remote chooser.
 */
import { useTranslation } from "react-i18next";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../../../ui/dropdown-menu";
import {
  buildGitTagMenuModel,
  type GitTagMenuActionHandlers,
  type GitTagMenuItemId,
  type GitTagPickerMenuMode,
  resolveGitDeleteRemoteTagAction,
  resolveGitPushTagsAction,
  runGitTagMenuAction,
} from "../utils/more-menu-model";

export function TagSubmenu({
  disabled,
  hasHead,
  remotes,
  onOpenTags,
  onPushTags,
}: {
  disabled?: boolean;
  hasHead: boolean;
  remotes: readonly string[];
  onOpenTags: (mode: GitTagPickerMenuMode, remote?: string) => void;
  onPushTags: (remote: string) => void;
}) {
  const { t } = useTranslation("files");
  const model = buildGitTagMenuModel({ disabled, hasHead, remotes });
  const deleteRemoteTagAction = resolveGitDeleteRemoteTagAction({ disabled, hasHead, remotes });
  const pushTagsAction = resolveGitPushTagsAction({ disabled, hasHead, remotes });
  const tagHandlers: GitTagMenuActionHandlers = { onOpenTags };

  function select(id: GitTagMenuItemId): void {
    if (id === "delete-remote" && deleteRemoteTagAction.kind === "open-picker") {
      runGitTagMenuAction(id, tagHandlers, deleteRemoteTagAction.remote);
      return;
    }
    if (id === "push-tags" && pushTagsAction.kind === "push") {
      onPushTags(pushTagsAction.remote);
      return;
    }
    if (id !== "push-tags") runGitTagMenuAction(id, tagHandlers);
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        {t("git.moreMenu.tag.label")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {model.map((item) =>
          item.kind === "separator" ? (
            <DropdownMenuSeparator key={item.id} />
          ) : item.id === "delete-remote" && deleteRemoteTagAction.kind === "choose-remote" ? (
            <RemoteChooser
              key={item.id}
              label={t("git.moreMenu.tag.deleteRemote")}
              remotes={deleteRemoteTagAction.remotes}
              onPick={(remote) => onOpenTags("delete-remote", remote)}
            />
          ) : item.id === "push-tags" && pushTagsAction.kind === "choose-remote" ? (
            <RemoteChooser
              key={item.id}
              label={t("git.moreMenu.tag.pushTags")}
              remotes={pushTagsAction.remotes}
              onPick={onPushTags}
            />
          ) : (
            <DropdownMenuItem
              key={item.id}
              disabled={item.disabled}
              tooltip={item.title}
              onSelect={() => select(item.id)}
            >
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** A Tag entry that, with several remotes, asks which one in a submenu. */
function RemoteChooser({
  label,
  remotes,
  onPick,
}: {
  label: string;
  remotes: readonly string[];
  onPick: (remote: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {remotes.map((remote) => (
          <DropdownMenuItem key={remote} onSelect={() => onPick(remote)}>
            {remote}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
