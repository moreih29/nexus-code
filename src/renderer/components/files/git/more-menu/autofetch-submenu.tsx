/**
 * Autofetch interval picker for GitMoreMenu, with the last-fetched caption
 * rendered as a non-interactive footer so the user can sanity-check that
 * cron is actually firing.
 */
import { useTranslation } from "react-i18next";
import type { GitAutofetchIntervalMin } from "../../../../../shared/git/types";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuText,
} from "../../../ui/dropdown-menu";
import { buildAutofetchMenuModel, formatLastFetchedCaption } from "../utils/more-menu-model";

export function AutofetchSubmenu({
  selected,
  lastFetchedAt,
  disabled,
  onSelect,
}: {
  selected: GitAutofetchIntervalMin;
  lastFetchedAt: number | null;
  disabled?: boolean;
  onSelect: (intervalMin: GitAutofetchIntervalMin) => void;
}) {
  const { t } = useTranslation("files");
  const model = buildAutofetchMenuModel(selected);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        {t("git.moreMenu.autofetch.label")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={String(selected)}
          onValueChange={(value) => {
            const item = model.find((option) => String(option.intervalMin) === value);
            if (item) onSelect(item.intervalMin);
          }}
        >
          {model.map((item) => (
            <DropdownMenuRadioItem key={item.intervalMin} value={String(item.intervalMin)}>
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuText muted>{formatLastFetchedCaption(lastFetchedAt)}</DropdownMenuText>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
