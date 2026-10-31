// src/renderer/components/settings/panels/editor-panel.tsx
//
// Controls:
//   - Font size: numeric input + ▲▼ stepper (12–32, step 1)
//   - Font family: token-sealed Select + custom-name input branch
//   - Font ligatures: Radix Checkbox + live mini-preview that toggles `liga`
//   - Line height: SegmentedControl (1.0 / 1.2 / 1.4), inline with its label
//   - Language servers: master switch, each language, how many workspaces run
//
// Design seal: semantic tokens only, no hex/oklch/rgba literals,
// no magic pixel values, no shadows.

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { type BuiltinLspPresetLanguageId, resolveLspPreset } from "../../../../shared/lsp/config";
import {
  LSP_MAX_ACTIVE_WORKSPACES_LIMIT,
  type LspLanguageSettings,
} from "../../../../shared/lsp/settings";
import { ipcCallResult } from "../../../ipc/client";
import { checkFontAvailable } from "../../../services/editor/runtime/font-availability";
import type { EditorFontLineHeight, EditorFontSize } from "../../../state/stores/editor-font";
import { useEditorFontStore } from "../../../state/stores/editor-font";
import { useLspSettingsStore } from "../../../state/stores/lsp-settings";
import { Checkbox } from "../../ui/checkbox";
import { NumberInput } from "../../ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { SettingsRow, SettingsSection } from "../section";
import type { SegmentedOption } from "../segmented-control";
import { SegmentedControl } from "../segmented-control";

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

// Sentinel for "use the platform fallback (no override)". Stored as the
// explicit "__system__" string in the Select UI because Radix Select reserves
// the empty string for "no value selected". Mapped back to undefined at the
// boundary.
const FAMILY_SYSTEM_VALUE = "__system__";

const PRESET_FONT_FAMILIES = [
  { value: "JetBrains Mono Nerd Font", label: "JetBrains Mono" },
  { value: "D2CodingLigature Nerd Font", label: "D2Coding" },
  { value: "Sarasa Term K", label: "Sarasa Term K" },
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

  // Build translated font family options inside the component so i18n is active.
  const fontFamilyOptions = useMemo(
    () => [
      ...PRESET_FONT_FAMILIES,
      { value: FAMILY_SYSTEM_VALUE, label: t("editor.fontFamilySystem") },
      { value: "__custom__", label: t("editor.fontFamilyOther") },
    ],
    [t],
  );

  const effectiveSize = size ?? DEFAULT_FONT_SIZE_TOKEN;
  // For preview we want the *literal* user choice to render. If family is
  // undefined ("System" in the select), fall back to plain ui-monospace so
  // the user sees the system mono font — picking JetBrains Mono Nerd Font as
  // the silent fallback made "System" and "JetBrains Mono" look identical.
  const previewFamilyStack = family && family !== "" ? family : "ui-monospace";
  const effectiveLineHeight = lineHeight ?? DEFAULT_LINE_HEIGHT_TOKEN;
  const effectiveLigatures = ligatures ?? false;

  // Determine whether the current family is a preset or custom.
  const isCustomFamily =
    family !== undefined &&
    family !== "" &&
    !fontFamilyOptions.some((f) => f.value === family && f.value !== "__custom__");
  const [familySelect, setFamilySelect] = useState<string>(
    isCustomFamily
      ? "__custom__"
      : family && family !== ""
        ? family
        : FAMILY_SYSTEM_VALUE,
  );
  const [customFamilyInput, setCustomFamilyInput] = useState<string>(
    isCustomFamily ? (family ?? "") : "",
  );

  // Font availability check for custom family. `null` = no check yet; `true` =
  // detected on the system; `false` = browser fell back (font not installed
  // or name typo). We show the result as a strongly-worded status line so
  // users don't mistake the silent fallback for a successful apply.
  const [fontAvailable, setFontAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (familySelect !== "__custom__") {
      setFontAvailable(null);
      return;
    }
    const trimmed = customFamilyInput.trim();
    if (!trimmed) {
      setFontAvailable(null);
      return;
    }
    setFontAvailable(checkFontAvailable(trimmed));
  }, [familySelect, customFamilyInput]);

  const handleFamilySelectChange = useCallback(
    (val: string) => {
      setFamilySelect(val);
      if (val !== "__custom__") {
        setFamily(val === FAMILY_SYSTEM_VALUE ? undefined : val);
        setCustomFamilyInput("");
        setFontAvailable(null);
      }
    },
    [setFamily],
  );

  const handleCustomFamilyChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setCustomFamilyInput(val);
      setFamily(val.trim() === "" ? undefined : val.trim());
    },
    [setFamily],
  );

  const customFamilyId = useId();
  const ligaturesId = useId();

  // Reset helpers — clearing each field returns it to undefined (token fallback).
  const resetFamily = () => {
    setFamily(undefined);
    setFamilySelect(FAMILY_SYSTEM_VALUE);
    setCustomFamilyInput("");
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Persistent preview — reflects every editor setting in real time so
          the user can judge their choices before closing the dialog. */}
      <EditorPreview
        label={t("editor.preview")}
        fontFamily={previewFamilyStack}
        fontSize={effectiveSize}
        lineHeight={effectiveLineHeight}
        ligatures={effectiveLigatures}
      />

      {/* Font size — compact stepper on the right of its label */}
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

      {/* Line height — also compact on the right */}
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

      {/* Font family — full-width Select */}
      <SettingsSection
        label={t("editor.fontFamily")}
        dirty={family !== undefined}
        onReset={resetFamily}
      >
        <Select value={familySelect} onValueChange={handleFamilySelectChange}>
          <SelectTrigger ariaLabel={t("editor.ariaFontFamily")}>
            <SelectValue placeholder={t("editor.fontFamilyPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {fontFamilyOptions.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {familySelect === "__custom__" && (
          <div className="flex flex-col gap-1 mt-1">
            <input
              id={customFamilyId}
              type="text"
              value={customFamilyInput}
              onChange={handleCustomFamilyChange}
              placeholder={t("editor.customFamilyPlaceholder")}
              className={cn(
                "w-full rounded-(--radius-control) border border-border bg-background px-2 py-1",
                "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
                "focus-visible:ring-1 focus-visible:ring-ring",
              )}
            />
            {fontAvailable === true && (
              <span className="text-app-ui-sm text-muted-foreground">
                {t("editor.fontDetected")}
              </span>
            )}
            {fontAvailable === false && (
              <span className="text-app-ui-sm text-[var(--state-warning-fg)]">
                {t("editor.fontNotFound")}
              </span>
            )}
          </div>
        )}
      </SettingsSection>

      {/* Ligatures — Checkbox + explanation + live preview */}
      <SettingsSection
        label={t("editor.fontLigatures")}
        dirty={ligatures !== undefined}
        onReset={() => setLigatures(undefined)}
      >
        <label htmlFor={ligaturesId} className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            id={ligaturesId}
            checked={effectiveLigatures}
            onCheckedChange={(v) => setLigatures(v === true)}
          />
          <span className="text-app-body text-foreground">{t("editor.ligatures.enable")}</span>
        </label>
        <p className="text-app-ui-sm text-muted-foreground">
          {t("editor.ligatures.description")}
        </p>
      </SettingsSection>

      <LanguageServersSection />
    </div>
  );
}

/** The languages listed under Language servers, in order. */
const LSP_LANGUAGE_ROWS: readonly BuiltinLspPresetLanguageId[] = [
  "typescript",
  "python",
  "yaml",
  "shell",
  "dockerfile",
  "go",
  "rust",
];

/**
 * The LSP settings. Main applies each change at once — stopping, starting or
 * restarting the servers it affects — and broadcasts the result, which the
 * store mirrors.
 */
function LanguageServersSection() {
  const { t } = useTranslation("settings");
  const id = useId();
  const settings = useLspSettingsStore((s) => s.settings);

  return (
    <SettingsSection label={t("editor.lsp.label")}>
      <label htmlFor={id} className="flex items-center gap-2 cursor-pointer">
        <Checkbox
          id={id}
          checked={settings.enabled}
          onCheckedChange={(v) => void ipcCallResult("lsp", "setEnabled", { enabled: v === true })}
        />
        <span className="text-app-body text-foreground">{t("editor.lsp.enable")}</span>
      </label>
      <p className="text-app-ui-sm text-muted-foreground">{t("editor.lsp.description")}</p>
      {settings.enabled && (
        <div className="flex flex-col gap-3 pl-6">
          {LSP_LANGUAGE_ROWS.map((languageId) => (
            <LanguageServerRow
              key={languageId}
              languageId={languageId}
              settings={settings.languages[languageId] ?? {}}
            />
          ))}
          <div className="flex flex-col gap-1">
            <SettingsRow label={t("editor.lsp.maxWorkspaces")}>
              <NumberInput
                value={settings.maxActiveWorkspaces}
                onChange={(count) =>
                  void ipcCallResult("lsp", "setMaxActiveWorkspaces", { count })
                }
                min={1}
                max={LSP_MAX_ACTIVE_WORKSPACES_LIMIT}
                ariaLabel={t("editor.lsp.maxWorkspaces")}
              />
            </SettingsRow>
            <p className="text-app-ui-sm text-muted-foreground">
              {t("editor.lsp.maxWorkspacesDescription")}
            </p>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

function LanguageServerRow({
  languageId,
  settings,
}: {
  languageId: BuiltinLspPresetLanguageId;
  settings: LspLanguageSettings;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const lowMemoryId = useId();
  const preset = resolveLspPreset(languageId);
  // A server the user installs runs only once turned on.
  const on = preset?.system ? settings.enabled === true : settings.enabled !== false;

  function change(next: LspLanguageSettings): void {
    void ipcCallResult("lsp", "setLanguageSettings", { languageId, settings: next });
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="flex items-center gap-2 cursor-pointer">
        <Checkbox id={id} checked={on} onCheckedChange={(v) => change({ enabled: v === true })} />
        <span className="text-app-body text-foreground">
          {t(`editor.lsp.language.${languageId}`)}
        </span>
      </label>
      {languageId === "typescript" && on && (
        <div className="flex flex-col gap-1 pl-6">
          <label htmlFor={lowMemoryId} className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              id={lowMemoryId}
              checked={settings.lowMemory === true}
              onCheckedChange={(v) => change({ lowMemory: v === true })}
            />
            <span className="text-app-body text-foreground">{t("editor.lsp.lowMemory")}</span>
          </label>
          <p className="text-app-ui-sm text-muted-foreground">
            {t("editor.lsp.lowMemoryDescription")}
          </p>
        </div>
      )}
      {languageId === "shell" && on && (
        <p className="pl-6 text-app-ui-sm text-muted-foreground">
          {t("editor.lsp.shellDescription")}
        </p>
      )}
      {preset?.system && on && (
        <ServerPathField
          languageId={languageId}
          install={preset.install}
          path={settings.path ?? ""}
          onCommit={(path) => change({ path })}
        />
      )}
    </div>
  );
}

/**
 * Where a server the user installed is. Saved on Enter or leaving the field,
 * not per keystroke: each change restarts the language's servers.
 */
function ServerPathField({
  languageId,
  install,
  path,
  onCommit,
}: {
  languageId: BuiltinLspPresetLanguageId;
  install: string | undefined;
  path: string;
  onCommit: (path: string) => void;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const [draft, setDraft] = useState(path);

  useEffect(() => setDraft(path), [path]);

  function commit(): void {
    if (draft.trim() !== path.trim()) onCommit(draft.trim());
  }

  return (
    <div className="flex flex-col gap-1 pl-6">
      <label htmlFor={id} className="text-app-ui-sm text-muted-foreground">
        {t("editor.lsp.serverPath")}
      </label>
      <input
        id={id}
        type="text"
        value={draft}
        maxLength={4096}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        placeholder={t(`editor.lsp.serverPathPlaceholder.${languageId}`)}
        className={cn(
          "w-full rounded-(--radius-control) border border-border bg-background px-2 py-1",
          "font-mono text-app-body text-foreground outline-none placeholder:text-muted-foreground",
          "placeholder:font-sans focus-visible:ring-1 focus-visible:ring-ring",
        )}
      />
      <p className="text-app-ui-sm text-muted-foreground">
        {t("editor.lsp.serverPathDescription")}
      </p>
      {install && (
        <p className="text-app-ui-sm text-muted-foreground">
          {t("editor.lsp.install")} <code className="font-mono select-text">{install}</code>
        </p>
      )}
    </div>
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
  label,
  fontFamily,
  fontSize,
  lineHeight,
  ligatures,
}: {
  label: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  ligatures: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-app-ui-sm text-muted-foreground">{label}</span>
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
    </div>
  );
}
