/**
 * The card an agent's request shows in: a command shown whole, what "always
 * allow" would add, and where the keyboard goes while a request waits.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import i18next from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import {
  focusChatTab,
  PermissionCard,
  scopesOf,
} from "../../../../../src/renderer/components/chat/permission-card";
import type { PermissionRequest } from "../../../../../src/renderer/services/chat/model";

function render(request: Partial<PermissionRequest>): string {
  return renderToStaticMarkup(
    <PermissionCard
      requests={[{ requestId: "r1", toolName: "Bash", input: {}, suggestions: [], ...request }]}
      workspaceId="w"
      cwd="/w"
      rootPath="/w"
      onAnswer={() => {}}
    />,
  );
}

describe("a tool's request", () => {
  it("shows a command of several lines whole: its first can hide the rest", () => {
    const html = render({ input: { command: "echo hi\ntouch made.txt\n" } });
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("echo hi\ntouch made.txt");
    expect(html).toContain('title="echo hi\ntouch made.txt"');
    expect(html).toContain("whitespace-pre-wrap");
    // One line still fits its row.
    expect(render({ input: { command: "ls" } })).not.toContain("whitespace-pre-wrap");
  });
});

describe("scopesOf", () => {
  it("describes each suggestion, and skips one it cannot", () => {
    const t = i18next.t.bind(i18next);
    const scopes = scopesOf(
      [
        {
          type: "addRules",
          rules: [{ toolName: "Read" }, { toolName: "Bash", ruleContent: "ls" }],
        },
        { type: "setMode", mode: "acceptEdits" },
        { type: "unknown" },
        { type: "session" },
      ],
      t,
    );
    expect(scopes.map((scope) => scope.label)).toEqual([
      "Read, Bash(ls)",
      i18next.t("chat.permission.suggest_mode", { mode: i18next.t("chat.mode.acceptEdits") }),
      i18next.t("chat.permission.suggest_session"),
    ]);
    expect(scopes[1].suggestion).toEqual({ type: "setMode", mode: "acceptEdits" });
  });
});

describe("focusChatTab", () => {
  /** A key as the page sends it; Bun has no KeyboardEvent of its own. */
  class Key extends Event {
    readonly key: string;
    readonly isComposing: boolean;
    readonly keyCode: number;
    constructor(type: string, init: { key: string; keyCode?: number; cancelable?: boolean }) {
      super(type, init);
      this.key = init.key;
      this.keyCode = init.keyCode ?? 0;
      this.isComposing = false;
    }
  }
  const g = globalThis as { KeyboardEvent?: unknown };
  const had = "KeyboardEvent" in g;
  beforeAll(() => {
    if (!had) g.KeyboardEvent = Key;
  });
  afterAll(() => {
    if (!had) delete g.KeyboardEvent;
  });

  /**
   * A chat tab with its message box, and a request waiting when `waiting`,
   * whose card takes Enter; what took the focus and the keys the card got.
   */
  function chatTab(waiting: boolean) {
    const focused: string[] = [];
    const got: string[] = [];
    const part = (name: string) =>
      Object.assign(new EventTarget(), {
        value: "",
        dataset: {} as Record<string, string>,
        isConnected: true,
        focus: () => focused.push(name),
      });
    const box = part("box");
    const card = part("card");
    card.addEventListener("keydown", (event) => {
      got.push((event as Key).key);
      if ((event as Key).key === "Enter") event.preventDefault();
    });
    const tab = {
      querySelector: (selector: string) =>
        selector.includes("chat-permission") ? (waiting ? card : null) : box,
    } as unknown as Element;
    const press = (key: string, keyCode?: number) => {
      const event = new Key("keydown", { key, keyCode, cancelable: true });
      box.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return { tab, box, focused, got, press };
  }

  it("keeps the keyboard in the message box and gives a waiting request its keys", () => {
    const { tab, box, focused, got, press } = chatTab(true);
    focusChatTab(tab);
    // A text field, where an IME stays on.
    expect(focused).toEqual(["box"]);
    expect(box.dataset.cardKeys).toBeDefined();
    expect(press("Enter")).toBe(true);
    expect(press("a")).toBe(false);
    expect(got).toEqual(["Enter", "a"]);
  });

  it("gives the box back its keys once the user types in it", () => {
    const { tab, box, got, press } = chatTab(true);
    focusChatTab(tab);
    // An IME's keys are its own, and what it types is the user's.
    press("Process", 229);
    box.dispatchEvent(new Event("input"));
    expect(box.dataset.cardKeys).toBeUndefined();
    expect(press("Enter")).toBe(false);
    expect(got).toEqual([]);
  });

  it("passes no key once the box has text or the user left it", () => {
    const typed = chatTab(true);
    focusChatTab(typed.tab);
    typed.box.value = "hi";
    typed.press("Enter");
    const left = chatTab(true);
    focusChatTab(left.tab);
    left.box.dispatchEvent(new Event("blur"));
    left.press("Enter");
    expect([...typed.got, ...left.got]).toEqual([]);
  });

  it("puts it in the request itself when the box has a draft, which Enter would send", () => {
    const { tab, box, focused } = chatTab(true);
    box.value = "a draft";
    focusChatTab(tab);
    expect(focused).toEqual(["card"]);
    expect(box.dataset.cardKeys).toBeUndefined();
  });
});
