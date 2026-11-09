// src/renderer/components/settings/font-family-row.tsx — Font family setting.
//
// The editor, the terminal and the chat tabs pick their font the same way: a
// Select of the presets (the bundled faces), the default, and "Other…", which
// adds a field that finds an installed font as its name is typed
// (FontCombobox). A font picked so is installed; one that is not (removed
// since, or set by name where the fonts cannot be listed) gets a line saying
// so, as the browser silently falls back.
//
// Each keeps its own font in its own store; `scope` names its strings.

import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { checkFontAvailable } from "../../services/editor/runtime/font-availability";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { FontCombobox } from "./font-combobox";
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
  // Picking "Other…" puts the keyboard in its field, not back on the Select.
  const toCustom = useRef(false);

  // Whether the font picked by name is installed: false when the browser
  // falls back, said in strong words so the fallback is not taken for the
  // font. Checked as it is picked, not per key.
  const available = useMemo(
    () => (selected === FAMILY_CUSTOM_VALUE && isCustom ? checkFontAvailable(family ?? "") : null),
    [selected, isCustom, family],
  );

  const select = (value: string) => {
    setSelected(value);
    if (value === FAMILY_CUSTOM_VALUE) {
      toCustom.current = true;
      return;
    }
    setFamily(value === FAMILY_SYSTEM_VALUE ? undefined : value);
  };

  const reset = () => {
    setFamily(undefined);
    setSelected(FAMILY_SYSTEM_VALUE);
  };

  return (
    <SettingsRow
      label={t(`${scope}.fontFamily`)}
      description={
        available === false ? (
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
          <SelectContent
            onCloseAutoFocus={(event) => {
              if (!toCustom.current) return;
              toCustom.current = false;
              event.preventDefault();
              document.getElementById(customId)?.focus();
            }}
          >
            {options.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected === FAMILY_CUSTOM_VALUE && (
          <FontCombobox
            id={customId}
            value={isCustom ? (family ?? "") : ""}
            onPick={setFamily}
            placeholder={t(`${scope}.customFamilyPlaceholder`)}
          />
        )}
      </div>
    </SettingsRow>
  );
}
