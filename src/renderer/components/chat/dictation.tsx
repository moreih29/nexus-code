import { LoaderCircle, Mic, Square } from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { COMMANDS } from "../../../shared/keybindings/commands";
import { shortcutFor } from "../../keybindings/shortcut-labels";
import { useVoiceAvailability, voiceLanguage } from "../../services/voice/availability";
import {
  cancelDictation,
  type DictationPhase,
  focusedDictationTarget,
  registerDictationTarget,
  stopDictation,
  toggleDictation,
  useDictationStore,
} from "../../services/voice/dictation";
import { type DictationPlace, dictatedText, placeOf } from "../../services/voice/text";
import { cn } from "../../utils/cn";
import { IconButton } from "../ui/icon-button";
import { Keycap } from "../ui/keycap";
import { tooltipProps } from "../ui/tooltip";

export const VOICE_LIMIT_WARNING_MS = 30_000;

export interface ComposerDictation {
  owner: string;
  active: boolean;
  phase: DictationPhase;
  partial: { start: number; end: number } | null;
  toggle(): void;
  finish(then: (text: string) => void): void;
  onFocus(): void;
}

export function useComposerDictation({
  text,
  setText,
  areaRef,
  disabled,
}: {
  text: string;
  setText: (text: string) => void;
  areaRef: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
}): ComposerDictation {
  const owner = useId();
  const phase = useDictationStore((s) => (s.owner === owner ? s.phase : "idle"));
  const finals = useDictationStore((s) => (s.owner === owner ? s.finals : ""));
  const heard = useDictationStore((s) => (s.owner === owner ? s.partial : ""));
  const ended = useDictationStore((s) => (s.ended?.owner === owner ? s.ended : null));
  const place = useRef<DictationPlace | null>(null);
  const latest = useRef({ text, setText });
  latest.current = { text, setText };
  const seen = useRef(0);
  const [partial, setPartial] = useState<{ start: number; end: number } | null>(null);
  const active = phase !== "idle";
  const then = useRef<((text: string) => void) | null>(null);

  const toggle = () => {
    if (disabled && !active) return;
    if (!active) {
      then.current = null;
      const area = areaRef.current;
      const caret = area ? area.selectionEnd : latest.current.text.length;
      place.current = placeOf(latest.current.text, caret);
    }
    void toggleDictation(owner, voiceLanguage());
  };
  const finish = (next: (text: string) => void) => {
    if (phase === "idle") {
      next(latest.current.text);
      return;
    }
    if (phase === "starting") {
      cancelDictation(owner);
      next(latest.current.text);
      return;
    }
    then.current = next;
    if (phase === "listening") stopDictation();
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  useEffect(() => registerDictationTarget({ owner, toggle: () => toggleRef.current() }), [owner]);
  useEffect(() => () => cancelDictation(owner), [owner]);

  useEffect(() => {
    if (!active || !place.current) {
      setPartial(null);
      return;
    }
    const next = dictatedText(place.current, finals, heard);
    if (next.text !== latest.current.text) latest.current.setText(next.text);
    setPartial({ start: next.partialStart, end: next.partialEnd });
  }, [active, finals, heard]);

  useEffect(() => {
    if (!ended || ended.seq === seen.current || !place.current) return;
    seen.current = ended.seq;
    const done = dictatedText(place.current, ended.finals, ended.partial);
    place.current = null;
    latest.current.setText(done.text);
    const area = areaRef.current;
    if (area) {
      requestAnimationFrame(() => {
        area.focus();
        area.setSelectionRange(done.partialEnd, done.partialEnd);
      });
    }
    const after = then.current;
    then.current = null;
    after?.(done.text);
  }, [ended, areaRef]);

  return {
    owner,
    active,
    phase,
    partial: active ? partial : null,
    toggle,
    finish,
    onFocus: () => focusedDictationTarget(owner),
  };
}

export function DictationOverlay({
  text,
  partial,
  areaRef,
  className,
}: {
  text: string;
  partial: { start: number; end: number };
  areaRef: RefObject<HTMLTextAreaElement | null>;
  className: string;
}) {
  const [scroll, setScroll] = useState(0);
  const [gutter, setGutter] = useState(0);
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const sync = () => {
      setScroll(area.scrollTop);
      setGutter(area.offsetWidth - area.clientWidth);
    };
    sync();
    area.addEventListener("scroll", sync);
    const observer = new ResizeObserver(sync);
    observer.observe(area);
    return () => {
      area.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [areaRef]);
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.scrollTop = area.scrollHeight;
  }, [areaRef]);
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ right: gutter }}
      data-testid="dictation-overlay"
    >
      <div
        className={cn("break-words whitespace-pre-wrap text-foreground", className)}
        style={{ transform: `translateY(${-scroll}px)` }}
      >
        {text.slice(0, partial.start)}
        <span className="text-muted-foreground">{text.slice(partial.start, partial.end)}</span>
        {text.slice(partial.end)}
      </div>
    </div>
  );
}

const BARS = 6;

function LevelBars({ level }: { level: number }) {
  const [heard, setHeard] = useState<number[]>(() => Array(BARS).fill(0));
  useEffect(() => {
    setHeard((last) => [...last.slice(1), Math.min(1, Math.max(0, level))]);
  }, [level]);
  return (
    <span aria-hidden className="flex h-3.5 items-center gap-[2px]">
      {heard.map((loud, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a bar is its place in the row
          key={i}
          className="w-[2px] rounded-full bg-current transition-[height] duration-100"
          style={{ height: `${Math.round(3 + loud * 11)}px` }}
        />
      ))}
    </span>
  );
}

export function clockOf(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, now - since);
}

export function VoicePill({
  phase,
  level,
  elapsedMs,
  limitMs,
  compact = false,
  shortcut,
  onClick,
}: {
  phase: Exclude<DictationPhase, "idle">;
  level: number;
  elapsedMs: number;
  limitMs: number | null;
  compact?: boolean;
  shortcut?: string;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const warn = limitMs !== null && limitMs - elapsedMs <= VOICE_LIMIT_WARNING_MS;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={phase === "stopping"}
      aria-label={t("voice.stop")}
      {...tooltipProps(t("voice.stop"), shortcut)}
      className={cn(
        "group inline-flex h-7 shrink-0 items-center rounded-(--radius-control) bg-primary/15 text-app-ui-sm text-primary transition-colors hover:bg-primary/25 disabled:pointer-events-none",
        phase === "listening" ? "pr-1 pl-2.5" : "gap-1.5 px-2.5",
        phase === "stopping" && "bg-primary/10",
      )}
      data-testid="mic-button"
      data-phase={phase}
    >
      {phase === "listening" ? (
        <span className="grid">
          <span className="col-start-1 row-start-1 flex items-center gap-2 group-hover:invisible group-focus-visible:invisible">
            <LevelBars level={level} />
            {!compact && (
              <span
                className={cn(
                  "text-foreground tabular-nums",
                  warn && "text-[var(--state-warning-fg)]",
                )}
              >
                {clockOf(elapsedMs)}
              </span>
            )}
            <span aria-hidden className="h-3.5 w-px bg-primary/35" />
            <span className="flex size-5 items-center justify-center">
              <Square aria-hidden className="size-2.5 fill-current" />
            </span>
          </span>
          <span className="invisible col-start-1 row-start-1 flex items-center justify-center gap-1.5 font-medium group-hover:visible group-focus-visible:visible">
            <Square aria-hidden className="size-2.5 fill-current" />
            {!compact && <span>{t("voice.finish")}</span>}
            {!compact && <Keycap>Enter</Keycap>}
          </span>
        </span>
      ) : (
        <>
          <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
          <span className="text-muted-foreground">
            {t(phase === "stopping" ? "voice.finishing" : "voice.connecting")}
          </span>
        </>
      )}
    </button>
  );
}

export function MicButton({
  dictation,
  compact,
}: {
  dictation: ComposerDictation;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const availability = useVoiceAvailability();
  const mine = (s: { owner: string | null }) => s.owner === dictation.owner;
  const phase = useDictationStore((s) => (mine(s) ? s.phase : "idle"));
  const level = useDictationStore((s) => (mine(s) ? s.level : 0));
  const since = useDictationStore((s) => (mine(s) ? s.listeningSince : null));
  const limitMs = useDictationStore((s) => (mine(s) ? s.limitMs : null));
  const elapsedMs = useElapsed(phase === "listening" ? since : null);
  const shortcut = shortcutFor(COMMANDS.chatVoiceToggle) || undefined;

  if (availability === "signed-out") {
    return (
      <IconButton
        label={t("voice.needsSignIn")}
        size="md"
        onClick={dictation.toggle}
        data-testid="mic-button"
      >
        <Mic aria-hidden className="size-4 opacity-60" />
      </IconButton>
    );
  }
  if (availability === "unavailable") {
    return (
      <IconButton label={t("voice.unavailable")} size="md" disabled data-testid="mic-button">
        <Mic aria-hidden className="size-4" />
      </IconButton>
    );
  }
  return (
    <>
      {phase === "idle" ? (
        <IconButton
          label={t("voice.start")}
          shortcut={shortcut}
          size="md"
          onClick={dictation.toggle}
          data-testid="mic-button"
          data-phase="idle"
        >
          <Mic aria-hidden className="size-4" />
        </IconButton>
      ) : (
        <VoicePill
          phase={phase}
          level={level}
          elapsedMs={elapsedMs}
          limitMs={limitMs}
          compact={compact}
          shortcut={shortcut}
          onClick={dictation.toggle}
        />
      )}
      <span className="sr-only" aria-live="polite">
        {phase === "listening" ? t("voice.listening") : ""}
      </span>
    </>
  );
}
