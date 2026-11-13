// src/renderer/components/chat/dictation.tsx
//
// Voice input in a composer: the mic button, and the text as it is heard.
// While the user speaks, the composer's text holds the finals so far and
// the partial at the caret where dictation began; the textarea's own text
// goes clear and an overlay draws the same text with the partial lighter.
// When the dictation ends its text stays in the box to edit; nothing is
// sent for the user.

import { LoaderCircle, Mic } from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { COMMANDS } from "../../../shared/keybindings/commands";
import { shortcutFor } from "../../keybindings/shortcut-labels";
import { useVoiceAvailability, voiceLanguage } from "../../services/voice/availability";
import {
  cancelDictation,
  focusedDictationTarget,
  registerDictationTarget,
  toggleDictation,
  useDictationStore,
} from "../../services/voice/dictation";
import { type DictationPlace, dictatedText, placeOf } from "../../services/voice/text";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { cn } from "../../utils/cn";
import { IconButton } from "../ui/icon-button";

export interface ComposerDictation {
  /** This composer's id in the dictation store. */
  owner: string;
  /** Dictating (or finishing): the textarea is read-only and its text drawn by the overlay. */
  active: boolean;
  /** The heard text's place in the composer's text, while active. */
  partial: { start: number; end: number } | null;
  /** Starts dictating here, or stops. */
  toggle(): void;
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

  const toggle = () => {
    if (disabled && !active) return;
    if (!active) {
      const area = areaRef.current;
      const caret = area ? area.selectionEnd : latest.current.text.length;
      place.current = placeOf(latest.current.text, caret);
    }
    void toggleDictation(owner, voiceLanguage());
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
  }, [ended, areaRef]);

  return {
    owner,
    active,
    partial: active ? partial : null,
    toggle,
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

/**
 * The mic: click to dictate, again to stop; the shortcut does the same
 * in the composer focused last. Signed out, it says so and opens the
 * Remote settings; on a server without voice input it is off.
 */
export function MicButton({ dictation }: { dictation: ComposerDictation }) {
  const { t } = useTranslation();
  const availability = useVoiceAvailability();
  const phase = useDictationStore((s) => (s.owner === dictation.owner ? s.phase : "idle"));
  const level = useDictationStore((s) => (s.owner === dictation.owner ? s.level : 0));
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
  const busy = phase === "starting" || phase === "stopping";
  const listening = phase === "listening";
  return (
    <IconButton
      label={listening || busy ? t("voice.stop") : t("voice.start")}
      shortcut={shortcut}
      size="md"
      onClick={dictation.toggle}
      disabled={phase === "stopping"}
      aria-pressed={listening}
      className={cn("relative", listening && "text-destructive hover:text-destructive")}
      data-testid="mic-button"
      data-phase={phase}
    >
      {listening && (
        // Swells with the voice, so the user sees the microphone hears them.
        <span
          aria-hidden
          className="absolute inset-0.5 rounded-full bg-destructive/15 transition-transform duration-100"
          style={{ transform: `scale(${0.7 + level * 0.5})` }}
        />
      )}
      {busy ? (
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
      ) : (
        <Mic aria-hidden className="relative size-4" />
      )}
    </IconButton>
  );
}
