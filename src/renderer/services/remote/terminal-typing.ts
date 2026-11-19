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
const MAX_WAITING_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

/** A new input could not be queued without exceeding the pending byte budget. */
export class TerminalInputQueueFullError extends Error {
  readonly code = "terminal-input-queue-full";

  constructor() {
    super("Remote terminal input queue exceeds 1 MiB");
  }
}

interface QueuedInput {
  input: TypedInput;
  bytes: number;
}

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
  private waiting: QueuedInput[] = [];
  private waitingBytes = 0;
  private sending = false;
  private disposed = false;

  constructor(
    private readonly send: (input: TypedInput) => Promise<void>,
    private readonly failed: (error: unknown) => void,
  ) {}

  /** Queues input in send order, retaining accepted input when a new one will not fit. */
  type(input: TypedInput): void {
    if (this.disposed || (!input.text && !input.keys?.length)) return;
    const text = input.text ?? "";
    const available = MAX_WAITING_BYTES - this.waitingBytes;
    // A very large paste already exceeds the budget even before UTF-8 encoding.
    if (text.length > available) {
      this.failed(new TerminalInputQueueFullError());
      return;
    }
    const keyBytes = input.keys?.reduce((bytes, key) => bytes + key.length, 0) ?? 0;
    const bytes = encoder.encode(text).byteLength + keyBytes;
    if (bytes > available) {
      this.failed(new TerminalInputQueueFullError());
      return;
    }
    // An input must also fit one terminal.input request so it cannot fail
    // after earlier queued inputs have been accepted.
    if (text.length > MAX_TEXT || (input.keys?.length ?? 0) > MAX_KEYS) {
      this.failed(new Error("Remote terminal input exceeds one request"));
      return;
    }
    const last = this.waiting.at(-1);
    const both = last && joined(last.input, input);
    if (last && both) {
      last.input = both;
      last.bytes += bytes;
    } else {
      this.waiting.push({ input, bytes });
    }
    this.waitingBytes += bytes;
    void this.flush();
  }

  /** Ends this connection's queue and reports whether unsent input was discarded. */
  dispose(): boolean {
    this.disposed = true;
    const hadWaiting = this.waiting.length > 0;
    this.clearWaiting();
    return hadWaiting;
  }

  /** Releases queued inputs and restores the full budget. */
  private clearWaiting(): void {
    this.waiting = [];
    this.waitingBytes = 0;
  }

  /** Keeps exactly one request in flight and drains accepted inputs in order. */
  private async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let next = this.waiting.shift(); next; next = this.waiting.shift()) {
        this.waitingBytes -= next.bytes;
        await this.send(next.input);
      }
    } catch (error) {
      // What waited after it would go in out of its place.
      this.clearWaiting();
      if (!this.disposed) this.failed(error);
    } finally {
      this.sending = false;
    }
  }
}
