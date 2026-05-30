// src/renderer/components/settings/panels/appearance-panel.tsx
//
// Controls: Language (SegmentedControl) + Icon Theme (SegmentedControl) +
// Theme (grid of visual theme cards) + Window Opacity (slider 0–100%).
//
// Language picker: endonym labels (English / 한국어), live via
// useLanguageStore.setPreference. Options threshold: ≤4 → SegmentedControl,
// >4 → token-sealed Select (future-proof branch). Reset omitted — language
// has no meaningful "default" (it follows OS locale on first boot, but the
// user's explicit pick is the new baseline). Matching the reset pattern with
// an arbitrary fallback to "en" would be a false affordance.
//
// Icon theme picker: "minimal" | "material" — exactly 2 options → SegmentedControl.
// Option display names ("Minimal"/"Material") are proper nouns and are not
// translated; only the section label and reset tooltip are localised.
// Default is "minimal"; reset restores that value.
//
// Theme picker: each ThemeSource produces one card showing the theme's
// dominant colors (bg + fg + accent + four syntax roles) so users select by
// visual identity, not just by name. Selection commits immediately — the
// resolved theme is applied via the [data-theme] attribute by useThemeEffect.
//
// Window opacity applies immediately via --window-opacity CSS var; the macOS
// BrowserWindow is created with `transparent: true` unconditionally so no
// restart is ever needed.
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
import { useThemeStore } from "../../../state/stores/theme";
import { useWindowOpacityStore } from "../../../state/stores/window-opacity";
import { SettingsSection } from "../section";
import type { SegmentedOption } from "../segmented-control";
import { SegmentedControl } from "../segmented-control";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPACITY_MIN = 0;
const OPACITY_MAX = 1.0;
const OPACITY_STEP = 0.05;

// Language options — endonym labels, fixed regardless of the active UI locale.
// Rule: label is the language's own native name; never translated.
// Threshold: ≤4 options → SegmentedControl, >4 → token-sealed Select.
const LANGUAGE_SEGMENT_THRESHOLD = 4;

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

  // Local preview — updated on every drag tick for real-time value label.
  const [localOpacity, setLocalOpacity] = useState<number>(opacity);

  // Keep local preview in sync when the store changes outside this component
  // (e.g. hydration, external restore, dialog re-open with fresh store value).
  useEffect(() => {
    setLocalOpacity(opacity);
  }, [opacity]);

  const opacityPercent = Math.round(localOpacity * 100);

  const iconThemeDirty = iconThemePreference !== DEFAULT_ICON_THEME;
  const themeDirty = themePreference !== DEFAULT_THEME;
  const opacityDirty = opacity !== 1;

  const languageLabel = t("appearance.language");

  return (
    <div className="flex flex-col gap-6">
      {/* Section: Language — SegmentedControl (endonym labels, never translated).
          Reset omitted: language has no well-defined "default" — the boot value
          follows navigator.language, which is an OS approximation, not a stable
          product default. Providing a reset button that silently falls back to
          "en" would be a false affordance and potentially worse UX than doing
          nothing. Design constraint documented in plan#65 issue8. */}
      <SettingsSection label={languageLabel}>
        {LANGUAGE_OPTIONS.length <= LANGUAGE_SEGMENT_THRESHOLD ? (
          <SegmentedControl
            options={LANGUAGE_OPTIONS}
            value={languagePreference}
            onChange={(lang) => setLanguagePreference(lang)}
            label={languageLabel}
          />
        ) : (
          // Threshold guard: >4 languages → token-sealed Select would go here.
          // Not yet reached — placeholder for future expansion.
          <SegmentedControl
            options={LANGUAGE_OPTIONS}
            value={languagePreference}
            onChange={(lang) => setLanguagePreference(lang)}
            label={languageLabel}
          />
        )}
      </SettingsSection>

      {/* Section: Icon Theme — SegmentedControl (Minimal / Material).
          "Minimal" and "Material" are proper nouns and are not translated;
          only the section label and reset tooltip are localised. Default
          is "minimal". */}
      <SettingsSection
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
      </SettingsSection>

      {/* Section: Theme — grid of visual cards */}
      <SettingsSection
        label={t("appearance.theme")}
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
      </SettingsSection>

      {/* Section: Window Opacity */}
      <SettingsSection
        label={t("appearance.windowOpacity")}
        dirty={opacityDirty}
        onReset={() => setOpacity(1)}
      >
        <div className="flex items-center gap-3">
          <Slider.Root
            min={OPACITY_MIN}
            max={OPACITY_MAX}
            step={OPACITY_STEP}
            value={[localOpacity]}
            onValueChange={(vals) => {
              if (vals[0] !== undefined) {
                setLocalOpacity(vals[0]);
                setOpacity(vals[0]);
              }
            }}
            aria-label={t("appearance.windowOpacity")}
            className="relative flex flex-1 touch-none select-none items-center"
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
            {opacityPercent}%
          </span>
        </div>
      </SettingsSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ThemeCard — visual preview + name. Click anywhere on the card to select.
//
// The card itself paints with the theme's own surface colors so each card is
// a faithful preview of "what the app will look like if I pick this".
// ---------------------------------------------------------------------------

interface ThemeCardProps {
  source: ThemeSource;
  selected: boolean;
}

function ThemeCard({ source, selected }: ThemeCardProps) {
  // Two rows of swatches paint the theme's own colours:
  //   row 1 — surface chrome:  bg.primary, bg.secondary, bg.floating, fg.muted, accent
  //   row 2 — syntax accents:  keyword, string, number, function, type
  const surfaceSwatches: { value: string; label: string }[] = [
    { value: source.bg.primary, label: "bg" },
    { value: source.bg.secondary, label: "panel" },
    { value: source.bg.floating, label: "float" },
    { value: source.fg.muted, label: "muted" },
    { value: source.accent, label: "accent" },
  ];
  const syntaxSwatches: { value: string; label: string }[] = [
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
          className="shrink-0 rounded-(--radius-control) px-1.5 py-0.5 text-app-micro uppercase tracking-[1px]"
          style={{
            background: source.bg.floating,
            color: source.fg.muted,
            border: `1px solid ${source.border}`,
          }}
        >
          {source.base}
        </span>
      </div>

      {/* Surface swatch row */}
      <div className="flex gap-1 px-3 pt-2">
        {surfaceSwatches.map((s) => (
          <Swatch key={s.label} value={s.value} title={`${s.label}: ${s.value}`} large />
        ))}
      </div>

      {/* Syntax swatch row */}
      <div className="flex gap-1 px-3 pt-1.5">
        {syntaxSwatches.map((s) => (
          <Swatch key={s.label} value={s.value} title={`${s.label}: ${s.value}`} large />
        ))}
      </div>

      {/* Tiny code preview — three lines, hand-coloured so each card actually
          shows keyword / string / function / comment hues in context. */}
      <div
        className="mt-2 px-3 pb-2.5 font-mono text-app-micro leading-tight"
        style={{ color: source.fg.primary }}
      >
        <div>
          <span style={{ color: source.syntax.comment, fontStyle: "italic" }}>
            {"// "}{source.description}
          </span>
        </div>
        <div className="truncate">
          <span style={{ color: source.syntax.keyword }}>const</span>{" "}
          <span style={{ color: source.syntax.variable }}>theme</span>{" "}
          <span style={{ color: source.syntax.operator }}>=</span>{" "}
          <span style={{ color: source.syntax.function }}>load</span>
          <span style={{ color: source.syntax.operator }}>(</span>
          <span style={{ color: source.syntax.string }}>{`"${source.id}"`}</span>
          <span style={{ color: source.syntax.operator }}>);</span>
        </div>
      </div>
    </RadioGroup.Item>
  );
}

interface SwatchProps {
  value: string;
  title: string;
  large?: boolean;
}

function Swatch({ value, title, large }: SwatchProps) {
  return (
    <span
      title={title}
      aria-hidden
      className={cn(
        "block rounded-[3px] border border-black/10 dark:border-white/10",
        large ? "h-4 flex-1" : "size-3",
      )}
      style={{ background: value }}
    />
  );
}
