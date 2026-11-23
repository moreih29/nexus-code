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

export function clipHead(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return max <= 0 ? "" : `${points.slice(0, max - 1).join("")}…`;
}

export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return max <= 0 ? "" : `…${points.slice(points.length - (max - 1)).join("")}`;
}

export function peekTools(names: Iterable<string>): Pick<ChatPeekTurn, "tools" | "otherTools"> {
  const counts = new Map<string, number>();
  for (const name of names) {
    if (name === "") continue;
    const key = clipHead(name, MAX_PEEK_TOOL_NAME);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const tools: Record<string, number> = {};
  for (const [name, count] of ranked.slice(0, MAX_PEEK_TOOLS)) {
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

export function fitPeek(peek: ChatPeek): ChatPeek {
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
