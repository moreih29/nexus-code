// src/renderer/components/settings/panels/editor-panel.tsx
//
// Two groups. The font: a live preview, then family (FontFamilyRow), size
// (12–32 stepper), line height (1.0 / 1.2 / 1.4) and ligatures. Then the view
// each format with a preview opens in (PreviewDefaultsSection).
//
// Design seal: semantic tokens only, no hex/oklch/rgba literals,
// no magic pixel values, no shadows.

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FONT_SIZE_MIN: EditorFontSize = 8;
const FONT_SIZE_MAX: EditorFontSize = 32;

const LINE_HEIGHT_OPTIONS: SegmentedOption<string>[] = [
  { value: "1", label: "1.0" },
  { value: "1.2", label: "1.2" },
  { value: "1.4", label: "1.4" },
];

const DEFAULT_FONT_SIZE_TOKEN = 16; // codeBody fallback
const DEFAULT_LINE_HEIGHT_TOKEN: EditorFontLineHeight = 1.4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lineHeightToValue(lh: EditorFontLineHeight | undefined): string {
  if (lh === undefined) return String(DEFAULT_LINE_HEIGHT_TOKEN);
  return String(lh);
}

function valueToLineHeight(v: string): EditorFontLineHeight {
  const n = parseFloat(v);
  const valid: EditorFontLineHeight[] = [1.0, 1.2, 1.4];
  return (valid as number[]).includes(n) ? (n as EditorFontLineHeight) : DEFAULT_LINE_HEIGHT_TOKEN;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  // For preview we want the *literal* user choice to render. If family is
  // undefined ("System" in the select), fall back to plain ui-monospace so
  // the user sees the system mono font — picking JetBrains Mono Nerd Font as
  // the silent fallback made "System" and "JetBrains Mono" look identical.
  const previewFamilyStack = family && family !== "" ? family : "ui-monospace";
  const effectiveLineHeight = lineHeight ?? DEFAULT_LINE_HEIGHT_TOKEN;
  const effectiveLigatures = ligatures ?? false;

  return (
    <SettingsPage>
      <SettingsGroup title={t("editor.font")}>
        {/* Persistent preview — reflects every editor setting in real time so
            the user can judge their choices before closing the dialog. */}
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

      {/* The view each format with a preview opens in */}
      <PreviewDefaultsSection />
    </SettingsPage>
  );
}

// ---------------------------------------------------------------------------
// Live editor preview
// ---------------------------------------------------------------------------

/**
 * Persistent snippet at the top of the Editor panel. Mirrors every setting
 * (family, size, line-height, ligatures) so the user can judge their picks
 * without leaving the dialog. Intentionally not a Monaco instance — pure HTML
 * styled to match keeps the dialog lightweight and avoids loading another
 * editor worker just for ~5 lines of preview text.
 */
// Snippet kept short so it fits the preview at the maximum font size (32px).
// Lines deliberately don't exceed ~28 chars so even at the high end the
// preview doesn't need horizontal scroll.
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
        // Clip overflow at the largest font sizes — the snippet is sized so
        // it fits at 32px, but exotic fonts may render slightly wider.
        // `text-wrap` instead of `whitespace-pre` lets long lines fold
        // gracefully if anything does overflow, without the horizontal
        // scrollbar leaking into the dialog.
        "overflow-hidden",
      )}
      style={{
        // `<pre>` carries a user-agent `font-family: monospace` rule that
        // overrides any inline fontFamily inherited from a parent — so the
        // preview used to look identical regardless of the family/ligature
        // pick. We render the snippet on a plain <div> with white-space:pre
        // instead; family + feature-settings now flow through. Quoting the
        // first family token guards multi-word custom names like
        // "Fira Code" / "D2 Coding" against the legacy unquoted parsing
        // that splits on whitespace.
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
