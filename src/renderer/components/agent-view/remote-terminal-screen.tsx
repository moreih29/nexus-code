import { ChevronDown } from "lucide-react";
import { type CSSProperties, memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TerminalCaret } from "../../../../packages/remote-protocol/src";
import { TERMINAL_PALETTES } from "../../../shared/editor/terminal-palette";
import type { TypedInput } from "../../services/remote/terminal-typing";
import { terminalKeyOf } from "../../services/remote/terminal-typing";
import {
  type Color,
  paletteColor,
  parseAnsi,
  type Run,
  type Style,
  sixteenOf,
  withCaret,
} from "../../services/terminal/ansi-runs";
import {
  resolvedTerminalFontFamily,
  resolvedTerminalFontLigatures,
  resolvedTerminalFontSize,
  useTerminalStore,
} from "../../state/stores/terminal";
import { useThemeStore } from "../../state/stores/theme";
import { cn } from "../../utils/cn";
import { isImeComposing } from "../../utils/ime";

const AT_END_PX = 24;

interface Colors {
  sixteen: readonly string[];
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
}

function colorOf(color: Color, colors: Colors): string {
  return typeof color === "number" ? paletteColor(color, colors.sixteen) : color;
}

export function lookOf(style: Style, colors: Colors): CSSProperties | undefined {
  if (Object.keys(style).length === 0) return undefined;
  const fgIndex =
    style.bold && typeof style.fg === "number" && style.fg < 8 ? style.fg + 8 : style.fg;
  let fg = fgIndex === undefined ? undefined : colorOf(fgIndex, colors);
  let bg = style.bg === undefined ? undefined : colorOf(style.bg, colors);
  if (style.inverse) [fg, bg] = [bg ?? colors.background, fg ?? colors.foreground];
  if (style.dim) fg = `color-mix(in srgb, ${fg ?? colors.foreground} 50%, transparent)`;
  if (style.hidden) fg = "transparent";
  const lines = [style.underline && "underline", style.strike && "line-through"].filter(Boolean);
  return {
    ...(fg ? { color: fg } : {}),
    ...(bg ? { backgroundColor: bg } : {}),
    ...(style.bold ? { fontWeight: 700 } : {}),
    ...(style.italic ? { fontStyle: "italic" } : {}),
    ...(lines.length > 0 ? { textDecorationLine: lines.join(" ") } : {}),
  };
}

export function caretLook(style: Style, colors: Colors, focused: boolean): CSSProperties {
  const look = lookOf(style, colors) ?? {};
  return focused
    ? { ...look, color: colors.cursorAccent, backgroundColor: colors.cursor }
    : { ...look, outline: `1px solid ${colors.cursor}`, outlineOffset: -1 };
}

function runLook(run: Run, colors: Colors, focused: boolean): CSSProperties | undefined {
  return run.caret ? caretLook(run.style, colors, focused) : lookOf(run.style, colors);
}

const Line = memo(function Line({
  text,
  colors,
  end,
  caret,
  focused = false,
}: {
  text: string;
  colors: Colors;
  end: boolean;
  caret?: number;
  focused?: boolean;
}) {
  const runs = useMemo(() => {
    const parsed = parseAnsi(text);
    return caret === undefined ? parsed : withCaret(parsed, caret);
  }, [text, caret]);
  return (
    <>
      {runs.map((run, i) => {
        const look = runLook(run, colors, focused);
        return look ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity but their place
          <span key={i} style={look}>
            {run.text}
          </span>
        ) : (
          run.text
        );
      })}
      {end ? null : "\n"}
    </>
  );
});

export function RemoteTerminalScreen({
  text,
  caret,
  typing,
}: {
  text: string;
  caret?: TerminalCaret;
  typing?: { type(input: TypedInput): void };
}) {
  const { t } = useTranslation();
  const themeId = useThemeStore((s) => s.resolved);
  useTerminalStore((s) => s.fontFamily);
  useTerminalStore((s) => s.fontSize);
  useTerminalStore((s) => s.fontLigatures);
  const palette = TERMINAL_PALETTES[themeId];
  const colors = useMemo<Colors>(
    () => ({
      sixteen: sixteenOf(palette),
      foreground: palette.foreground ?? "#ffffff",
      background: "var(--surface-island-bg)",
      cursor: palette.cursor ?? palette.foreground ?? "#ffffff",
      cursorAccent: palette.cursorAccent ?? "var(--surface-island-bg)",
    }),
    [palette],
  );
  const caretLine = caret?.line;
  const lines = useMemo(() => {
    const shown = text.trimEnd().split("\n");
    while (caretLine !== undefined && shown.length <= caretLine) shown.push("");
    return shown;
  }, [text, caretLine]);
  const ref = useRef<HTMLPreElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [typingHere, setTypingHere] = useState(false);
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new text keeps the end in sight
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
    else if (el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX) {
      stuck.current = true;
      setAway(false);
    }
  }, [lines]);
  const toEnd = (smooth: boolean) => {
    const el = ref.current;
    stuck.current = true;
    setAway(false);
    el?.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  const type = (given: TypedInput) => {
    typing?.type(given);
    toEnd(false);
  };
  const typeHeld = (box: HTMLTextAreaElement) => {
    const held = box.value;
    box.value = "";
    if (held) type({ text: held, typed: true });
  };

  return (
    <div className={cn("relative min-h-0 flex-1", typingHere && "ring-1 ring-ring ring-inset")}>
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX;
          stuck.current = atEnd;
          setAway(!atEnd);
        }}
        onMouseUp={() => {
          if (typing && !window.getSelection()?.toString()) {
            input.current?.focus({ preventScroll: true });
          }
        }}
        className={cn(
          "app-scrollbar absolute inset-0 m-0 overflow-auto py-1.5 pr-3 pl-3 selection:bg-(--remote-terminal-selection)",
          "whitespace-pre-wrap break-all",
          typing && "cursor-text",
        )}
        style={
          {
            fontFamily: resolvedTerminalFontFamily(),
            fontSize: resolvedTerminalFontSize(),
            lineHeight: 1.2,
            color: colors.foreground,
            fontVariantLigatures: resolvedTerminalFontLigatures() ? "normal" : "none",
            "--remote-terminal-selection": palette.selectionBackground,
          } as CSSProperties
        }
        data-testid="remote-terminal"
      >
        {lines.map((line, i) => (
          <Line
            // biome-ignore lint/suspicious/noArrayIndexKey: a terminal's lines are their rows
            key={i}
            text={line}
            colors={colors}
            end={i === lines.length - 1}
            {...(i === caretLine ? { caret: caret?.column, focused: typingHere } : {})}
          />
        ))}
      </pre>
      {typing && (
        <textarea
          ref={input}
          aria-label={t("agentView.remote.terminalInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => setTypingHere(true)}
          onBlur={() => setTypingHere(false)}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return;
            const key = terminalKeyOf(e);
            if (!key) return;
            e.preventDefault();
            typeHeld(e.currentTarget);
            type({ keys: [key] });
          }}
          onInput={(e) => {
            if ((e.nativeEvent as InputEvent).isComposing) return;
            typeHeld(e.currentTarget);
          }}
          onCompositionEnd={(e) => typeHeld(e.currentTarget)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text/plain");
            if (!pasted) return;
            e.preventDefault();
            typeHeld(e.currentTarget);
            type({ text: pasted });
          }}
          className="pointer-events-none absolute bottom-0 left-0 size-px resize-none overflow-hidden opacity-0"
          data-testid="remote-terminal-input"
        />
      )}
      {away && (
        <button
          type="button"
          onClick={() => toEnd(true)}
          title={t("agentView.remote.terminalToEnd")}
          aria-label={t("agentView.remote.terminalToEnd")}
          className="absolute right-4 bottom-3 rounded-full border border-border bg-popover p-1.5 text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="size-4" />
        </button>
      )}
    </div>
  );
}
