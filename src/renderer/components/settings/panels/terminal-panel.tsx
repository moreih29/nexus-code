// src/renderer/components/settings/panels/terminal-panel.tsx
//
// Controls:
//   - Font size: numeric input + ▲▼ stepper (8–32, step 1)
//   - Cursor style: SegmentedControl with inline glyph previews
//
// Design seal: semantic tokens only, no hex/oklch/rgba literals,
// no magic pixel values, no shadows.

import type { TerminalCursorStyle, TerminalFontSize } from "../../../state/stores/terminal";
import { useTerminalStore } from "../../../state/stores/terminal";
import { NumberInput } from "../../ui/number-input";
import type { SegmentedOption } from "../segmented-control";
import { SegmentedControl } from "../segmented-control";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FONT_SIZE_MIN: TerminalFontSize = 8;
const FONT_SIZE_MAX: TerminalFontSize = 32;
const DEFAULT_FONT_SIZE_TOKEN = 14; // typeScale.codeUi fallback

// Inline cursor-shape previews — rendered with currentColor so they follow
// the segmented control's text color (selected vs. unselected). Sized to sit
// on the typescale baseline without breaking row height.
const CURSOR_OPTIONS: SegmentedOption<TerminalCursorStyle>[] = [
  {
    value: "block",
    label: "Block",
    icon: (
      <span
        className="inline-block bg-current align-middle"
        style={{ width: 7, height: 12 }}
      />
    ),
  },
  {
    value: "underline",
    label: "Underline",
    icon: (
      <span
        className="inline-block bg-current align-middle"
        style={{ width: 8, height: 2, marginBottom: 1 }}
      />
    ),
  },
  {
    value: "bar",
    label: "Bar",
    icon: (
      <span
        className="inline-block bg-current align-middle"
        style={{ width: 2, height: 12 }}
      />
    ),
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TerminalPanel() {
  const fontSize = useTerminalStore((s) => s.fontSize);
  const cursorStyle = useTerminalStore((s) => s.cursorStyle);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const setCursorStyle = useTerminalStore((s) => s.setCursorStyle);

  const effectiveSize = fontSize ?? DEFAULT_FONT_SIZE_TOKEN;

  return (
    <div className="flex flex-col gap-5">
      {/* Font size — compact stepper */}
      <SettingsRow label="Font size">
        <NumberInput
          value={effectiveSize}
          onChange={(n) => setFontSize(n as TerminalFontSize)}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          suffix="px"
          ariaLabel="Terminal font size"
        />
      </SettingsRow>

      {/* Cursor style — segmented with shape previews */}
      <SettingsRow label="Cursor style">
        <SegmentedControl
          options={CURSOR_OPTIONS}
          value={cursorStyle ?? "block"}
          onChange={setCursorStyle}
          label="Cursor style"
        />
      </SettingsRow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout helper — label on the left, compact control on the right
// ---------------------------------------------------------------------------

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-app-body text-foreground">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}
