// src/renderer/components/chat/dictation.tsx
//
// Voice input in a composer: the mic button, and the text as it is heard.
// While the user speaks, the composer's text holds the finals so far and
// the partial at the caret where dictation began; the textarea's own text
// goes clear and an overlay draws the same text with the partial lighter.
// When the dictation ends its text stays in the box to edit; nothing is
// sent unless the user sends it, which ends the dictation first.
//
// While it runs the mic becomes a pill: the microphone's level, how long
// it has listened, and the square that finishes it.

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
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { cn } from "../../utils/cn";
import { IconButton } from "../ui/icon-button";
import { Keycap } from "../ui/keycap";
import { tooltipProps } from "../ui/tooltip";

/** How long before the server's limit the pill's clock turns to a warning. */
export const VOICE_LIMIT_WARNING_MS = 30_000;

export interface ComposerDictation {
  /** This composer's id in the dictation store. */
  owner: string;
  /** Dictating (or finishing): the textarea is read-only and its text drawn by the overlay. */
  active: boolean;
  phase: DictationPhase;
  /** The heard text's place in the composer's text, while active. */
  partial: { start: number; end: number } | null;
  /** Starts dictating here, or stops. */
  toggle(): void;
  /**
   * Ends the dictation and hands `then` the box's whole text once it is
   * in: what the server still had to say included. At once when none runs.
   */
  finish(then: (text: string) => void): void;
  /** For the textarea's onFocus: the shortcut dictates into the composer focused last. */
  onFocus(): void;
}

/**
 * Ties a composer's text to voice input: puts what is heard at the caret
 * as it comes, and leaves it there when the dictation ends.
 */
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
  // Each field alone, so the microphone's level (ten times a second) leaves the composer be.
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
  // What finish was asked to do once the text is in.
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
    // Still starting: nothing was heard yet, so the box's text is all of it.
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
  // A composer that goes away drops its dictation.
  useEffect(() => () => cancelDictation(owner), [owner]);

  // While heard: the text at the caret, the partial marked for the overlay.
  useEffect(() => {
    if (!active || !place.current) {
      setPartial(null);
      return;
    }
    const next = dictatedText(place.current, finals, heard);
    if (next.text !== latest.current.text) latest.current.setText(next.text);
    setPartial({ start: next.partialStart, end: next.partialEnd });
  }, [active, finals, heard]);

  // Ended: the text stays, the caret after it.
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

/**
 * The composer's text as heard, drawn over its textarea (whose own text
 * is clear meanwhile): the same wrapping, the partial lighter. It follows
 * the textarea's scrolling.
 */
export function DictationOverlay({
  text,
  partial,
  areaRef,
  className,
}: {
  text: string;
  partial: { start: number; end: number };
  areaRef: RefObject<HTMLTextAreaElement | null>;
  /** The textarea's padding and type, so the lines fall the same. */
  className: string;
}) {
  const [scroll, setScroll] = useState(0);
  const [gutter, setGutter] = useState(0);
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const sync = () => {
      setScroll(area.scrollTop);
      // A scrollbar narrows the textarea's lines; the overlay's narrow the same.
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
    // New text scrolls the box to the end, as typing would.
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

/** How many of the microphone's last levels the pill shows, oldest first. */
const BARS = 6;

/**
 * The microphone's last levels as bars, the newest at the right: they
 * move as the voice does, ten times a second.
 */
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

/** m:ss */
export function clockOf(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** How long since `since`, again each second; 0 without one. */
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

/**
 * The mic while a dictation runs, in its place: connecting, then the
 * level, the time it has listened and the square that finishes it (on
 * hover, what a click does), then finishing. Narrow, it leaves out the time.
 */
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
  /** How long the server lets it run; the clock warns near it. */
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
        // Both faces in one cell: the pill keeps its width as the hover changes it.
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

/**
 * The mic: click to dictate, the pill it becomes to finish; the shortcut
 * does the same in the composer focused last. Signed out, it says so and
 * opens the Remote settings; on a server without voice input it is off.
 */
export function MicButton({
  dictation,
  compact,
}: {
  dictation: ComposerDictation;
  /** The composer is narrow: the pill leaves out its clock. */
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
        onClick={() => useSettingsUIStore.getState().openSettingsAt("remote")}
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
      {/* Said to a screen reader as it starts listening. */}
      <span className="sr-only" aria-live="polite">
        {phase === "listening" ? t("voice.listening") : ""}
      </span>
    </>
  );
}
