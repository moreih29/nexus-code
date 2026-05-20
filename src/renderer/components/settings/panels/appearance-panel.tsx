// src/renderer/components/settings/panels/appearance-panel.tsx
//
// Controls: Theme (segmented 4) + Window Opacity (slider 0–100% step 5).
//
// Window opacity applies immediately via --window-opacity CSS var; the macOS
// BrowserWindow is created with `transparent: true` unconditionally so no
// restart is ever needed. (Density was removed — the v2 cycle's button-height
// adjustments never landed, so the toggle produced no perceptible change.)
//
// Design seal: semantic tokens only, no hex/oklch/rgba literals,
// no magic pixel values, no shadows.

import { Slider } from "radix-ui";
import { useEffect, useState } from "react";
import { cn } from "@/utils/cn";
import type { ThemePreference } from "../../../../shared/types/app-state";
import { useThemeStore } from "../../../state/stores/theme";
import { useWindowOpacityStore } from "../../../state/stores/window-opacity";
import type { SegmentedOption } from "../segmented-control";
import { SegmentedControl } from "../segmented-control";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THEME_OPTIONS: SegmentedOption<ThemePreference>[] = [
  { value: "warm-dark", label: "Warm Dark" },
  { value: "cool-dark", label: "Cool Dark" },
  { value: "warm-light", label: "Warm Light" },
  { value: "system", label: "System" },
];

const OPACITY_MIN = 0;
const OPACITY_MAX = 1.0;
const OPACITY_STEP = 0.05;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AppearancePanel() {
  const themePreference = useThemeStore((s) => s.preference);
  const setThemePreference = useThemeStore((s) => s.setPreference);

  const opacity = useWindowOpacityStore((s) => s.opacity);
  const setOpacity = useWindowOpacityStore((s) => s.setOpacity);

  // Local preview — updated on every drag tick for real-time value label.
  // setOpacity (→ IPC + CSS var apply) is only called on pointer-up (onValueCommit).
  const [localOpacity, setLocalOpacity] = useState<number>(opacity);

  // Keep local preview in sync when the store changes outside this component
  // (e.g. hydration, external restore, dialog re-open with fresh store value).
  useEffect(() => {
    setLocalOpacity(opacity);
  }, [opacity]);

  const opacityPercent = Math.round(localOpacity * 100);

  return (
    <div className="flex flex-col gap-6">
      {/* Section: Theme */}
      <SettingsSection label="Theme">
        <SegmentedControl
          options={THEME_OPTIONS}
          value={themePreference}
          onChange={setThemePreference}
          label="Theme"
        />
      </SettingsSection>

      {/* Section: Window Opacity */}
      <SettingsSection label="Window opacity">
        <div className="flex items-center gap-3">
          <Slider.Root
            min={OPACITY_MIN}
            max={OPACITY_MAX}
            step={OPACITY_STEP}
            value={[localOpacity]}
            onValueChange={(vals) => {
              // Preview drag tick — also push to the store so the CSS var
              // updates live as the user drags (no flash on commit).
              if (vals[0] !== undefined) {
                setLocalOpacity(vals[0]);
                setOpacity(vals[0]);
              }
            }}
            aria-label="Window opacity"
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
// Local helper
// ---------------------------------------------------------------------------

function SettingsSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-app-ui-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
