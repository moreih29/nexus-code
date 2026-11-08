// src/renderer/components/settings/font-family-row.tsx — Font family setting.
//
// The editor, the terminal and the chat tabs pick their font the same way: a
// Select of the presets (the bundled faces), the default, and "Other…", which
// adds a field for any installed font's name. Below the name, whether that
// font is on this system: when it is not, the browser silently falls back,
// and the line says so.
//
// Each keeps its own font in its own store; `scope` names its strings.

import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { checkFontAvailable } from "../../services/editor/runtime/font-availability";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./section";

// Sentinel for "use the platform fallback (no override)". Stored as the
// explicit "__system__" string in the Select UI because Radix Select reserves
// the empty string for "no value selected". Mapped back to undefined at the
// boundary.
const FAMILY_SYSTEM_VALUE = "__system__";
const FAMILY_CUSTOM_VALUE = "__custom__";

export interface FontPreset {
  readonly value: string;
  readonly label: string;
}

/** The bundled monospace faces, the code's presets. */
const MONO_PRESETS: readonly FontPreset[] = [
  { value: "JetBrains Mono Nerd Font", label: "JetBrains Mono" },
  { value: "D2CodingLigature Nerd Font", label: "D2Coding" },
  { value: "Sarasa Term K", label: "Sarasa Term K" },
];

interface FontFamilyRowProps {
  scope: "editor" | "terminal" | "chat";
  /** The family chosen; undefined for the default. */
  family: string | undefined;
  setFamily: (family: string | undefined) => void;
  /** The fonts offered by name; the bundled monospace faces unless given. */
  presets?: readonly FontPreset[];
}

export function FontFamilyRow({
  scope,
  family,
  setFamily,
  presets = MONO_PRESETS,
}: FontFamilyRowProps) {
  const { t } = useTranslation("settings");
  const customId = useId();

  const options = useMemo(
    () => [
      ...presets,
      { value: FAMILY_SYSTEM_VALUE, label: t(`${scope}.fontFamilySystem`) },
      { value: FAMILY_CUSTOM_VALUE, label: t(`${scope}.fontFamilyOther`) },
    ],
    [t, scope, presets],
  );

  const isCustom =
    family !== undefined && family !== "" && !presets.some((f) => f.value === family);
  const [selected, setSelected] = useState<string>(
    isCustom ? FAMILY_CUSTOM_VALUE : family && family !== "" ? family : FAMILY_SYSTEM_VALUE,
  );
  const [custom, setCustom] = useState<string>(isCustom ? (family ?? "") : "");

  // Whether the typed font is installed. `null` = nothing to check; `false` =
  // the browser fell back (not installed, or a typo). Said in strong words so
  // the silent fallback is not taken for the font.
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    const trimmed = custom.trim();
    setAvailable(selected === FAMILY_CUSTOM_VALUE && trimmed ? checkFontAvailable(trimmed) : null);
  }, [selected, custom]);

  const select = (value: string) => {
    setSelected(value);
    if (value === FAMILY_CUSTOM_VALUE) return;
    setFamily(value === FAMILY_SYSTEM_VALUE ? undefined : value);
    setCustom("");
  };

  const reset = () => {
    setFamily(undefined);
    setSelected(FAMILY_SYSTEM_VALUE);
    setCustom("");
  };

  return (
    <SettingsRow
      label={t(`${scope}.fontFamily`)}
      description={
        available === true ? (
          t(`${scope}.fontDetected`)
        ) : available === false ? (
          <span className="text-[var(--state-warning-fg)]">{t(`${scope}.fontNotFound`)}</span>
        ) : undefined
      }
      htmlFor={selected === FAMILY_CUSTOM_VALUE ? customId : undefined}
      dirty={family !== undefined}
      onReset={reset}
    >
      <div className="flex w-52 flex-col gap-1.5">
        <Select value={selected} onValueChange={select}>
          <SelectTrigger ariaLabel={t(`${scope}.ariaFontFamily`)}>
            <SelectValue placeholder={t(`${scope}.fontFamilyPlaceholder`)} />
          </SelectTrigger>
          <SelectContent>
            {options.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected === FAMILY_CUSTOM_VALUE && (
          <input
            id={customId}
            type="text"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              setFamily(e.target.value.trim() === "" ? undefined : e.target.value.trim());
            }}
            placeholder={t(`${scope}.customFamilyPlaceholder`)}
            className={cn(
              "w-full rounded-(--radius-control) border border-border bg-background px-2 py-1",
              "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
              "focus-visible:ring-1 focus-visible:ring-ring",
            )}
          />
        )}
      </div>
    </SettingsRow>
  );
}
