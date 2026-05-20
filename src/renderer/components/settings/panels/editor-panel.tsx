// src/renderer/components/settings/panels/editor-panel.tsx
//
// Controls:
//   - Font size: numeric input + ▲▼ stepper (12–32, step 1)
//   - Font family: token-sealed Select + custom-name input branch
//   - Font ligatures: Radix Checkbox + live mini-preview that toggles `liga`
//   - Line height: SegmentedControl (1.0 / 1.2 / 1.4), inline with its label
//
// Design seal: semantic tokens only, no hex/oklch/rgba literals,
// no magic pixel values, no shadows.

import { useCallback, useEffect, useId, useState } from "react";
import { cn } from "@/utils/cn";
import { checkFontAvailable } from "../../../services/editor/runtime/font-availability";
import type { EditorFontLineHeight, EditorFontSize } from "../../../state/stores/editor-font";
import { useEditorFontStore } from "../../../state/stores/editor-font";
import { Checkbox } from "../../ui/checkbox";
import { NumberInput } from "../../ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
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

const DEFAULT_FONT_FAMILIES = [
  { value: "JetBrains Mono Nerd Font", label: "JetBrains Mono" },
  { value: "Sarasa Term K", label: "Sarasa Term K" },
  { value: FAMILY_SYSTEM_VALUE, label: "System" },
  { value: "__custom__", label: "Other..." },
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
  const size = useEditorFontStore((s) => s.size);
  const family = useEditorFontStore((s) => s.family);
  const ligatures = useEditorFontStore((s) => s.ligatures);
  const lineHeight = useEditorFontStore((s) => s.lineHeight);
  const setSize = useEditorFontStore((s) => s.setSize);
  const setFamily = useEditorFontStore((s) => s.setFamily);
  const setLigatures = useEditorFontStore((s) => s.setLigatures);
  const setLineHeight = useEditorFontStore((s) => s.setLineHeight);

  const effectiveSize = size ?? DEFAULT_FONT_SIZE_TOKEN;
  const effectiveFamily = family && family !== "" ? family : "JetBrains Mono Nerd Font";
  const effectiveLineHeight = lineHeight ?? DEFAULT_LINE_HEIGHT_TOKEN;
  const effectiveLigatures = ligatures ?? false;

  // Determine whether the current family is a preset or custom.
  const isCustomFamily =
    family !== undefined &&
    family !== "" &&
    !DEFAULT_FONT_FAMILIES.some((f) => f.value === family && f.value !== "__custom__");
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

  // Font availability check for custom family.
  const [fontAvailableMsg, setFontAvailableMsg] = useState<string | null>(null);

  useEffect(() => {
    if (familySelect !== "__custom__") {
      setFontAvailableMsg(null);
      return;
    }
    if (!customFamilyInput.trim()) {
      setFontAvailableMsg(null);
      return;
    }
    const available = checkFontAvailable(customFamilyInput.trim());
    const measured = available ? customFamilyInput.trim() : "(not available)";
    setFontAvailableMsg(`Current: ${measured}`);
  }, [familySelect, customFamilyInput]);

  const handleFamilySelectChange = useCallback(
    (val: string) => {
      setFamilySelect(val);
      if (val !== "__custom__") {
        setFamily(val === FAMILY_SYSTEM_VALUE ? undefined : val);
        setCustomFamilyInput("");
        setFontAvailableMsg(null);
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

  return (
    <div className="flex flex-col gap-5">
      {/* Font size — compact stepper on the right of its label */}
      <SettingsRow label="Font size">
        <NumberInput
          value={effectiveSize}
          onChange={(n) => setSize(n as EditorFontSize)}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          suffix="px"
          ariaLabel="Editor font size"
        />
      </SettingsRow>

      {/* Line height — also compact on the right */}
      <SettingsRow label="Line height">
        <SegmentedControl
          options={LINE_HEIGHT_OPTIONS}
          value={lineHeightToValue(lineHeight)}
          onChange={(v) => setLineHeight(valueToLineHeight(v))}
          label="Line height"
        />
      </SettingsRow>

      {/* Font family — full-width Select */}
      <SettingsSection label="Font family">
        <Select value={familySelect} onValueChange={handleFamilySelectChange}>
          <SelectTrigger ariaLabel="Font family">
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
            {fontAvailableMsg && (
              <span className="text-app-ui-sm text-muted-foreground">{fontAvailableMsg}</span>
            )}
          </div>
        )}
      </SettingsSection>

      {/* Ligatures — Checkbox + explanation + live preview */}
      <SettingsSection label="Font ligatures">
        <label htmlFor={ligaturesId} className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            id={ligaturesId}
            checked={effectiveLigatures}
            onCheckedChange={(v) => setLigatures(v === true)}
          />
          <span className="text-app-body text-foreground">Enable ligatures</span>
        </label>
        <p className="text-app-ui-sm text-muted-foreground">
          Renders multi-character sequences like <code>=&gt;</code>, <code>!=</code>,{" "}
          <code>&gt;=</code> as single glyphs when the font supports it.
        </p>
        <LigaturePreview
          fontFamily={effectiveFamily}
          fontSize={effectiveSize}
          lineHeight={effectiveLineHeight}
          ligatures={effectiveLigatures}
        />
      </SettingsSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/**
 * Horizontal row — label on the left, compact control on the right.
 * Used for controls that hug their natural width (NumberInput, segmented).
 */
function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-app-body text-foreground">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

/**
 * Vertical section — label above, full-width control below.
 * Used for controls that benefit from the available width (Select, preview).
 */
function SettingsSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-app-ui-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ligature live preview
// ---------------------------------------------------------------------------

/**
 * Tiny rendered snippet mirroring the editor's font settings, with
 * `font-feature-settings` toggled by the `ligatures` flag. Lets users see the
 * before/after of common multi-char glyphs before committing to the toggle.
 */
function LigaturePreview({
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
      className="rounded-(--radius-control) border border-border bg-background px-3 py-2"
      style={{
        fontFamily: `${fontFamily}, ui-monospace, monospace`,
        fontSize,
        lineHeight,
        fontFeatureSettings: ligatures ? '"liga", "calt"' : '"liga" 0, "calt" 0',
      }}
    >
      <code className="block whitespace-pre text-foreground">
        {`const fn = (x) => x !== 0 && x >= 1;
// arrow: -> => fat: ==> not-eq: != >= <=`}
      </code>
    </div>
  );
}
