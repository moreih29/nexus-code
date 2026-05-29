// src/renderer/components/settings/panels/terminal-panel.tsx
//
// Controls:
//   - Live preview: fake shell line + blinking cursor that mirrors font
//     family, size, ligatures and cursor style (no xterm instance — too heavy)
//   - Font size: numeric input + ▲▼ stepper (8–32, step 1)
//   - Font family: token-sealed Select + custom-name input branch
//   - Font ligatures: Radix Checkbox
//   - Cursor style: SegmentedControl with inline glyph previews
//
// Terminal font settings are INDEPENDENT of the editor font — they live in
// their own store (useTerminalStore) and persist to their own appState keys.
//
// Design seal: semantic tokens only, no hex/oklch/rgba literals,
// no magic pixel values, no shadows.

import { useCallback, useEffect, useId, useState } from "react";
import { cn } from "@/utils/cn";
import { checkFontAvailable } from "../../../services/editor/runtime/font-availability";
import type { TerminalCursorStyle, TerminalFontSize } from "../../../state/stores/terminal";
import { useTerminalStore } from "../../../state/stores/terminal";
import { Checkbox } from "../../ui/checkbox";
import { NumberInput } from "../../ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { SettingsRow, SettingsSection } from "../section";
import type { SegmentedOption } from "../segmented-control";
import { SegmentedControl } from "../segmented-control";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FONT_SIZE_MIN: TerminalFontSize = 8;
const FONT_SIZE_MAX: TerminalFontSize = 32;
const DEFAULT_FONT_SIZE_TOKEN = 14; // typeScale.codeUi fallback

// Sentinel for "use the platform fallback (no override)". Stored as the
// explicit "__system__" string in the Select UI because Radix Select reserves
// the empty string for "no value selected". Mapped back to undefined at the
// boundary. Mirrors the editor panel's family control.
const FAMILY_SYSTEM_VALUE = "__system__";

const DEFAULT_FONT_FAMILIES = [
  { value: "JetBrains Mono Nerd Font", label: "JetBrains Mono" },
  { value: "Sarasa Term K", label: "Sarasa Term K" },
  { value: FAMILY_SYSTEM_VALUE, label: "System" },
  { value: "__custom__", label: "Other..." },
];

// Inline cursor-shape previews — rendered with currentColor so they follow
// the segmented control's text color (selected vs. unselected). Sized to sit
// on the typescale baseline without breaking row height.
const CURSOR_OPTIONS: SegmentedOption<TerminalCursorStyle>[] = [
  {
    value: "block",
    label: "Block",
    icon: (
      <span className="inline-block bg-current align-middle" style={{ width: 7, height: 12 }} />
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
      <span className="inline-block bg-current align-middle" style={{ width: 2, height: 12 }} />
    ),
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TerminalPanel() {
  const fontSize = useTerminalStore((s) => s.fontSize);
  const cursorStyle = useTerminalStore((s) => s.cursorStyle);
  const family = useTerminalStore((s) => s.fontFamily);
  const ligatures = useTerminalStore((s) => s.fontLigatures);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const setCursorStyle = useTerminalStore((s) => s.setCursorStyle);
  const setFontFamily = useTerminalStore((s) => s.setFontFamily);
  const setFontLigatures = useTerminalStore((s) => s.setFontLigatures);

  const effectiveSize = fontSize ?? DEFAULT_FONT_SIZE_TOKEN;
  const effectiveCursor: TerminalCursorStyle = cursorStyle ?? "block";
  const effectiveLigatures = ligatures ?? false;
  // For preview render the literal user choice. Undefined ("System") falls
  // back to plain ui-monospace so the system mono face is visible rather than
  // silently substituting JetBrains Mono.
  const previewFamilyStack = family && family !== "" ? family : "ui-monospace";

  // Determine whether the current family is a preset or custom.
  const isCustomFamily =
    family !== undefined &&
    family !== "" &&
    !DEFAULT_FONT_FAMILIES.some((f) => f.value === family && f.value !== "__custom__");
  const [familySelect, setFamilySelect] = useState<string>(
    isCustomFamily ? "__custom__" : family && family !== "" ? family : FAMILY_SYSTEM_VALUE,
  );
  const [customFamilyInput, setCustomFamilyInput] = useState<string>(
    isCustomFamily ? (family ?? "") : "",
  );

  // Font availability check for custom family. `null` = no check yet; `true` =
  // detected; `false` = browser fell back (not installed or typo).
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
        setFontFamily(val === FAMILY_SYSTEM_VALUE ? undefined : val);
        setCustomFamilyInput("");
        setFontAvailable(null);
      }
    },
    [setFontFamily],
  );

  const handleCustomFamilyChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setCustomFamilyInput(val);
      setFontFamily(val.trim() === "" ? undefined : val.trim());
    },
    [setFontFamily],
  );

  const customFamilyId = useId();
  const ligaturesId = useId();

  const resetFamily = () => {
    setFontFamily(undefined);
    setFamilySelect(FAMILY_SYSTEM_VALUE);
    setCustomFamilyInput("");
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Live preview — mirrors family, size, ligatures + cursor style */}
      <TerminalPreview
        fontFamily={previewFamilyStack}
        fontSize={effectiveSize}
        ligatures={effectiveLigatures}
        cursorStyle={effectiveCursor}
      />

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

      {/* Font family — full-width Select (independent of the editor font) */}
      <SettingsSection label="Font family" dirty={family !== undefined} onReset={resetFamily}>
        <Select value={familySelect} onValueChange={handleFamilySelectChange}>
          <SelectTrigger ariaLabel="Terminal font family">
            <SelectValue placeholder="Select font family" />
          </SelectTrigger>
          <SelectContent>
            {DEFAULT_FONT_FAMILIES.map((f) => (
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
              placeholder="e.g. Fira Code"
              className={cn(
                "w-full rounded-(--radius-control) border border-border bg-background px-2 py-1",
                "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
                "focus-visible:ring-1 focus-visible:ring-ring",
              )}
            />
            {fontAvailable === true && (
              <span className="text-app-ui-sm text-muted-foreground">Detected on this system.</span>
            )}
            {fontAvailable === false && (
              <span className="text-app-ui-sm text-[var(--state-warning-fg)]">
                Not found on this system — the preview will use the fallback font.
              </span>
            )}
          </div>
        )}
      </SettingsSection>

      {/* Ligatures — Checkbox + explanation */}
      <SettingsSection
        label="Font ligatures"
        dirty={ligatures !== undefined}
        onReset={() => setFontLigatures(undefined)}
      >
        <label htmlFor={ligaturesId} className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            id={ligaturesId}
            checked={effectiveLigatures}
            onCheckedChange={(v) => setFontLigatures(v === true)}
          />
          <span className="text-app-body text-foreground">Enable ligatures</span>
        </label>
        <p className="text-app-ui-sm text-muted-foreground">
          Renders multi-character sequences like <code>=&gt;</code>, <code>!=</code>,{" "}
          <code>&gt;=</code> as single glyphs when the font supports it. Applies to terminal
          programs (shells, TUIs) too.
        </p>
      </SettingsSection>
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
    <div className="flex flex-col gap-2">
      <span className="text-app-ui-sm text-muted-foreground">Preview</span>
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
    </div>
  );
}
