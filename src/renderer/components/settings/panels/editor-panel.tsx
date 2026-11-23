import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { EditorFontLineHeight, EditorFontSize } from "../../../state/stores/editor-font";
import { useEditorFontStore } from "../../../state/stores/editor-font";
import { NumberInput } from "../../ui/number-input";
import { FontFamilyRow } from "../font-family-row";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSwitch } from "../section";
import type { SegmentedOption } from "../segmented-control";
import { SegmentedControl } from "../segmented-control";
import { PreviewDefaultsSection } from "./preview-defaults-section";

const FONT_SIZE_MIN: EditorFontSize = 8;
const FONT_SIZE_MAX: EditorFontSize = 32;

const LINE_HEIGHT_OPTIONS: SegmentedOption<string>[] = [
  { value: "1", label: "1.0" },
  { value: "1.2", label: "1.2" },
  { value: "1.4", label: "1.4" },
];

const DEFAULT_FONT_SIZE_TOKEN = 16;
const DEFAULT_LINE_HEIGHT_TOKEN: EditorFontLineHeight = 1.4;

function lineHeightToValue(lh: EditorFontLineHeight | undefined): string {
  if (lh === undefined) return String(DEFAULT_LINE_HEIGHT_TOKEN);
  return String(lh);
}

function valueToLineHeight(v: string): EditorFontLineHeight {
  const n = parseFloat(v);
  const valid: EditorFontLineHeight[] = [1.0, 1.2, 1.4];
  return (valid as number[]).includes(n) ? (n as EditorFontLineHeight) : DEFAULT_LINE_HEIGHT_TOKEN;
}

export function EditorPanel() {
  const { t } = useTranslation("settings");

  const size = useEditorFontStore((s) => s.size);
  const family = useEditorFontStore((s) => s.family);
  const ligatures = useEditorFontStore((s) => s.ligatures);
  const lineHeight = useEditorFontStore((s) => s.lineHeight);
  const setSize = useEditorFontStore((s) => s.setSize);
  const setFamily = useEditorFontStore((s) => s.setFamily);
  const setLigatures = useEditorFontStore((s) => s.setLigatures);
  const setLineHeight = useEditorFontStore((s) => s.setLineHeight);

  const effectiveSize = size ?? DEFAULT_FONT_SIZE_TOKEN;
  const previewFamilyStack = family && family !== "" ? family : "ui-monospace";
  const effectiveLineHeight = lineHeight ?? DEFAULT_LINE_HEIGHT_TOKEN;
  const effectiveLigatures = ligatures ?? false;

  return (
    <SettingsPage>
      <SettingsGroup title={t("editor.font")}>
        <EditorPreview
          fontFamily={previewFamilyStack}
          fontSize={effectiveSize}
          lineHeight={effectiveLineHeight}
          ligatures={effectiveLigatures}
        />

        <FontFamilyRow scope="editor" family={family} setFamily={setFamily} />

        <SettingsRow
          label={t("editor.fontSize")}
          dirty={size !== undefined}
          onReset={() => setSize(undefined)}
        >
          <NumberInput
            value={effectiveSize}
            onChange={(n) => setSize(n as EditorFontSize)}
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            suffix="px"
            ariaLabel={t("editor.ariaFontSize")}
          />
        </SettingsRow>

        <SettingsRow
          label={t("editor.lineHeight")}
          dirty={lineHeight !== undefined}
          onReset={() => setLineHeight(undefined)}
        >
          <SegmentedControl
            options={LINE_HEIGHT_OPTIONS}
            value={lineHeightToValue(lineHeight)}
            onChange={(v) => setLineHeight(valueToLineHeight(v))}
            label={t("editor.lineHeight")}
          />
        </SettingsRow>

        <SettingsSwitch
          label={t("editor.fontLigatures")}
          description={t("editor.ligatures.description")}
          checked={effectiveLigatures}
          onChange={setLigatures}
          dirty={ligatures !== undefined}
          onReset={() => setLigatures(undefined)}
        />
      </SettingsGroup>

      <PreviewDefaultsSection />
    </SettingsPage>
  );
}

const PREVIEW_CODE = `const fn = (x) => x !== 0;
// => != >= <= !== ==>
return \`Hi, \${name}!\`;`;

function EditorPreview({
  fontFamily,
  fontSize,
  lineHeight,
  ligatures,
}: {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  ligatures: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-(--radius-control) border border-border bg-background px-3 py-2 text-foreground",
        "overflow-hidden",
      )}
      style={{
        fontFamily: `"${fontFamily}", ui-monospace, monospace`,
        fontSize,
        lineHeight,
        fontFeatureSettings: ligatures ? '"liga", "calt"' : '"liga" 0, "calt" 0',
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {PREVIEW_CODE}
    </div>
  );
}
