import { describe, expect, it } from "bun:test";
import {
  NEWLINE_KEY,
  type TypingTarget,
  typedChunks,
  typeText,
} from "../../../../../src/renderer/services/sessions/typed-input";

describe("typedChunks", () => {
  it("types a short line as one piece", () => {
    expect(typedChunks("fix the login")).toEqual(["fix the login"]);
  });

  it("puts Ctrl+J between lines, whatever line endings the text has", () => {
    expect(typedChunks("one\ntwo\r\nthree\rfour")).toEqual([
      "one",
      NEWLINE_KEY,
      "two",
      NEWLINE_KEY,
      "three",
      NEWLINE_KEY,
      "four",
    ]);
  });

  it("keeps empty lines", () => {
    expect(typedChunks("a\n\nb")).toEqual(["a", NEWLINE_KEY, NEWLINE_KEY, "b"]);
  });

  it("splits a long line into pieces of at most 64 characters", () => {
    const chunks = typedChunks("x".repeat(150));
    expect(chunks.map((c) => c.length)).toEqual([64, 64, 22]);
    expect(chunks.join("")).toBe("x".repeat(150));
  });

  it("never splits a character outside the basic plane", () => {
    const chunks = typedChunks("😀".repeat(70));
    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0] ?? "")).toHaveLength(64);
    expect(chunks.join("")).toBe("😀".repeat(70));
  });

  it("keeps Korean text whole", () => {
    expect(typedChunks("로그인 고쳐줘")).toEqual(["로그인 고쳐줘"]);
  });

  it("turns tabs into spaces and drops other control characters", () => {
    expect(typedChunks("a\tb\u001b[201~c\u0003d\u007f")).toEqual(["a    b[201~cd"]);
  });
});

/** A terminal whose agent shows each piece when the test says so. */
function slowTerminal() {
  const log: string[] = [];
  let show: ((shown: boolean) => void) | null = null;
  const target: TypingTarget = {
    write: (text) => log.push(`write ${text.length}`),
    nextOutput: () => {
      log.push("wait");
      return new Promise((resolve) => {
        show = resolve;
      });
    },
  };
  const redraw = async (shown = true) => {
    show?.(shown);
    show = null;
    await Bun.sleep(30);
  };
  return { log, target, redraw };
}

describe("typeText", () => {
  it("types each piece after the agent has shown the one before", async () => {
    const { log, target, redraw } = slowTerminal();
    const typing = typeText(target, "x".repeat(150));
    await Bun.sleep(30);
    // A busy agent: the second piece waits, so the two never come as one read.
    expect(log).toEqual(["wait", "write 64"]);
    await redraw();
    expect(log).toEqual(["wait", "write 64", "wait", "write 64"]);
    await redraw();
    await redraw();
    await typing;
    expect(log).toEqual(["wait", "write 64", "wait", "write 64", "wait", "write 22"]);
  });

  it("listens before writing, so a redraw at once is not missed", async () => {
    const log: string[] = [];
    let pending: ((shown: boolean) => void) | null = null;
    const target: TypingTarget = {
      write: (text) => {
        log.push(`write ${text}`);
        pending?.(true);
      },
      nextOutput: () => {
        log.push("wait");
        return new Promise((resolve) => {
          pending = resolve;
        });
      },
    };
    await typeText(target, "a\nb");
    expect(log).toEqual(["wait", "write a", "wait", `write ${NEWLINE_KEY}`, "wait", "write b"]);
  });

  it("goes on when the agent does not redraw in time", async () => {
    const { log, target, redraw } = slowTerminal();
    const typing = typeText(target, "one\ntwo");
    await redraw(false);
    await redraw(false);
    await redraw(false);
    await typing;
    expect(log.filter((entry) => entry.startsWith("write"))).toHaveLength(3);
  });
});
