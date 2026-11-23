import { useTranslation } from "react-i18next";
import { SegmentedControl } from "../../settings/segmented-control";

export type EditorViewMode = "raw" | "preview";

interface ViewModeToggleProps {
  mode: EditorViewMode;
  onChange: (mode: EditorViewMode) => void;
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
