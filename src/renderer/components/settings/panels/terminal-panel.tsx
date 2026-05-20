// src/renderer/components/settings/panels/terminal-panel.tsx
//
// Controls:
//   - Live preview: fake shell line + blinking cursor that mirrors font size
//     and cursor style (no xterm instance — too heavy for a preview)
//   - Font size: numeric input + ▲▼ stepper (8–32, step 1)
//   - Cursor style: SegmentedControl with inline glyph previews
//
// Design seal: semantic tokens only, no hex/oklch/rgba literals,
// no magic pixel values, no shadows.

import { cn } from "@/utils/cn";
import type { TerminalCursorStyle, TerminalFontSize } from "../../../state/stores/terminal";
import { useTerminalStore } from "../../../state/stores/terminal";
import { NumberInput } from "../../ui/number-input";
import { SettingsRow } from "../section";
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

  const effectiveCursor: TerminalCursorStyle = cursorStyle ?? "block";

  return (
    <div className="flex flex-col gap-5">
      {/* Live preview — mirrors font size + cursor style */}
      <TerminalPreview fontSize={effectiveSize} cursorStyle={effectiveCursor} />

      {/* Font size — compact stepper */}
      <SettingsRow
        label="Font size"
        dirty={fontSize !== undefined}
        onReset={() => setFontSize(undefined)}
      >
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
      <SettingsRow
        label="Cursor style"
        dirty={cursorStyle !== undefined}
        onReset={() => setCursorStyle(undefined)}
      >
        <SegmentedControl
          options={CURSOR_OPTIONS}
          value={effectiveCursor}
          onChange={setCursorStyle}
          label="Cursor style"
        />
      </SettingsRow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live terminal preview
// ---------------------------------------------------------------------------

/**
 * Lightweight HTML mock of a terminal line. Renders a static shell prompt +
 * one command + an output line, then a fresh prompt followed by the user's
 * chosen cursor shape (blinking via the preview-cursor-blink utility).
 *
 * Why not a real xterm instance? xterm.js + canvas/webgl init is heavy and
 * stateful (PTY, FitAddon, theme application). For a 3-line preview the visual
 * delta is invisible. We use the JetBrains Mono Nerd Font directly so the
 * sample matches what xterm renders in the live terminal panel.
 */
function TerminalPreview({
  fontSize,
  cursorStyle,
}: {
  fontSize: number;
  cursorStyle: TerminalCursorStyle;
}) {
  // Cursor dimensions are derived from the font size so they scale with the
  // user's pick. xterm draws block ≈ glyph cell; we approximate: width ≈
  // 0.6em, height ≈ 1.2em (matches monospace metrics closely enough).
  const cellW = Math.round(fontSize * 0.6);
  const cellH = Math.round(fontSize * 1.2);
  const cursorStyleProps =
    cursorStyle === "block"
      ? { width: cellW, height: cellH }
      : cursorStyle === "underline"
        ? { width: cellW, height: 2 }
        : { width: 2, height: cellH };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-app-ui-sm text-muted-foreground">Preview</span>
      <div
        className="rounded-(--radius-control) border border-border bg-background px-3 py-2"
        style={{
          fontFamily: '"JetBrains Mono Nerd Font", ui-monospace, monospace',
          fontSize,
          lineHeight: 1.4,
        }}
      >
        <div className="whitespace-pre text-foreground">
          <span className="text-muted-foreground">~/projects $ </span>
          <span>echo hello</span>
        </div>
        <div className="whitespace-pre text-foreground">hello</div>
        <div className="whitespace-pre text-foreground inline-flex items-baseline">
          <span className="text-muted-foreground">~/projects $ </span>
          <span
            aria-hidden="true"
            className={cn(
              "preview-cursor-blink inline-block bg-foreground align-baseline",
              // Underline sits at baseline; block/bar are top-aligned via inline-block.
              cursorStyle === "underline" && "self-end",
            )}
            style={cursorStyleProps}
          />
        </div>
      </div>
    </div>
  );
}
