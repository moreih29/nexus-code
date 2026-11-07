// The view each format with a preview opens in, its source or its preview:
// a row for each, with the extensions it is for.

import { useTranslation } from "react-i18next";
import {
  builtInViewMode,
  PREVIEW_FORMATS,
  type ViewMode,
} from "../../../services/editor/preview/previewable";
import { usePreviewDefaultsStore } from "../../../state/stores/preview-defaults";
import { SettingsGroup, SettingsRow } from "../section";
import { SegmentedControl, type SegmentedOption } from "../segmented-control";

export function PreviewDefaultsSection(): React.JSX.Element {
  const { t } = useTranslation("settings");
  const byFormat = usePreviewDefaultsStore((s) => s.byFormat);
  const setDefault = usePreviewDefaultsStore((s) => s.setDefault);
  const clear = usePreviewDefaultsStore((s) => s.clear);
  const options: SegmentedOption<ViewMode>[] = [
    { value: "raw", label: t("common:editor.view_raw") },
    { value: "preview", label: t("common:editor.view_preview") },
  ];
  return (
    <SettingsGroup
      title={t("editor.openIn.label")}
      description={t("editor.openIn.hint")}
      dirty={Object.keys(byFormat).length > 0}
      onReset={clear}
    >
      {PREVIEW_FORMATS.map((format) => (
        <SettingsRow
          key={format.engine}
          label={`${format.name} (${format.extensions.join(", ")})`}
          dirty={byFormat[format.engine] !== undefined}
          onReset={() => setDefault(format.engine, undefined)}
        >
          <SegmentedControl
            options={options}
            value={byFormat[format.engine] ?? builtInViewMode(format.engine)}
            onChange={(mode) => setDefault(format.engine, mode)}
            label={t("editor.openIn.aria", { format: format.name })}
          />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
