// src/renderer/components/settings/panels/appearance-panel.tsx
//
// Three groups: language and icon theme; the theme, a card each; the window
// (opacity, inactive panel dimming), a slider each.
//
// Language picker: endonym labels (English / 한국어), live via
// useLanguageStore.setPreference. Reset omitted — language has no meaningful
// "default" (it follows OS locale on first boot, but the user's explicit pick
// is the new baseline). Matching the reset pattern with an arbitrary fallback
// to "en" would be a false affordance.
//
// Icon theme picker: "minimal" | "material". Option display names are proper
// nouns and are not translated. Default is "minimal"; reset restores that.
//
// Theme picker: each ThemeSource produces one card showing the theme's
// dominant colors (surfaces, accent, five syntax roles) and a few words on
// it, so users select by visual identity, not just by name. Selection commits
// immediately — the resolved theme is applied via the [data-theme] attribute
// by useThemeEffect.
//
// Window opacity applies immediately via --window-opacity CSS var; the macOS
// BrowserWindow is created with `transparent: true` unconditionally, and the
// Windows 11 one with a system backdrop, so no restart is needed there. A Linux
// window opens transparent only while the saved opacity is under 100%, so
// lowering it there shows through after a restart; the row says so.
// Windows before 11 22H2 has no backdrop, so nothing shows through its
// window: the slider is off there and the row says why.
//
// Design seal: semantic tokens only on the chrome surrounding the cards.
// The card swatches intentionally use raw theme colors (the swatches ARE the
// theme preview — that's the whole point of this picker).

import { RadioGroup, Slider } from "radix-ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_THEME,
  THEME_SOURCES,
  type ThemeId,
  type ThemeSource,
} from "../../../../shared/design-tokens";
import type { SupportedLanguage } from "../../../../shared/i18n";
import { cn } from "@/utils/cn";
import { type IconTheme, useIconThemeStore } from "../../../state/stores/icon-theme";
import { useLanguageStore } from "../../../state/stores/language";
import {
  INACTIVE_PANEL_DIM_DEFAULT,
  INACTIVE_PANEL_DIM_MAX,
  INACTIVE_PANEL_DIM_MIN,
  useInactivePanelDimStore,
} from "../../../state/stores/inactive-panel-dim";
import { useThemeStore } from "../../../state/stores/theme";
import { useWindowOpacityStore } from "../../../state/stores/window-opacity";
import { SettingsGroup, SettingsPage, SettingsRow } from "../section";
import type { SegmentedOption } from "../segmented-control";
import { SegmentedControl } from "../segmented-control";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPACITY_MIN = 0;
const OPACITY_MAX = 1.0;
const OPACITY_STEP = 0.05;

// Inactive-panel dim — multiplier on each theme's tuned veil alpha. 1 (100%) =
// theme default, 0 = no dim, 2 (200%) = double. Slider steps in 5% increments.
const DIM_STEP = 0.05;

// Language options — endonym labels, fixed regardless of the active UI locale.
// Rule: label is the language's own native name; never translated. A
// SegmentedControl while there are few; past four, a Select would fit better.

const LANGUAGE_OPTIONS: SegmentedOption<SupportedLanguage>[] = [
  { value: "en", label: "English" },
  { value: "ko", label: "한국어" },
];

// Icon theme options — "Minimal" and "Material" are proper nouns and are NOT
// translated; only the section label is localised. Exactly 2 options →
// always SegmentedControl.
const DEFAULT_ICON_THEME: IconTheme = "minimal";

const ICON_THEME_OPTIONS: SegmentedOption<IconTheme>[] = [
  { value: "minimal", label: "Minimal" },
  { value: "material", label: "Material" },
];

/**
 * Whether a lowered window opacity shows through only after a restart: in a
 * Linux window not created transparent (main/features/window).
 */
export function opacityAppliesAfterRestart(
  host: Window["host"] | undefined,
  opacity: number,
): boolean {
  return host?.platform === "linux" && host.transparentWindow !== true && opacity < 1;
}

/**
 * Whether the window opacity has no effect: in a Windows window without a
 * system backdrop (main/features/window).
 */
export function opacityHasNoEffect(host: Window["host"] | undefined): boolean {
  return host?.opaqueWindow === true;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AppearancePanel() {
  const { t } = useTranslation("settings");

  const languagePreference = useLanguageStore((s) => s.preference);
  const setLanguagePreference = useLanguageStore((s) => s.setPreference);

  const iconThemePreference = useIconThemeStore((s) => s.preference);
  const setIconThemePreference = useIconThemeStore((s) => s.setPreference);

  const themePreference = useThemeStore((s) => s.preference);
  const setThemePreference = useThemeStore((s) => s.setPreference);

  const opacity = useWindowOpacityStore((s) => s.opacity);
  const setOpacity = useWindowOpacityStore((s) => s.setOpacity);

  const dim = useInactivePanelDimStore((s) => s.dim);
  const setDim = useInactivePanelDimStore((s) => s.setDim);

  // Local preview — updated on every drag tick for real-time value label.
  const [localOpacity, setLocalOpacity] = useState<number>(opacity);
  const [localDim, setLocalDim] = useState<number>(dim);

  // Keep local preview in sync when the store changes outside this component
  // (e.g. hydration, external restore, dialog re-open with fresh store value).
  useEffect(() => {
    setLocalOpacity(opacity);
  }, [opacity]);
  useEffect(() => {
    setLocalDim(dim);
  }, [dim]);

  const iconThemeDirty = iconThemePreference !== DEFAULT_ICON_THEME;
  const themeDirty = themePreference !== DEFAULT_THEME;
  const opacityDirty = opacity !== 1;
  const opacityNeedsRestart = opacityAppliesAfterRestart(window.host, localOpacity);
  const opacityUnsupported = opacityHasNoEffect(window.host);
  const dimDirty = dim !== INACTIVE_PANEL_DIM_DEFAULT;

  const languageLabel = t("appearance.language");

  return (
    <SettingsPage>
      <SettingsGroup>
        {/* Language — endonym labels, never translated. No reset: the boot
            value follows navigator.language, an OS approximation rather than
            a product default, so a reset falling back to "en" would be a
            false affordance (plan#65 issue8). */}
        <SettingsRow label={languageLabel}>
          <SegmentedControl
            options={LANGUAGE_OPTIONS}
            value={languagePreference}
            onChange={(lang) => setLanguagePreference(lang)}
            label={languageLabel}
          />
        </SettingsRow>

        {/* Icon theme — "Minimal" and "Material" are proper nouns and are
            not translated; only the label and reset tooltip are localised. */}
        <SettingsRow
          label={t("appearance.iconTheme")}
          dirty={iconThemeDirty}
          onReset={() => setIconThemePreference(DEFAULT_ICON_THEME)}
        >
          <SegmentedControl
            options={ICON_THEME_OPTIONS}
            value={iconThemePreference}
            onChange={(theme) => setIconThemePreference(theme)}
            label={t("appearance.iconTheme")}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title={t("appearance.theme")}
        dirty={themeDirty}
        onReset={() => setThemePreference(DEFAULT_THEME)}
      >
        <RadioGroup.Root
          aria-label={t("appearance.theme")}
          value={themePreference}
          onValueChange={(value: string) => setThemePreference(value as ThemeId)}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {THEME_SOURCES.map((source) => (
            <ThemeCard
              key={source.id}
              source={source}
              selected={themePreference === source.id}
            />
          ))}
        </RadioGroup.Root>
      </SettingsGroup>

      <SettingsGroup title={t("appearance.window")}>
        <SettingsRow
          label={t("appearance.windowOpacity")}
          description={
            opacityUnsupported
              ? t("appearance.windowOpacityUnsupported")
              : opacityNeedsRestart
                ? t("appearance.windowOpacityRestart")
                : undefined
          }
          dirty={opacityDirty}
          onReset={() => setOpacity(1)}
        >
          <PercentSlider
            label={t("appearance.windowOpacity")}
            min={OPACITY_MIN}
            max={OPACITY_MAX}
            step={OPACITY_STEP}
            value={localOpacity}
            disabled={opacityUnsupported}
            onPreview={(value) => {
              setLocalOpacity(value);
              // Preview live; each persisted write rewrites the whole app
              // state file on the main process, so save once on commit.
              setOpacity(value, { persist: false });
            }}
            onCommit={(value) => setOpacity(value)}
          />
        </SettingsRow>

        {/* Inactive panel dimming — multiplier on the theme's veil alpha.
            100% = theme default, 0% = no dim, up to 200% = double. Applies
            immediately via --inactive-panel-dim CSS var (no restart). */}
        <SettingsRow
          label={t("appearance.inactivePanelDim")}
          dirty={dimDirty}
          onReset={() => setDim(INACTIVE_PANEL_DIM_DEFAULT)}
        >
          <PercentSlider
            label={t("appearance.inactivePanelDim")}
            min={INACTIVE_PANEL_DIM_MIN}
            max={INACTIVE_PANEL_DIM_MAX}
            step={DIM_STEP}
            value={localDim}
            onPreview={(value) => {
              setLocalDim(value);
              setDim(value, { persist: false });
            }}
            onCommit={(value) => setDim(value)}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}

// ---------------------------------------------------------------------------
// PercentSlider — a slider with its value in percent beside it
// ---------------------------------------------------------------------------

interface PercentSliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  /** Every drag tick: shown at once, not saved. */
  onPreview: (value: number) => void;
  /** Where the drag ends: saved. */
  onCommit: (value: number) => void;
}

function PercentSlider({
  label,
  min,
  max,
  step,
  value,
  disabled,
  onPreview,
  onCommit,
}: PercentSliderProps) {
  return (
    <div className="flex w-56 items-center gap-3">
      <Slider.Root
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(vals) => {
          if (vals[0] !== undefined) onPreview(vals[0]);
        }}
        onValueCommit={(vals) => {
          if (vals[0] !== undefined) onCommit(vals[0]);
        }}
        disabled={disabled}
        aria-label={label}
        className="relative flex flex-1 touch-none select-none items-center data-[disabled]:opacity-50"
      >
        <Slider.Track className="relative h-1 w-full grow rounded-(--radius-control) bg-muted border border-border">
          <Slider.Range className="absolute h-full rounded-(--radius-control) bg-[var(--state-selected-bg)]" />
        </Slider.Track>
        <Slider.Thumb
          className={cn(
            "block size-4 rounded-full border border-[var(--state-selected-bg)] bg-[var(--state-selected-bg)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "transition-colors",
          )}
        />
      </Slider.Root>
      <span className="w-10 text-right text-app-ui-sm text-muted-foreground tabular-nums">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ThemeCard — visual preview + name. Click anywhere on the card to select.
//
// The card itself paints with the theme's own surface colors so each card is
// a faithful preview of "what the app will look like if I pick this": its
// chrome and syntax colours in one row of swatches, and a few words on it.
// ---------------------------------------------------------------------------

interface ThemeCardProps {
  source: ThemeSource;
  selected: boolean;
}

function ThemeCard({ source, selected }: ThemeCardProps) {
  const { t } = useTranslation("settings");
  // Surface chrome first, then the syntax accents.
  const swatches: { value: string; label: string }[] = [
    { value: source.bg.primary, label: "bg" },
    { value: source.bg.secondary, label: "panel" },
    { value: source.bg.floating, label: "float" },
    { value: source.fg.muted, label: "muted" },
    { value: source.accent, label: "accent" },
    { value: source.syntax.keyword, label: "keyword" },
    { value: source.syntax.string, label: "string" },
    { value: source.syntax.number, label: "number" },
    { value: source.syntax.function, label: "function" },
    { value: source.syntax.type, label: "type" },
  ];

  return (
    <RadioGroup.Item
      value={source.id}
      className={cn(
        "group relative flex flex-col overflow-hidden",
        "rounded-(--radius-raised) border text-left",
        "transition-[border-color,box-shadow]",
        selected
          ? "border-[var(--state-selected-indicator)] ring-1 ring-[var(--state-selected-indicator)]"
          : "border-border hover:border-[var(--surface-floating-border)]",
      )}
      // The card paints with the theme's own surface so it previews itself.
      style={{ background: source.bg.primary, color: source.fg.primary }}
    >
      {/* Header — name, base tag */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-2"
        style={{ background: source.bg.secondary, color: source.fg.primary }}
      >
        <span className="text-app-body-emphasis truncate" style={{ color: source.fg.primary }}>
          {source.name}
        </span>
        <span
          className="shrink-0 rounded-(--radius-control) px-1.5 py-0.5 text-app-micro"
          style={{
            background: source.bg.floating,
            color: source.fg.muted,
            border: `1px solid ${source.border}`,
          }}
        >
          {t(`appearance.themeBase.${source.base}`)}
        </span>
      </div>

      <div className="flex gap-1 px-3 pt-2">
        {swatches.map((s) => (
          <Swatch key={s.label} value={s.value} title={`${s.label}: ${s.value}`} />
        ))}
      </div>

      <div
        className="truncate px-3 pt-1.5 pb-2.5 text-app-micro"
        style={{ color: source.fg.muted }}
      >
        {t(`appearance.themeDescription.${source.id}`)}
      </div>
    </RadioGroup.Item>
  );
}

function Swatch({ value, title }: { value: string; title: string }) {
  return (
    <span
      title={title}
      aria-hidden
      className="block h-3 flex-1 rounded-[3px] border border-black/10 dark:border-white/10"
      style={{ background: value }}
    />
  );
}
