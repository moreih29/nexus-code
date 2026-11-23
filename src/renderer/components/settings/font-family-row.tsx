import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { checkFontAvailable } from "../../services/editor/runtime/font-availability";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { FontCombobox } from "./font-combobox";
import { SettingsRow } from "./section";

const FAMILY_SYSTEM_VALUE = "__system__";
const FAMILY_CUSTOM_VALUE = "__custom__";

export interface FontPreset {
  readonly value: string;
  readonly label: string;
}

const MONO_PRESETS: readonly FontPreset[] = [
  { value: "JetBrains Mono Nerd Font", label: "JetBrains Mono" },
  { value: "D2CodingLigature Nerd Font", label: "D2Coding" },
  { value: "Sarasa Term K", label: "Sarasa Term K" },
];

interface FontFamilyRowProps {
  scope: "editor" | "terminal" | "chat";
  family: string | undefined;
  setFamily: (family: string | undefined) => void;
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
  const toCustom = useRef(false);

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
