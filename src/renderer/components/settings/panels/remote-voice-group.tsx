// src/renderer/components/settings/panels/remote-voice-group.tsx
//
// Voice input, on the Remote page: how much of the month's minutes the
// account has used (GET /voice/usage), and the language it listens for,
// the app's or detected as the user speaks ("multi").

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { VoiceUsage } from "../../../../../packages/remote-protocol/src/voice";
import { COMMANDS } from "../../../../shared/keybindings/commands";
import { ipcCallResult } from "../../../ipc/client";
import { shortcutFor } from "../../../keybindings/shortcut-labels";
import { useLanguageStore } from "../../../state/stores/language";
import { useVoiceStore, type VoiceLanguagePreference } from "../../../state/stores/voice";
import { SettingsGroup, SettingsRow } from "../section";
import { SegmentedControl } from "../segmented-control";

/** The languages' own names, as the Appearance page shows them. */
const NATIVE: Record<string, string> = { en: "English", ko: "한국어" };

/** Minutes, rounded up, so a few seconds used do not read as none. */
export function minutesOf(seconds: number): number {
  return Math.ceil(seconds / 60);
}

export function VoiceUsageRow({ usage }: { usage: VoiceUsage | "unavailable" | null }) {
  const { t } = useTranslation("settings");
  const ready = usage && usage !== "unavailable" ? usage : null;
  const share = ready && ready.limitSeconds > 0 ? ready.usedSeconds / ready.limitSeconds : 0;
  return (
    <SettingsRow
      label={t("remote.voice.usage")}
      description={
        ready
          ? t("remote.voice.usageOf", {
              used: minutesOf(ready.usedSeconds),
              limit: Math.floor(ready.limitSeconds / 60),
            })
          : usage === "unavailable"
            ? t("remote.voice.usageUnavailable")
            : t("remote.voice.usageLoading")
      }
    >
      {ready && (
        <div
          role="progressbar"
          aria-label={t("remote.voice.usage")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.round(share * 100))}
          className="h-1.5 w-32 overflow-hidden rounded-full bg-border"
        >
          <div
            className={share >= 1 ? "h-full bg-destructive" : "h-full bg-primary"}
            style={{ width: `${Math.min(100, Math.round(share * 100))}%` }}
          />
        </div>
      )}
    </SettingsRow>
  );
}

export function VoiceGroup() {
  const { t } = useTranslation("settings");
  const language = useVoiceStore((s) => s.language);
  const setLanguage = useVoiceStore((s) => s.setLanguage);
  const appLanguage = useLanguageStore((s) => s.preference);
  const [usage, setUsage] = useState<VoiceUsage | "unavailable" | null>(null);
  useEffect(() => {
    let live = true;
    void ipcCallResult("remote", "voiceUsage", undefined).then((result) => {
      if (live) setUsage(result.ok ? result.value : "unavailable");
    });
    return () => {
      live = false;
    };
  }, []);
  const choose = (next: VoiceLanguagePreference) => {
    setLanguage(next);
    void ipcCallResult("appState", "set", { voiceLanguage: next });
  };
  const shortcut = shortcutFor(COMMANDS.chatVoiceToggle);
  return (
    <SettingsGroup
      title={t("remote.voice.title")}
      description={
        shortcut
          ? t("remote.voice.descriptionWithShortcut", { shortcut })
          : t("remote.voice.description")
      }
    >
      <VoiceUsageRow usage={usage} />
      <SettingsRow label={t("remote.voice.language")}>
        <SegmentedControl
          options={[
            { value: "app", label: NATIVE[appLanguage] ?? appLanguage },
            { value: "multi", label: t("remote.voice.languageMulti") },
          ]}
          value={language}
          onChange={choose}
          label={t("remote.voice.language")}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
