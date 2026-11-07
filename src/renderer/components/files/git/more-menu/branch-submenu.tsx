/**
 * Branch flyout for GitMoreMenu. Items are driven by the shared menu model so
 * enablement (e.g. requires HEAD) lives next to other Git menu decisions
 * rather than inline in this view.
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
  buildGitBranchMenuModel,
  type GitBranchMenuActionHandlers,
  runGitBranchMenuAction,
} from "../utils/more-menu-model";

export function BranchSubmenu({
  disabled,
  hasHead,
  ...handlers
}: {
  disabled?: boolean;
  hasHead: boolean;
} & GitBranchMenuActionHandlers) {
  const { t } = useTranslation("files");
  const model = buildGitBranchMenuModel({ disabled, hasHead });

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        {t("git.moreMenu.branch.label")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {model.map((item) =>
          item.kind === "separator" ? (
            <DropdownMenuSeparator key={item.id} />
          ) : (
            <DropdownMenuItem
              key={item.id}
              disabled={item.disabled}
              tooltip={item.title}
              onSelect={() => runGitBranchMenuAction(item.id, handlers)}
            >
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
