// The inline field a workspace's name becomes while it is renamed.

import { useTranslation } from "react-i18next";
import { isImeComposing } from "../../utils/ime";
import type { useWorkspaceRename } from "./workspace-rename";

export function WorkspaceNameInput({
  rename,
  className,
}: {
  rename: ReturnType<typeof useWorkspaceRename>;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <input
      ref={rename.inputRef}
      value={rename.draft}
      onChange={(e) => rename.setDraft(e.target.value)}
      onKeyDown={(e) => {
        // Keys stay here: Space and the arrows must not reach the row's button or list.
        e.stopPropagation();
        if (isImeComposing(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          rename.end(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          rename.end(false);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " ") e.preventDefault();
      }}
      onBlur={() => rename.end(true)}
      onClick={(e) => e.stopPropagation()}
      className={className}
      aria-label={t("sidebar.rename_aria")}
      spellCheck={false}
    />
  );
}
