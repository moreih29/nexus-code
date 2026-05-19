// src/renderer/components/settings/panels/editor-panel.tsx
//
// Controls: Font size (slider 6 closed steps) + Family (dropdown + custom input +
//           font availability indicator) + Ligatures (toggle) + Line height (segmented 3).
//
// Design seal: semantic tokens only, no hex/oklch/rgba literals,
// no magic pixel values, no shadows.

import { Slider } from "radix-ui";
import { useCallback, useEffect, useId, useState } from "react";
import { cn } from "@/utils/cn";
import { checkFontAvailable } from "../../../services/editor/runtime/font-availability";
import type { EditorFontLineHeight, EditorFontSize } from "../../../state/stores/editor-font";
import { useEditorFontStore } from "../../../state/stores/editor-font";
import type { SegmentedOption } from "../segmented-control";
import { SegmentedControl } from "../segmented-control";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Closed set of font size steps.
const FONT_SIZE_STEPS: EditorFontSize[] = [12, 13, 14, 16, 18, 20];
// Index-based slider: 0–5.
const FONT_SIZE_SLIDER_MAX = FONT_SIZE_STEPS.length - 1;

const LINE_HEIGHT_OPTIONS: SegmentedOption<string>[] = [
  { value: "1", label: "1.0" },
  { value: "1.2", label: "1.2" },
  { value: "1.4", label: "1.4" },
];

const DEFAULT_FONT_FAMILIES = [
  { value: "JetBrains Mono Nerd Font", label: "JetBrains Mono" },
  { value: "Sarasa Term K", label: "Sarasa Term K" },
  { value: "", label: "System" },
  { value: "__custom__", label: "Other..." },
];

const DEFAULT_FONT_SIZE_TOKEN = 16; // codeBody fallback
const DEFAULT_LINE_HEIGHT_TOKEN: EditorFontLineHeight = 1.4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sizeToIndex(size: EditorFontSize | undefined): number {
  const idx = FONT_SIZE_STEPS.indexOf(size ?? DEFAULT_FONT_SIZE_TOKEN);
  return idx >= 0 ? idx : FONT_SIZE_STEPS.indexOf(DEFAULT_FONT_SIZE_TOKEN);
}

function indexToSize(idx: number): EditorFontSize {
  return FONT_SIZE_STEPS[idx] ?? DEFAULT_FONT_SIZE_TOKEN;
}

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

  const fontSizeIndex = sizeToIndex(size);
  const effectiveSize = size ?? DEFAULT_FONT_SIZE_TOKEN;

  // Determine whether the current family is a preset or custom.
  const isCustomFamily =
    family !== undefined &&
    family !== "" &&
    !DEFAULT_FONT_FAMILIES.some((f) => f.value === family && f.value !== "__custom__");
  const [familySelect, setFamilySelect] = useState<string>(
    isCustomFamily ? "__custom__" : (family ?? ""),
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
    setFontAvailableMsg(`현재 적용 중: ${measured}`);
  }, [familySelect, customFamilyInput]);

  const handleFamilySelectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value;
      setFamilySelect(val);
      if (val !== "__custom__") {
        setFamily(val === "" ? undefined : val);
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

  const familySelectId = useId();
  const customFamilyId = useId();
  const ligaturesId = useId();

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
              if (vals[0] !== undefined) setSize(indexToSize(vals[0]));
            }}
            aria-label="Editor font size"
            className="relative flex flex-1 touch-none select-none items-center"
          >
            <Slider.Track className="relative h-1 w-full grow rounded-(--radius-control) bg-muted border border-border">
              <Slider.Range className="absolute h-full rounded-(--radius-control) bg-[var(--state-selected-bg)]" />
            </Slider.Track>
            <Slider.Thumb
              className={cn(
                "block size-4 rounded-full border border-border bg-background",
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

      {/* Font family */}
      <SettingsSection label="Font family">
        <select
          id={familySelectId}
          value={familySelect}
          onChange={handleFamilySelectChange}
          className={cn(
            "w-full rounded-(--radius-control) border border-border bg-background px-2 py-1",
            "text-app-body text-foreground outline-none",
            "focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          {DEFAULT_FONT_FAMILIES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
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

      {/* Ligatures */}
      <SettingsSection label="Font ligatures">
        <label htmlFor={ligaturesId} className="flex items-center gap-2 cursor-pointer">
          <input
            id={ligaturesId}
            type="checkbox"
            checked={ligatures ?? false}
            onChange={(e) => setLigatures(e.target.checked)}
            className="rounded-(--radius-control) accent-[var(--state-selected-bg)]"
          />
          <span className="text-app-body text-foreground">Enable ligatures</span>
        </label>
      </SettingsSection>

      {/* Line height */}
      <SettingsSection label="Line height">
        <SegmentedControl
          options={LINE_HEIGHT_OPTIONS}
          value={lineHeightToValue(lineHeight)}
          onChange={(v) => setLineHeight(valueToLineHeight(v))}
          label="Line height"
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
