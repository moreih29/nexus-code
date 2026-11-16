// Typing into another device's terminal (terminal.input): a key press as
// the terminal key it stands for, and what is typed, sent in order. What
// is typed while a send is on its way waits and goes with the next one, so
// a fast typist's keys go in a few sends, not one each.

import type { TerminalKey } from "../../../../packages/remote-protocol/src/rpc";

export interface TypedInput {
  text?: string;
  /** The text typed, which goes in as keystrokes; without it, pasted. */
  typed?: boolean;
  keys?: TerminalKey[];
}

/** Most keys a send takes (terminal.input's keys), and most text. */
const MAX_KEYS = 64;
const MAX_TEXT = 64 * 1024;

const NAMED: Record<string, TerminalKey> = {
  Enter: "enter",
  Escape: "esc",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

/**
 * The terminal key a key press stands for: Enter, Tab, Esc, the arrows and
 * the like, and Control with a letter. Null for one that types text (it
 * comes as input), and for Command's, which are the app's.
 */
export function terminalKeyOf(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): TerminalKey | null {
  if (event.metaKey || event.altKey) return null;
  if (event.ctrlKey) {
    const letter = event.key.length === 1 ? event.key.toLowerCase() : "";
    return /^[a-z]$/.test(letter) ? (`ctrl-${letter}` as TerminalKey) : null;
  }
  if (event.key === "Tab") return event.shiftKey ? "shift-tab" : "tab";
  return NAMED[event.key] ?? null;
}

/** Whether `next` can go in the same send as `last`, after it: text then keys, as a send types them. */
function joined(last: TypedInput, next: TypedInput): TypedInput | null {
  const keys = [...(last.keys ?? []), ...(next.keys ?? [])];
  if (keys.length > MAX_KEYS) return null;
  if (next.text) {
    // Text after keys would go in before them; typed text and a paste go in as they came.
    if (last.keys?.length) return null;
    if (last.text && !last.typed !== !next.typed) return null;
    const text = (last.text ?? "") + next.text;
    if (text.length > MAX_TEXT) return null;
    return { text, ...(next.typed ? { typed: true } : {}), ...(keys.length ? { keys } : {}) };
  }
  return {
    ...(last.text ? { text: last.text } : {}),
    ...(last.typed ? { typed: true } : {}),
    keys,
  };
}

export class TerminalTyping {
  private waiting: TypedInput[] = [];
  private sending = false;

  constructor(
    private readonly send: (input: TypedInput) => Promise<void>,
    private readonly failed: (error: unknown) => void,
  ) {}

  type(input: TypedInput): void {
    if (!input.text && !input.keys?.length) return;
    const last = this.waiting.at(-1);
    const both = last ? joined(last, input) : null;
    if (both) this.waiting[this.waiting.length - 1] = both;
    else this.waiting.push(input);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let next = this.waiting.shift(); next; next = this.waiting.shift()) {
        await this.send(next);
      }
    } catch (error) {
      // What waited after it would go in out of its place.
      this.waiting = [];
      this.failed(error);
    } finally {
      this.sending = false;
    }
  }
}
