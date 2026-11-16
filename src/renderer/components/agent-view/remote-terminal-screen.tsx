/**
 * Another computer's terminal as this one draws its own: in the theme's
 * terminal colors and the terminal's font and size (Settings › Terminal),
 * with the program's colors and styles as its SGR escapes give them, bold
 * in the bright colors as xterm draws it. It keeps to the end as output
 * comes, unless the user scrolled up to read; a button then goes back down.
 *
 * Each line of the text starts and ends in the default style (bufferAnsi),
 * so a line is read, and drawn again, only when it changed.
 */

import { ChevronDown } from "lucide-react";
import { type CSSProperties, memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TERMINAL_PALETTES } from "../../../shared/editor/terminal-palette";
import {
  type Color,
  paletteColor,
  parseAnsi,
  type Style,
  sixteenOf,
} from "../../services/terminal/ansi-runs";
import {
  resolvedTerminalFontFamily,
  resolvedTerminalFontLigatures,
  resolvedTerminalFontSize,
  useTerminalStore,
} from "../../state/stores/terminal";
import { useThemeStore } from "../../state/stores/theme";

/** How close to the end still counts as at it, in px. */
const AT_END_PX = 24;

interface Colors {
  sixteen: readonly string[];
  foreground: string;
  background: string;
}

function colorOf(color: Color, colors: Colors): string {
  return typeof color === "number" ? paletteColor(color, colors.sixteen) : color;
}

/** A run's look: its colors (inverse swapped, dim at half), emphasis and lines. */
export function lookOf(style: Style, colors: Colors): CSSProperties | undefined {
  if (Object.keys(style).length === 0) return undefined;
  // Bold in the first eight colors draws in their bright ones, as xterm does.
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

const Line = memo(function Line({
  text,
  colors,
  end,
}: {
  text: string;
  colors: Colors;
  end: boolean;
}) {
  const runs = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {runs.map((run, i) => {
        const look = lookOf(run.style, colors);
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

export function RemoteTerminalScreen({ text }: { text: string }) {
  const { t } = useTranslation();
  const themeId = useThemeStore((s) => s.resolved);
  // Read for their changes; the resolved values below fill in the defaults.
  useTerminalStore((s) => s.fontFamily);
  useTerminalStore((s) => s.fontSize);
  useTerminalStore((s) => s.fontLigatures);
  const palette = TERMINAL_PALETTES[themeId];
  const colors = useMemo<Colors>(
    () => ({
      sixteen: sixteenOf(palette),
      foreground: palette.foreground ?? "#ffffff",
      // The palette's is clear, over the island's surface: inverse text takes that.
      background: "var(--surface-island-bg)",
    }),
    [palette],
  );
  const lines = useMemo(() => text.trimEnd().split("\n"), [text]);
  const ref = useRef<HTMLPreElement>(null);
  // Kept at the end, as a terminal is, unless the user scrolled up to read.
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new text keeps the end in sight
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  const toEnd = () => {
    const el = ref.current;
    stuck.current = true;
    setAway(false);
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX;
          stuck.current = atEnd;
          setAway(!atEnd);
        }}
        // The room around the text a terminal here has (.xterm's padding).
        className="app-scrollbar absolute inset-0 m-0 overflow-auto whitespace-pre py-1.5 pr-3 pl-3 selection:bg-(--remote-terminal-selection)"
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
          // biome-ignore lint/suspicious/noArrayIndexKey: a terminal's lines are their rows
          <Line key={i} text={line} colors={colors} end={i === lines.length - 1} />
        ))}
      </pre>
      {away && (
        <button
          type="button"
          onClick={toEnd}
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
