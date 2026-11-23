/**
 * Making a chat.peek answer (since 0.27.0): its texts cut by code points,
 * a turn's tools counted, and the whole fitted in MAX_PEEK_BYTES, as
 * ChatPeekSchema says. A serving device builds its answer, then fits it.
 */
import {
  type ChatPeek,
  type ChatPeekTurn,
  MAX_PEEK_BYTES,
  MAX_PEEK_RECEIVED_TEXT,
  MAX_PEEK_REPLY,
  MAX_PEEK_SENDER,
  MAX_PEEK_STREAMING,
  MAX_PEEK_TOOL_NAME,
  MAX_PEEK_TOOLS,
  MAX_PEEK_TURNS,
  MAX_PEEK_USER_TEXT,
} from "./rpc.js";

const utf8 = new TextEncoder();
const bytesOf = (value: unknown) => utf8.encode(JSON.stringify(value)).length;

/**
 * The text in at most `max` characters (code points), its start kept: when
 * cut, it ends with "…", which counts in `max`.
 */
export function clipHead(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return max <= 0 ? "" : `${points.slice(0, max - 1).join("")}…`;
}

/**
 * The text in at most `max` characters (code points), its end kept: when
 * cut, it begins with "…", which counts in `max`.
 */
export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return max <= 0 ? "" : `…${points.slice(points.length - (max - 1)).join("")}`;
}

/**
 * A turn's tool calls, by the names their program gives them, in the order
 * they were called, counted as a peeked turn tells them: each name cut at
 * MAX_PEEK_TOOL_NAME (names cut alike count together), the MAX_PEEK_TOOLS
 * most called (a tie to the one called first), the rest's calls added up
 * in `otherTools`, left out when none.
 */
export function peekTools(names: Iterable<string>): Pick<ChatPeekTurn, "tools" | "otherTools"> {
  const counts = new Map<string, number>();
  for (const name of names) {
    if (name === "") continue;
    const key = clipHead(name, MAX_PEEK_TOOL_NAME);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // A Map keeps the order names first came in, and sort is stable.
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const tools: Record<string, number> = {};
  for (const [name, count] of ranked.slice(0, MAX_PEEK_TOOLS)) {
    // An own property, even for a name such as "__proto__".
    Object.defineProperty(tools, name, {
      value: count,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const others = ranked.slice(MAX_PEEK_TOOLS).reduce((sum, [, count]) => sum + count, 0);
  return others > 0 ? { tools, otherTools: others } : { tools };
}

/**
 * The answer with each text cut at its limit, and then fitted in
 * MAX_PEEK_BYTES: the oldest turns left out (with `more`), down to one;
 * then the last turn's `reply`, its `user.text`, `status.streaming` and
 * its `received.text` cut shorter, in that order, each as far as needed.
 * What is under the budget comes back as it was, but for the cuts.
 */
export function fitPeek(peek: ChatPeek): ChatPeek {
  // A copy as JSON has it (what is measured), without structuredClone, which not every runtime has.
  const out = JSON.parse(JSON.stringify(peek)) as ChatPeek;
  if (out.status.streaming !== undefined) {
    out.status.streaming = clipTail(out.status.streaming, MAX_PEEK_STREAMING);
  }
  if (out.turns.length > MAX_PEEK_TURNS) {
    out.turns = out.turns.slice(-MAX_PEEK_TURNS);
    out.more = true;
  }
  for (const turn of out.turns) {
    turn.reply = clipHead(turn.reply, MAX_PEEK_REPLY);
    if (turn.user) turn.user.text = clipHead(turn.user.text, MAX_PEEK_USER_TEXT);
    if (turn.received) {
      turn.received.from = clipHead(turn.received.from, MAX_PEEK_SENDER);
      turn.received.text = clipHead(turn.received.text, MAX_PEEK_RECEIVED_TEXT);
    }
  }
  while (bytesOf(out) > MAX_PEEK_BYTES && out.turns.length > 1) {
    out.turns.shift();
    out.more = true;
  }
  const turn = out.turns.at(-1);
  // The texts to cut shorter: how each is read and written, and whether its end is kept.
  const texts: [() => string | undefined, (text: string) => void, boolean][] = [];
  if (turn) {
    texts.push([
      () => turn.reply,
      (text) => {
        turn.reply = text;
      },
      false,
    ]);
    const user = turn.user;
    if (user) {
      texts.push([
        () => user.text,
        (text) => {
          user.text = text;
        },
        false,
      ]);
    }
  }
  texts.push([
    () => out.status.streaming,
    (text) => {
      out.status.streaming = text;
    },
    true,
  ]);
  const received = turn?.received;
  if (received) {
    texts.push([
      () => received.text,
      (text) => {
        received.text = text;
      },
      false,
    ]);
  }
  for (const [get, set, keepEnd] of texts) {
    if (bytesOf(out) <= MAX_PEEK_BYTES) break;
    const whole = get();
    if (!whole) continue;
    const clip = keepEnd ? clipTail : clipHead;
    // The longest that fits, found by halves; at least "…".
    let low = 1;
    let high = Array.from(whole).length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      set(clip(whole, mid));
      if (bytesOf(out) <= MAX_PEEK_BYTES) low = mid;
      else high = mid - 1;
    }
    set(clip(whole, low));
  }
  return out;
}
