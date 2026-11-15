// src/renderer/components/settings/panels/remote-voice-group.tsx
//
// Voice input, on the Remote page: how much of the month's minutes the
// account has used (GET /voice/usage), the language it listens for, the
// app's or detected as the user speaks ("multi"), the account's recognition
// terms (GET/PUT /voice/terms, shared by all its devices), and whether this
// computer sends the account's computer and workspace names along.

import { Plus, X } from "lucide-react";
import { type ClipboardEvent, type FormEvent, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { VoiceUsage } from "../../../../../packages/remote-protocol/src/voice";
import { MAX_VOICE_TERM_CHARS, MAX_VOICE_TERMS } from "../../../../shared/remote/voice";
import { ipcCallResult } from "../../../ipc/client";
import { addTerms, pastedTerms, removeTerm } from "../../../services/voice/terms";
import { useLanguageStore } from "../../../state/stores/language";
import { useVoiceStore, type VoiceLanguagePreference } from "../../../state/stores/voice";
import { IconButton } from "../../ui/icon-button";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSwitch } from "../section";
import { SegmentedControl } from "../segmented-control";

const inputClass = cn(
  "min-w-0 flex-1 rounded-(--radius-control) border border-border bg-background px-2 py-1",
  "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
  "focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
);

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

/** The account's terms, each with its X; a word when there are none, or they did not load. */
export function VoiceTermChips({
  terms,
  disabled = false,
  onRemove,
}: {
  terms: readonly string[] | "unavailable" | null;
  disabled?: boolean;
  onRemove: (term: string) => void;
}) {
  const { t } = useTranslation("settings");
  if (terms === null || terms === "unavailable" || terms.length === 0) {
    return (
      <p className="text-app-ui-sm text-muted-foreground">
        {terms === null
          ? t("remote.voice.terms.loading")
          : terms === "unavailable"
            ? t("remote.voice.terms.unavailable")
            : t("remote.voice.terms.empty")}
      </p>
    );
  }
  return (
    <ul className="flex flex-wrap gap-1" aria-label={t("remote.voice.terms.label")}>
      {terms.map((term) => (
        <li
          key={term}
          className="inline-flex min-w-0 items-center gap-0.5 rounded-(--radius-pill) border border-border py-px pr-0.5 pl-2 text-app-ui-sm text-foreground"
        >
          <span className="truncate">{term}</span>
          <IconButton
            size="xs"
            label={t("remote.voice.terms.remove", { term })}
            disabled={disabled}
            onClick={() => onRemove(term)}
          >
            <X className="size-3" aria-hidden="true" />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

/**
 * The account's recognition terms: typed in the field (commas or line
 * breaks add several), shown as chips; each change is saved at once.
 */
function VoiceTermsSection() {
  const { t } = useTranslation("settings");
  const inputId = useId();
  const [terms, setTerms] = useState<string[] | "unavailable" | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void ipcCallResult("remote", "voiceTerms", undefined).then((result) => {
      if (live) setTerms(result.ok ? result.value : "unavailable");
    });
    return () => {
      live = false;
    };
  }, []);
  const ready = Array.isArray(terms) ? terms : null;

  const save = async (next: string[]): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const result = await ipcCallResult("remote", "setVoiceTerms", { terms: next });
    setBusy(false);
    if (!result.ok) {
      setError(t("remote.voice.terms.saveFailed"));
      return false;
    }
    setTerms(result.value);
    return true;
  };

  const add = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready || busy) return;
    const next = addTerms(ready, input);
    if (next.status === "none") {
      setInput("");
      setError(null);
    } else if (next.status === "too-long") {
      setError(t("remote.voice.terms.tooLong", { max: MAX_VOICE_TERM_CHARS }));
    } else if (next.status === "too-many") {
      setError(t("remote.voice.terms.tooMany", { max: MAX_VOICE_TERMS }));
    } else {
      // Emptied at once, so what is typed while it saves is the next term's;
      // given back when it was not saved, unless something new was typed.
      const typed = input;
      setInput("");
      if (!(await save(next.terms))) setInput((now) => now || typed);
    }
  };

  // A pasted list keeps its lines apart: the field would join them.
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/[\r\n]/.test(text)) return;
    event.preventDefault();
    const field = event.currentTarget;
    const start = field.selectionStart ?? input.length;
    const end = field.selectionEnd ?? input.length;
    setInput(`${input.slice(0, start)}${pastedTerms(text)}${input.slice(end)}`);
  };

  return (
    <SettingsSection
      label={t("remote.voice.terms.label")}
      htmlFor={inputId}
      description={t("remote.voice.terms.hint")}
    >
      <form className="flex items-center gap-1.5" onSubmit={(e) => void add(e)}>
        <input
          id={inputId}
          type="text"
          className={inputClass}
          value={input}
          spellCheck={false}
          autoComplete="off"
          placeholder={t("remote.voice.terms.placeholder")}
          // Kept while a change saves: the next term can be typed meanwhile.
          disabled={!ready}
          onChange={(e) => setInput(e.target.value)}
          onPaste={paste}
        />
        <IconButton
          size="md"
          label={t("remote.voice.terms.add")}
          disabled={!ready || busy || input.trim() === ""}
          onClick={() => void add()}
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </IconButton>
      </form>
      {error && (
        <p className="text-app-ui-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <VoiceTermChips
        terms={terms}
        disabled={busy}
        onRemove={(term) => {
          if (ready && !busy) void save(removeTerm(ready, term));
        }}
      />
    </SettingsSection>
  );
}

export function VoiceGroup() {
  const { t } = useTranslation("settings");
  const language = useVoiceStore((s) => s.language);
  const setLanguage = useVoiceStore((s) => s.setLanguage);
  const sendNames = useVoiceStore((s) => s.sendNames);
  const setSendNames = useVoiceStore((s) => s.setSendNames);
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
  const chooseSendNames = (next: boolean) => {
    setSendNames(next);
    void ipcCallResult("appState", "set", { voiceSendNames: next });
  };
  return (
    <SettingsGroup title={t("remote.voice.title")}>
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
      <VoiceTermsSection />
      <SettingsSwitch
        label={t("remote.voice.sendNames")}
        description={t("remote.voice.sendNamesDescription")}
        checked={sendNames}
        onChange={chooseSendNames}
      />
    </SettingsGroup>
  );
}
