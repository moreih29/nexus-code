/**
 * A terminal another device of the account watches (terminal.watch): its
 * text when the watch begins, then what changed of it as the program
 * writes, at most UPDATES_PER_SECOND times a second. What changed is sent
 * from where the text first differs, so a redraw at the bottom sends only
 * the bottom. With `ansi`, the cursor goes with it, and a move of the
 * cursor alone is sent too.
 */

import type { TerminalCaret, TerminalUpdate } from "../../../../packages/remote-protocol/src";
import type { TerminalController } from "../terminal/types";

/** What a watch sends: an update but for its id and rev, which main gives it. */
export type TerminalChange = Omit<TerminalUpdate, "watchId" | "rev">;

/** How often a watched terminal's changes are sent at most. */
export const UPDATES_PER_SECOND = 4;

/**
 * Most bytes of text a watch keeps (UTF-8), its end: well inside a
 * frame, with room for the update around it.
 */
export const MAX_TEXT_BYTES = 512 * 1024;

const encoder = new TextEncoder();

/** The end of `text`, as much as goes in `maxBytes` of UTF-8, starting at a line. */
export function fitText(text: string, maxBytes = MAX_TEXT_BYTES): string {
  let shown = text;
  while (encoder.encode(shown).length > maxBytes) {
    const cut = shown.slice(Math.floor(shown.length / 4));
    const line = cut.indexOf("\n");
    shown = line >= 0 ? cut.slice(line + 1) : cut;
  }
  return shown;
}

/** A terminal as a watch sends it: its text, and its cursor, unless hidden or not asked for. */
export interface Screen {
  text: string;
  caret?: TerminalCaret;
}

/**
 * The screen with its text cut as fitText cuts it, the cursor going up with
 * the lines cut; one above them, or in a line cut in two, is not told.
 */
export function fitScreen(screen: Screen, maxBytes = MAX_TEXT_BYTES): Screen {
  const text = fitText(screen.text, maxBytes);
  if (text === screen.text) return screen;
  const cut = screen.text.slice(0, screen.text.length - text.length);
  const line = (screen.caret?.line ?? -1) - (cut.split("\n").length - 1);
  return screen.caret && cut.endsWith("\n") && line >= 0
    ? { text, caret: { line, column: screen.caret.column } }
    : { text };
}

function sameCaret(a: TerminalCaret | undefined, b: TerminalCaret | undefined): boolean {
  return a?.line === b?.line && a?.column === b?.column;
}

/**
 * What changed from `was` to `now`, with the cursor as it is now: the text
 * as textChange tells it, or none (`start` at its end) when only the
 * cursor moved; null when neither changed.
 */
export function screenChange(was: Screen, now: Screen): TerminalChange | null {
  const text = textChange(was.text, now.text);
  if (!text && sameCaret(was.caret, now.caret)) return null;
  const change = text ?? { start: was.text.length, text: "" };
  return now.caret ? { ...change, caret: now.caret } : change;
}

/** What changed from `was` to `now`: from where they first differ; null when nothing did. */
export function textChange(was: string, now: string): TerminalChange | null {
  if (was === now) return null;
  const max = Math.min(was.length, now.length);
  let start = 0;
  while (start < max && was.charCodeAt(start) === now.charCodeAt(start)) start++;
  // Not between the halves of a surrogate pair.
  const code = now.charCodeAt(start);
  if (start > 0 && code >= 0xdc00 && code <= 0xdfff) start--;
  return { start, text: now.slice(start) };
}

/** The text a change makes of `was`. */
export function applyTextChange(was: string, change: TerminalChange): string {
  return was.slice(0, change.start) + change.text;
}

interface Watch {
  stop(): void;
}

const watches = new Map<string, Watch>();

/**
 * Starts watching a terminal for another device: its last `lines` lines
 * now, then `push` with each change, until stopTerminalWatch or the
 * terminal is gone (`onGone`); with `ansi`, the text has its colors and
 * styles, and the cursor comes with it.
 */
export function startTerminalWatch(
  watchId: string,
  controller: TerminalController,
  lines: number,
  push: (change: TerminalChange) => void,
  onGone: () => void,
  ansi = false,
): Screen {
  stopTerminalWatch(watchId);
  const read = () =>
    fitScreen(ansi ? controller.readScreen(lines) : { text: controller.readText(lines) });
  let sent = read();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;

  const flush = () => {
    timer = null;
    last = Date.now();
    const now = read();
    const change = screenChange(sent, now);
    sent = now;
    if (change) push(change);
  };
  const off = controller.onOutput((ended) => {
    if (ended) {
      stop();
      onGone();
      return;
    }
    if (timer) return;
    const wait = Math.max(0, last + 1000 / UPDATES_PER_SECOND - Date.now());
    timer = setTimeout(flush, wait);
  });
  const stop = () => {
    off();
    if (timer) clearTimeout(timer);
    watches.delete(watchId);
  };
  watches.set(watchId, { stop });
  return sent;
}

export function stopTerminalWatch(watchId: string): void {
  watches.get(watchId)?.stop();
}
