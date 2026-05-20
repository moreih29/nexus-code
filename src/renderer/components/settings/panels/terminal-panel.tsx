// src/renderer/components/settings/panels/terminal-panel.tsx
//
// Controls: Font size (slider 6 closed steps) + Cursor style (segmented 3).
//
// Design seal: semantic tokens only, no hex/oklch/rgba literals,
// no magic pixel values, no shadows.

import { Slider } from "radix-ui";
import { cn } from "@/utils/cn";
import type { TerminalCursorStyle, TerminalFontSize } from "../../../state/stores/terminal";
import { useTerminalStore } from "../../../state/stores/terminal";
import type { SegmentedOption } from "../segmented-control";
import { SegmentedControl } from "../segmented-control";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FONT_SIZE_STEPS: TerminalFontSize[] = [12, 13, 14, 16, 18, 20];
const FONT_SIZE_SLIDER_MAX = FONT_SIZE_STEPS.length - 1;
const DEFAULT_FONT_SIZE_TOKEN = 14; // typeScale.codeUi fallback

const CURSOR_OPTIONS: SegmentedOption<TerminalCursorStyle>[] = [
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
  { value: "bar", label: "Bar" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sizeToIndex(size: TerminalFontSize | undefined): number {
  const idx = FONT_SIZE_STEPS.indexOf(size ?? (DEFAULT_FONT_SIZE_TOKEN as TerminalFontSize));
  return idx >= 0 ? idx : FONT_SIZE_STEPS.indexOf(DEFAULT_FONT_SIZE_TOKEN as TerminalFontSize);
}

function indexToSize(idx: number): TerminalFontSize {
  return FONT_SIZE_STEPS[idx] ?? (DEFAULT_FONT_SIZE_TOKEN as TerminalFontSize);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TerminalPanel() {
  const fontSize = useTerminalStore((s) => s.fontSize);
  const cursorStyle = useTerminalStore((s) => s.cursorStyle);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const setCursorStyle = useTerminalStore((s) => s.setCursorStyle);

  const fontSizeIndex = sizeToIndex(fontSize);
  const effectiveSize = fontSize ?? DEFAULT_FONT_SIZE_TOKEN;

  return (
    <div className="flex flex-col gap-6">
      {/* Font size */}
      <SettingsSection label="Font size">
        <div className="flex items-center gap-3">
          <Slider.Root
            min={0}
            max={FONT_SIZE_SLIDER_MAX}
            step={1}
            value={[fontSizeIndex]}
            onValueChange={(vals) => {
              if (vals[0] !== undefined) setFontSize(indexToSize(vals[0]));
            }}
            aria-label="Terminal font size"
            className="relative flex flex-1 touch-none select-none items-center"
          >
            <Slider.Track className="relative h-1 w-full grow rounded-(--radius-control) bg-muted border border-border">
              <Slider.Range className="absolute h-full rounded-(--radius-control) bg-[var(--state-selected-bg)]" />
            </Slider.Track>
            {/* Thumb takes the selected-state tone so it stays visible against
                Floating-layer popover bg (bg-background blended with it). */}
            <Slider.Thumb
              className={cn(
                "block size-4 rounded-full border border-[var(--state-selected-bg)] bg-[var(--state-selected-bg)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "transition-colors",
              )}
            />
          </Slider.Root>
          <span className="w-8 text-right text-app-ui-sm text-muted-foreground tabular-nums">
            {effectiveSize}px
          </span>
        </div>
      </SettingsSection>

      {/* Cursor style */}
      <SettingsSection label="Cursor style">
        <SegmentedControl
          options={CURSOR_OPTIONS}
          value={cursorStyle ?? "block"}
          onChange={setCursorStyle}
          label="Cursor style"
        />
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
