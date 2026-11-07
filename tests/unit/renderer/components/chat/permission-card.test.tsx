/**
 * The card an agent's request shows in: the tool and its call with the
 * answers, the key on the button Enter presses, and what "always allow"
 * would add; a question's options with their number keys; a plan with its
 * approval.
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

const rule = (ruleContent: string) => ({
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent }],
  behavior: "allow",
  destination: "localSettings",
});

/** The text of the page's buttons, keys and all. */
function buttons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

describe("a tool's request", () => {
  it("names the tool, shows the call, and marks Allow as the Enter key's", () => {
    const html = render({
      description: "Build and run the tests",
      input: { command: "bun run build && bun test" },
      suggestions: [rule("bun run build && bun test")],
    });
    expect(html).toContain(">Bash<");
    expect(html).toContain("Build and run the tests");
    expect(html).not.toContain("wants to use");
    expect(buttons(html)).toEqual(["Deny", "Always allow", "Allow ↵"]);
    // What "always allow" adds shows on hover, not under the buttons.
    expect(html).toContain('title="Bash(bun run build &amp;&amp; bun test)"');
  });

  it("shows a command of several lines whole: its first can hide the rest", () => {
    const html = render({ input: { command: "echo hi\ntouch made.txt\n" } });
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("echo hi\ntouch made.txt");
    expect(html).toContain('title="echo hi\ntouch made.txt"');
    expect(html).toContain("whitespace-pre-wrap");
    // One line still fits its row.
    expect(render({ input: { command: "ls" } })).not.toContain("whitespace-pre-wrap");
  });

  it("offers each rule alone only when there are several", () => {
    const one = render({ input: { command: "ls" }, suggestions: [rule("ls")] });
    expect(one).not.toContain("Always allow just one");
    const several = render({
      input: { command: "ls" },
      suggestions: [rule("ls"), { type: "addDirectories", directories: ["/w/src"] }],
    });
    expect(several).toContain('aria-label="Always allow just one"');
    expect(several).toContain('title="Bash(ls) · Allow /w/src"');
  });

  it("has no Always allow when nothing would be added", () => {
    expect(buttons(render({ input: { command: "ls" } }))).toEqual(["Deny", "Allow ↵"]);
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

describe("questions", () => {
  const questions = {
    questions: [
      {
        question: "Count sessions started in a terminal?",
        header: "Scope",
        options: [
          { label: "Count them", description: "What the hooks tell" },
          { label: "Leave them out" },
        ],
      },
      {
        question: "Which OS to test on?",
        header: "OS",
        multiSelect: true,
        options: [{ label: "macOS" }, { label: "Windows" }, { label: "Linux" }],
      },
    ],
  };

  it("shows one question at a time, its options numbered, the last number for another answer", () => {
    const html = render({ toolName: "AskUserQuestion", input: questions });
    expect(html).toContain('role="tablist"');
    expect(html).toContain(">Scope<");
    expect(html).toContain(">OS<");
    expect(html).toContain("Count sessions started in a terminal?");
    expect(html).not.toContain("Which OS to test on?");
    const keys = [...html.matchAll(/<kbd[^>]*>(.*?)<\/kbd>/g)].map((m) => m[1]);
    expect(keys).toEqual(["1", "2", "3", "↵"]);
  });

  it("sends only once every question has an answer, and counts them", () => {
    const html = render({ toolName: "AskUserQuestion", input: questions });
    const send = html.match(/<button[^>]*type="submit"[^>]*>.*?<\/button>/)?.[0] ?? "";
    expect(send).toContain("disabled");
    expect(send).toContain("0/2");
    expect(send).toContain('aria-label="Send answers"');
  });
});

describe("a plan", () => {
  it("approves with Enter, accepting edits, and keeps the other approval in a menu", () => {
    const html = render({ toolName: "ExitPlanMode", input: { plan: "1. Do it" } });
    expect(html).toContain(">Plan<");
    expect(buttons(html)).toEqual(["Request changes", "Approve ↵", ""]);
    expect(html).toContain("Accept edits");
    expect(html).toContain('aria-label="Other ways to approve"');
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

  it("puts it in the message box when nothing waits", () => {
    const { tab, box, focused } = chatTab(false);
    focusChatTab(tab);
    expect(focused).toEqual(["box"]);
    expect(box.dataset.cardKeys).toBeUndefined();
  });

  it("does nothing without a tab", () => {
    expect(() => focusChatTab(null)).not.toThrow();
  });
});
