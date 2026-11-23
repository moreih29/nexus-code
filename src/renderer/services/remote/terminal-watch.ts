import type { TerminalCaret, TerminalUpdate } from "../../../../packages/remote-protocol/src";
import type { TerminalController } from "../terminal/types";

export type TerminalChange = Omit<TerminalUpdate, "watchId" | "rev">;

export const UPDATES_PER_SECOND = 4;

export const MAX_TEXT_BYTES = 512 * 1024;

const encoder = new TextEncoder();

export function fitText(text: string, maxBytes = MAX_TEXT_BYTES): string {
  let shown = text;
  while (encoder.encode(shown).length > maxBytes) {
    const cut = shown.slice(Math.floor(shown.length / 4));
    const line = cut.indexOf("\n");
    shown = line >= 0 ? cut.slice(line + 1) : cut;
  }
  return shown;
}

export interface Screen {
  text: string;
  caret?: TerminalCaret;
}

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

export function screenChange(was: Screen, now: Screen): TerminalChange | null {
  const text = textChange(was.text, now.text);
  if (!text && sameCaret(was.caret, now.caret)) return null;
  const change = text ?? { start: was.text.length, text: "" };
  return now.caret ? { ...change, caret: now.caret } : change;
}

export function textChange(was: string, now: string): TerminalChange | null {
  if (was === now) return null;
  const max = Math.min(was.length, now.length);
  let start = 0;
  while (start < max && was.charCodeAt(start) === now.charCodeAt(start)) start++;
  const code = now.charCodeAt(start);
  if (start > 0 && code >= 0xdc00 && code <= 0xdfff) start--;
  return { start, text: now.slice(start) };
}

export function applyTextChange(was: string, change: TerminalChange): string {
  return was.slice(0, change.start) + change.text;
}

interface Watch {
  stop(): void;
}

const watches = new Map<string, Watch>();

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
