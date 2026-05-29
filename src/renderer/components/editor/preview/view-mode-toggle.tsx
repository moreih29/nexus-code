// view-mode-toggle.tsx — Raw / Preview segmented toggle for the editor header.
//
// Thin domain wrapper over the shared SegmentedControl. Lives at the right
// edge of EditorView's header row (paired with banners on the left), and
// drives EditorTab.viewMode in the tabs store.
//
// Why a wrapper instead of using SegmentedControl directly at the call site:
//   - Captures the fixed `["raw","preview"]` vocabulary so the call site can't
//     pass an arbitrary T.
//   - Centralises the "MDX preview is disabled for security" copy so the
//     reason stays consistent if it ever changes.

import { useTranslation } from "react-i18next";
import { SegmentedControl } from "../../settings/segmented-control";

export type EditorViewMode = "raw" | "preview";

interface ViewModeToggleProps {
  mode: EditorViewMode;
  onChange: (mode: EditorViewMode) => void;
  /**
   * When true the toggle renders as visually inert and onChange never fires.
   * Used for MDX (plan 60 issue 2) — the toggle stays visible so the user
   * sees why preview is unavailable, instead of silently disappearing.
   */
  disabled?: boolean;
  disabledReason?: string;
}

export function ViewModeToggle({ mode, onChange, disabled, disabledReason }: ViewModeToggleProps) {
  const { t } = useTranslation();
  const options = [
    { value: "raw" as const, label: t("editor.view_raw") },
    { value: "preview" as const, label: t("editor.view_preview") },
  ];
  return (
    <SegmentedControl<EditorViewMode>
      label={t("editor.view_mode_label")}
      options={options}
      value={mode}
      onChange={onChange}
      disabled={disabled}
      disabledReason={disabledReason}
    />
  );
}
