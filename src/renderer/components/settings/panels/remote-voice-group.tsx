// src/renderer/components/settings/panels/remote-voice-group.tsx
//
// Voice input, on the Remote page: how much of the month's minutes the
// account has used (GET /voice/usage), dictation's and notes' recordings'
// each against its own limit; the language it listens for, the app's or
// detected as the user speaks ("multi"), the account's recognition
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
import { dateTimeFormat } from "../../../utils/intl-format";
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

/** The share of a limit used, in whole percent: 1 once anything is, at most 100. */
export function percentOf(usedSeconds: number, limitSeconds: number): number {
  if (limitSeconds <= 0) return usedSeconds > 0 ? 100 : 0;
  const percent = Math.round((usedSeconds / limitSeconds) * 100);
  return Math.min(100, usedSeconds > 0 ? Math.max(1, percent) : percent);
}

/** When the month's usage starts over: the next month's first, in UTC, as the server counts. */
export function usageResetsAt(period: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return null;
  // The month as written is the next one's index: Date.UTC counts from 0.
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
}

/** At this share the meter turns red: the limit is near. */
const NEAR_LIMIT = 90;

function UsageMeter({
  label,
  usedSeconds,
  limitSeconds,
}: {
  label: string;
  usedSeconds: number;
  limitSeconds: number;
}) {
  const { t } = useTranslation("settings");
  const percent = percentOf(usedSeconds, limitSeconds);
  const near = percent >= NEAR_LIMIT;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-4 text-app-ui-sm">
        <span className="truncate text-foreground">{label}</span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            near ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {t("remote.voice.usageOf", {
            used: minutesOf(usedSeconds),
            limit: Math.floor(limitSeconds / 60),
            percent,
          })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-border"
      >
        <div
          className={cn("h-full rounded-full", near ? "bg-destructive" : "bg-primary")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** The month's usage: dictation's, and notes' recordings' when the server counts them. */
export function VoiceUsageMeters({ usage }: { usage: VoiceUsage | "unavailable" | null }) {
  const { t, i18n } = useTranslation("settings");
  const ready = usage && usage !== "unavailable" ? usage : null;
  const resets = ready ? usageResetsAt(ready.period) : null;
  const aside = ready
    ? resets &&
      t("remote.voice.usageResets", {
        date: dateTimeFormat(i18n.language, { month: "long", day: "numeric" }).format(resets),
      })
    : usage === "unavailable"
      ? t("remote.voice.usageUnavailable")
      : t("remote.voice.usageLoading");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="truncate text-app-body text-foreground">{t("remote.voice.usage")}</span>
        {aside && <span className="shrink-0 text-app-ui-sm text-muted-foreground">{aside}</span>}
      </div>
      {ready && (
        <UsageMeter
          label={t("remote.voice.dictation")}
          usedSeconds={ready.usedSeconds}
          limitSeconds={ready.limitSeconds}
        />
      )}
      {ready?.note && (
        <UsageMeter
          label={t("remote.voice.noteRecording")}
          usedSeconds={ready.note.usedSeconds}
          limitSeconds={ready.note.limitSeconds}
        />
      )}
    </div>
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
      <VoiceUsageMeters usage={usage} />
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
