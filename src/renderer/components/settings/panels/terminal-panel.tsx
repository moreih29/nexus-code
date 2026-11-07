// src/renderer/components/settings/panels/terminal-panel.tsx
//
// Two groups. The default shell (terminal-shell-section.tsx). The font: a
// live preview — a fake shell line and blinking cursor that mirror family,
// size, ligatures and cursor style (no xterm instance — too heavy) — then
// family (FontFamilyRow), size (8–32 stepper), cursor style and ligatures.
//
// Terminal font settings are INDEPENDENT of the editor font — they live in
// their own store (useTerminalStore) and persist to their own appState keys.
// What a new task opens with is the Agent panel's.
//
// Design seal: semantic tokens only, no hex/oklch/rgba literals,
// no magic pixel values, no shadows.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { TerminalCursorStyle, TerminalFontSize } from "../../../state/stores/terminal";
import { useTerminalStore } from "../../../state/stores/terminal";
import { NumberInput } from "../../ui/number-input";
import { FontFamilyRow } from "../font-family-row";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSwitch } from "../section";
import type { SegmentedOption } from "../segmented-control";
import { SegmentedControl } from "../segmented-control";
import { TerminalShellSection } from "./terminal-shell-section";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FONT_SIZE_MIN: TerminalFontSize = 8;
const FONT_SIZE_MAX: TerminalFontSize = 32;
const DEFAULT_FONT_SIZE_TOKEN = 14; // typeScale.codeUi fallback

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TerminalPanel() {
  const { t } = useTranslation("settings");

  const fontSize = useTerminalStore((s) => s.fontSize);
  const cursorStyle = useTerminalStore((s) => s.cursorStyle);
  const family = useTerminalStore((s) => s.fontFamily);
  const ligatures = useTerminalStore((s) => s.fontLigatures);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const setCursorStyle = useTerminalStore((s) => s.setCursorStyle);
  const setFontFamily = useTerminalStore((s) => s.setFontFamily);
  const setFontLigatures = useTerminalStore((s) => s.setFontLigatures);

  // Inline cursor-shape previews — rendered with currentColor so they follow
  // the segmented control's text color (selected vs. unselected). Sized to sit
  // on the typescale baseline without breaking row height. Labels come from i18n.
  const cursorOptions = useMemo<SegmentedOption<TerminalCursorStyle>[]>(
    () => [
      {
        value: "block",
        label: t("terminal.cursor.block"),
        icon: (
          <span className="inline-block bg-current align-middle" style={{ width: 7, height: 12 }} />
        ),
      },
      {
        value: "underline",
        label: t("terminal.cursor.underline"),
        icon: (
          <span
            className="inline-block bg-current align-middle"
            style={{ width: 8, height: 2, marginBottom: 1 }}
          />
        ),
      },
      {
        value: "bar",
        label: t("terminal.cursor.bar"),
        icon: (
          <span className="inline-block bg-current align-middle" style={{ width: 2, height: 12 }} />
        ),
      },
    ],
    [t],
  );

  const effectiveSize = fontSize ?? DEFAULT_FONT_SIZE_TOKEN;
  const effectiveCursor: TerminalCursorStyle = cursorStyle ?? "block";
  const effectiveLigatures = ligatures ?? false;
  // For preview render the literal user choice. Undefined ("System") falls
  // back to plain ui-monospace so the system mono face is visible rather than
  // silently substituting JetBrains Mono.
  const previewFamilyStack = family && family !== "" ? family : "ui-monospace";

  return (
    <SettingsPage>
      <SettingsGroup>
        <TerminalShellSection />
      </SettingsGroup>

      <SettingsGroup title={t("terminal.font")}>
        {/* Live preview — mirrors family, size, ligatures + cursor style */}
        <TerminalPreview
          fontFamily={previewFamilyStack}
          fontSize={effectiveSize}
          ligatures={effectiveLigatures}
          cursorStyle={effectiveCursor}
        />

        <FontFamilyRow scope="terminal" family={family} setFamily={setFontFamily} />

        <SettingsRow
          label={t("terminal.fontSize")}
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
            ariaLabel={t("terminal.ariaFontSize")}
          />
        </SettingsRow>

        <SettingsRow
          label={t("terminal.cursorStyle")}
          dirty={cursorStyle !== undefined}
          onReset={() => setCursorStyle(undefined)}
        >
          <SegmentedControl
            options={cursorOptions}
            value={effectiveCursor}
            onChange={setCursorStyle}
            label={t("terminal.cursorStyle")}
          />
        </SettingsRow>

        <SettingsSwitch
          label={t("terminal.fontLigatures")}
          description={t("terminal.ligatures.description")}
          checked={effectiveLigatures}
          onChange={setFontLigatures}
          dirty={ligatures !== undefined}
          onReset={() => setFontLigatures(undefined)}
        />
      </SettingsGroup>
    </SettingsPage>
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
 * Why not a real xterm instance? xterm.js init is heavy and stateful (PTY,
 * FitAddon, theme, ligatures addon). For a 3-line preview the visual delta is
 * invisible. We mirror family/size/ligatures via inline CSS so the sample
 * tracks what xterm renders in the live terminal panel.
 */
function TerminalPreview({
  fontFamily,
  fontSize,
  ligatures,
  cursorStyle,
}: {
  fontFamily: string;
  fontSize: number;
  ligatures: boolean;
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
    <div
      className={cn(
        "rounded-(--radius-control) border border-border bg-background px-3 py-2 text-foreground",
        // Clip rather than let long lines / large font sizes spill past the
        // box border. Lines are kept short so nothing is clipped at 32px;
        // exotic wide fonts fold via the wrap rules below instead of leaking
        // a horizontal scrollbar.
        "overflow-hidden",
      )}
      style={{
        // Quote the first family token so multi-word custom names like
        // "Fira Code" survive the unquoted-parsing split on whitespace.
        fontFamily: `"${fontFamily}", ui-monospace, monospace`,
        fontSize,
        lineHeight: 1.4,
        fontFeatureSettings: ligatures ? '"liga", "calt"' : '"liga" 0, "calt" 0',
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      <div>
        <span className="text-muted-foreground">$ </span>
        <span>git push</span>
      </div>
      {/* Ligature showcase line — mirrors what the live terminal renders */}
      <div>{"=> != >= <= === -> |>"}</div>
      <div className="inline-flex items-baseline">
        <span className="text-muted-foreground">$ </span>
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
  );
}
