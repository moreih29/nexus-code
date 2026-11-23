/**
 * Making a chat.peek answer: texts cut by code points, a turn's tools
 * counted, and the whole fitted in MAX_PEEK_BYTES.
 */
import { describe, expect, test } from "bun:test";
import {
  type ChatPeek,
  ChatPeekSchema,
  clipHead,
  clipTail,
  fitPeek,
  MAX_PEEK_BYTES,
  MAX_PEEK_REPLY,
  MAX_PEEK_STREAMING,
  MAX_PEEK_TURNS,
  MAX_PEEK_USER_TEXT,
  peekTools,
} from "../../../../packages/remote-protocol/src";

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const points = (text: string) => Array.from(text).length;
/** No half of a character outside the BMP stands alone. */
const whole = (text: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

describe("clipHead and clipTail", () => {
  test("a text within its limit stays as it is", () => {
    expect(clipHead("hello", 5)).toBe("hello");
    expect(clipTail("hello", 5)).toBe("hello");
    // Five emoji are ten UTF-16 units, five characters.
    expect(clipHead("😀".repeat(5), 5)).toBe("😀".repeat(5));
  });

  test("a longer one keeps its start, or its end, and the ellipsis counts", () => {
    expect(clipHead("abcdef", 4)).toBe("abc…");
    expect(clipTail("abcdef", 4)).toBe("…def");
    expect(clipHead("abcdef", 1)).toBe("…");
    expect(clipHead("abcdef", 0)).toBe("");
  });

  test("a character outside the BMP is never cut in two", () => {
    const cut = clipHead("😀😀😀", 2);
    expect(cut).toBe("😀…");
    expect(clipTail("😀😀😀", 2)).toBe("…😀");
    expect(whole(cut)).toBe(true);
  });
});

describe("peekTools", () => {
  test("counts by name, the most called first, a tie to the one called first", () => {
    expect(peekTools(["Read", "Bash", "Edit", "Bash", "Read", "Grep"])).toEqual({
      tools: { Read: 2, Bash: 2, Edit: 1, Grep: 1 },
    });
    expect(Object.keys(peekTools(["Read", "Bash", "Bash"]).tools)).toEqual(["Bash", "Read"]);
  });

  test("keeps the 8 most called and adds up the rest", () => {
    const names = ["a", "a", "a", "b", "b", "c", "d", "e", "f", "g", "h", "i", "j", "j"];
    const counted = peekTools(names);
    expect(Object.keys(counted.tools)).toEqual(["a", "b", "j", "c", "d", "e", "f", "g"]);
    expect(counted.otherTools).toBe(2);
  });

  test("none counts no tool, and leaves otherTools out", () => {
    expect(peekTools([])).toEqual({ tools: {} });
    expect(peekTools([""])).toEqual({ tools: {} });
  });

  test("a long name is cut, and names cut alike count together", () => {
    const long = "mcp__server__".padEnd(80, "x");
    const counted = peekTools([long, `${long}y`]);
    const [name] = Object.keys(counted.tools);
    expect(points(name)).toBe(64);
    expect(counted.tools[name]).toBe(2);
  });

  test("a name such as __proto__ is counted, and the answer still reads", () => {
    const counted = peekTools(["__proto__", "Bash"]);
    expect(Object.keys(counted.tools)).toEqual(["__proto__", "Bash"]);
    expect(JSON.stringify(counted.tools)).toBe('{"__proto__":1,"Bash":1}');
    // A record's reader checks such an entry, then drops it (wireRecord).
    const turn = { reply: "", ...counted };
    const parsed = ChatPeekSchema.parse({ status: { running: false }, turns: [turn] });
    expect(parsed.turns[0].tools).toEqual({ Bash: 1 });
  });
});

describe("fitPeek", () => {
  const korean = (n: number) => "가".repeat(n);
  const turn = (text: string, reply: string) => ({
    user: { text, images: 0 },
    reply,
    tools: { Bash: 3, Edit: 1 },
  });

  test("an answer within the budget comes back as it was", () => {
    const peek: ChatPeek = {
      status: { running: false, phase: "idle" },
      turns: [turn("Fix it", "Fixed."), turn("Thanks", "Any time.")],
    };
    expect(fitPeek(peek)).toEqual(peek);
  });

  test("cuts each text at its own limit first", () => {
    const fitted = fitPeek({
      status: { running: true, streaming: `start ${"b".repeat(MAX_PEEK_STREAMING)} end` },
      turns: [turn("a".repeat(MAX_PEEK_USER_TEXT + 10), "c".repeat(MAX_PEEK_REPLY + 10))],
    });
    const [last] = fitted.turns;
    expect(points(last.user?.text ?? "")).toBe(MAX_PEEK_USER_TEXT);
    expect(last.user?.text.endsWith("…")).toBe(true);
    expect(points(last.reply)).toBe(MAX_PEEK_REPLY);
    expect(points(fitted.status.streaming ?? "")).toBe(MAX_PEEK_STREAMING);
    expect(fitted.status.streaming?.startsWith("…")).toBe(true);
    expect(fitted.status.streaming?.endsWith(" end")).toBe(true);
    expect(fitted.more).toBeUndefined();
    expect(ChatPeekSchema.safeParse(fitted).success).toBe(true);
  });

  test("Korean turns at their limits: the oldest go, with more", () => {
    const peek: ChatPeek = {
      status: { running: false, phase: "ready" },
      turns: [1, 2, 3].map(() => turn(korean(1000), korean(2000))),
    };
    expect(bytesOf(peek)).toBeGreaterThan(MAX_PEEK_BYTES);
    const fitted = fitPeek(peek);
    expect(bytesOf(fitted)).toBeLessThanOrEqual(MAX_PEEK_BYTES);
    expect(fitted.turns).toHaveLength(1);
    expect(fitted.more).toBe(true);
    // One turn at its limits fits (9,000 bytes of text): nothing more is cut.
    expect(fitted.turns[0]).toEqual(peek.turns[2]);
    expect(ChatPeekSchema.safeParse(fitted).success).toBe(true);
  });

  test("one turn still over: the reply is cut first, then the user's text, then the reply being written", () => {
    const peek: ChatPeek = {
      status: { running: true, phase: "ready", streaming: "😀".repeat(MAX_PEEK_STREAMING) },
      turns: [
        {
          user: { text: "😀".repeat(MAX_PEEK_USER_TEXT), images: 1, files: 2 },
          reply: "😀".repeat(MAX_PEEK_REPLY),
          tools: { Bash: 1 },
        },
      ],
      waiting: { kind: "permission", tool: "Bash" },
    };
    // 4,000 emoji of 4 bytes each, and their escapes: over the budget.
    expect(bytesOf(peek)).toBeGreaterThan(MAX_PEEK_BYTES);
    const fitted = fitPeek(peek);
    const bytes = bytesOf(fitted);
    expect(bytes).toBeLessThanOrEqual(MAX_PEEK_BYTES);
    // As long as fits: one more character would not.
    expect(bytes).toBeGreaterThan(MAX_PEEK_BYTES - 8);
    const [last] = fitted.turns;
    expect(last.reply.endsWith("…")).toBe(true);
    expect(points(last.reply)).toBeLessThan(MAX_PEEK_REPLY);
    // The reply alone was enough: the rest stays.
    expect(last.user?.text).toBe(peek.turns[0].user?.text);
    expect(fitted.status.streaming).toBe(peek.status.streaming);
    expect(whole(last.reply)).toBe(true);
    expect(ChatPeekSchema.safeParse(fitted).success).toBe(true);
  });

  test("texts that escape in JSON count as they are sent", () => {
    const control = "\u0001".repeat(MAX_PEEK_REPLY);
    const fitted = fitPeek({
      status: { running: false },
      turns: [
        {
          user: { text: "\u0002".repeat(MAX_PEEK_USER_TEXT), images: 0 },
          reply: control,
          tools: {},
        },
      ],
    });
    expect(bytesOf(fitted)).toBeLessThanOrEqual(MAX_PEEK_BYTES);
    expect(ChatPeekSchema.safeParse(fitted).success).toBe(true);
  });

  test("more turns than a peek gives keep the last ones", () => {
    const peek: ChatPeek = {
      status: { running: false },
      turns: Array.from({ length: MAX_PEEK_TURNS + 2 }, (_, i) => turn(`q${i}`, `a${i}`)),
    };
    const fitted = fitPeek(peek);
    expect(fitted.turns.map((t) => t.reply)).toEqual(["a2", "a3", "a4", "a5", "a6"]);
    expect(fitted.more).toBe(true);
  });

  test("leaves the answer it was given alone", () => {
    const peek: ChatPeek = { status: { running: false }, turns: [turn("q", "a".repeat(3000))] };
    fitPeek(peek);
    expect(peek.turns[0].reply).toHaveLength(3000);
  });
});
