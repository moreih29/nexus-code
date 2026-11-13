/**
 * A terminal another device of the account watches (terminal.watch): its
 * text when the watch begins, then what changed of it as the program
 * writes, at most UPDATES_PER_SECOND times a second. What changed is sent
 * from where the text first differs, so a redraw at the bottom sends only
 * the bottom.
 */

import type { TerminalUpdate } from "../../../../packages/remote-protocol/src";
import { getTerminalController } from "../terminal/terminal-registry";

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
 * terminal is gone (`onGone`). Throws when it has not started.
 */
export function startTerminalWatch(
  watchId: string,
  tabId: string,
  lines: number,
  push: (change: TerminalChange) => void,
  onGone: () => void,
): { text: string } {
  stopTerminalWatch(watchId);
  const controller = getTerminalController(tabId);
  if (!controller) throw new Error("that terminal has not started");
  const read = () => fitText(controller.readText(lines));
  let sent = read();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;

  const flush = () => {
    timer = null;
    last = Date.now();
    const now = read();
    const change = textChange(sent, now);
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
  return { text: sent };
}

export function stopTerminalWatch(watchId: string): void {
  watches.get(watchId)?.stop();
}
