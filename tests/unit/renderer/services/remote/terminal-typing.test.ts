/**
 * Typing into another device's terminal: key presses as its keys, and what
 * is typed sent in order, joined while a send is on its way.
 */
import { describe, expect, test } from "bun:test";
import {
  TerminalTyping,
  type TypedInput,
  terminalKeyOf,
} from "../../../../../src/renderer/services/remote/terminal-typing";

const press = (
  key: string,
  mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {},
) =>
  terminalKeyOf({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("a key press", () => {
  test("is the terminal key it stands for", () => {
    expect(press("Enter")).toBe("enter");
    expect(press("Escape")).toBe("esc");
    expect(press("Tab")).toBe("tab");
    expect(press("Tab", { shiftKey: true })).toBe("shift-tab");
    expect(press("ArrowUp")).toBe("up");
    expect(press("PageDown")).toBe("pagedown");
    expect(press("c", { ctrlKey: true })).toBe("ctrl-c");
    expect(press("R", { ctrlKey: true, shiftKey: true })).toBe("ctrl-r");
  });

  test("types text, or is the app's", () => {
    expect(press("a")).toBeNull();
    expect(press("한")).toBeNull();
    expect(press("c", { metaKey: true })).toBeNull();
    expect(press("Enter", { altKey: true })).toBeNull();
    expect(press("1", { ctrlKey: true })).toBeNull();
    expect(press("Tab", { ctrlKey: true })).toBeNull();
  });
});

describe("typing", () => {
  function typing() {
    const sent: TypedInput[] = [];
    const errors: unknown[] = [];
    let release: (() => void)[] = [];
    let fail = false;
    const t = new TerminalTyping(
      (input) => {
        sent.push(input);
        return new Promise<void>((resolve, reject) => {
          release.push(() => (fail ? reject(new Error("gone")) : resolve()));
        });
      },
      (error) => errors.push(error),
    );
    const settle = async () => {
      const now = release;
      release = [];
      for (const r of now) r();
      await Promise.resolve();
    };
    return { t, sent, errors, settle, failNext: () => (fail = true) };
  }

  test("sends at once, and joins what is typed meanwhile, in order", async () => {
    const { t, sent, settle } = typing();
    t.type({ text: "l" });
    t.type({ text: "s" });
    t.type({ text: " -a" });
    t.type({ keys: ["enter"] });
    expect(sent).toEqual([{ text: "l" }]);
    await settle();
    expect(sent).toEqual([{ text: "l" }, { text: "s -a", keys: ["enter"] }]);
    await settle();
    expect(sent).toHaveLength(2);
  });

  test("keeps text typed after keys for a send of its own", async () => {
    const { t, sent, settle } = typing();
    t.type({ keys: ["esc"] });
    t.type({ keys: ["up"] });
    t.type({ keys: ["left"] });
    t.type({ text: "x" });
    t.type({ keys: ["enter"] });
    await settle();
    await settle();
    expect(sent).toEqual([
      { keys: ["esc"] },
      { keys: ["up", "left"] },
      { text: "x", keys: ["enter"] },
    ]);
  });

  test("keeps typed text and a paste apart, each as it came", async () => {
    const { t, sent, settle } = typing();
    t.type({ text: "a", typed: true });
    t.type({ text: "b", typed: true });
    t.type({ text: "c", typed: true });
    t.type({ text: "pasted" });
    t.type({ text: "d", typed: true });
    t.type({ keys: ["enter"] });
    for (let i = 0; i < 4; i++) await settle();
    expect(sent).toEqual([
      { text: "a", typed: true },
      { text: "bc", typed: true },
      { text: "pasted" },
      { text: "d", typed: true, keys: ["enter"] },
    ]);
  });

  test("drops what waited when a send fails, and tells it", async () => {
    const { t, sent, errors, settle, failNext } = typing();
    t.type({ text: "a" });
    t.type({ text: "b" });
    failNext();
    await settle();
    expect(errors).toHaveLength(1);
    expect(sent).toEqual([{ text: "a" }]);
    t.type({ text: "c" });
    expect(sent.at(-1)).toEqual({ text: "c" });
  });

  test("caps queued UTF-8 text and keys at one MiB and keeps accepted input in order", async () => {
    const { t, sent, errors, settle } = typing();
    t.type({ text: "in flight" });
    const text = Array.from({ length: 15 }, (_, i) => String.fromCharCode(0xc0 + i).repeat(32768));
    text.push("x".repeat(65531));
    for (const chunk of text) t.type({ text: chunk });
    t.type({ keys: ["enter"] });
    t.type({ text: "blocked" });

    expect(errors).toEqual([expect.objectContaining({ code: "terminal-input-queue-full" })]);
    expect(sent).toEqual([{ text: "in flight" }]);

    await settle();
    t.type({ text: "accepted after draining", keys: ["end"] });
    for (let i = 0; i < 18; i += 1) await settle();
    expect(
      sent
        .slice(1, -1)
        .map((input) => input.text)
        .join(""),
    ).toBe(text.join(""));
    expect(sent.at(-2)?.keys).toEqual(["enter"]);
    expect(sent.at(-1)).toEqual({ text: "accepted after draining", keys: ["end"] });
  });

  test("sends nothing for nothing", () => {
    const { t, sent } = typing();
    t.type({ text: "" });
    t.type({ keys: [] });
    expect(sent).toEqual([]);
  });
});
