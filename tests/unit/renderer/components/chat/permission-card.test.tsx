import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import i18next from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import {
  focusChatTab,
  nextUnanswered,
  PermissionCard,
  scopesOf,
} from "../../../../../src/renderer/components/chat/permission-card";
import type { PermissionRequest } from "../../../../../src/renderer/services/chat/model";

function render(request: Partial<PermissionRequest>, planModeOptions?: boolean): string {
  return renderToStaticMarkup(
    <PermissionCard
      requests={[{ requestId: "r1", toolName: "Bash", input: {}, suggestions: [], ...request }]}
      workspaceId="w"
      cwd="/w"
      rootPath="/w"
      {...(planModeOptions !== undefined ? { planModeOptions } : {})}
      onAnswer={() => {}}
    />,
  );
}

describe("plan approval", () => {
  it("offers a single approval when the session cannot choose a permission mode", () => {
    const plan = { toolName: "ExitPlanMode", input: {} };
    const dropdown = i18next.t("chat.plan.approve_other");
    const simple = render(plan, false);
    expect(simple).toContain(i18next.t("chat.plan.approve"));
    expect(simple).toContain(i18next.t("chat.plan.request_changes"));
    expect(simple).not.toContain(dropdown);
    expect(simple).not.toContain(i18next.t("chat.plan.accept_edits"));
    expect(render(plan)).toContain(`aria-label="${dropdown}"`);
    expect(render(plan, true)).toContain(`aria-label="${dropdown}"`);
  });
});

describe("a tool's request", () => {
  it("shows a command of several lines whole: its first can hide the rest", () => {
    const html = render({ input: { command: "echo hi\ntouch made.txt\n" } });
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("echo hi\ntouch made.txt");
    expect(html).toContain('title="echo hi\ntouch made.txt"');
    expect(html).toContain("whitespace-pre-wrap");
    expect(render({ input: { command: "ls" } })).not.toContain("whitespace-pre-wrap");
  });
});

describe("the questions", () => {
  const question = (name: string, multiSelect = false) => ({
    question: `${name}?`,
    header: name,
    multiSelect,
    options: [{ label: "yes" }, { label: "no" }],
  });

  it("go on to the next without an answer, from the first past the last", () => {
    expect(nextUnanswered([true, true, true], 0)).toBe(1);
    expect(nextUnanswered([true, false, true], 0)).toBe(2);
    expect(nextUnanswered([true, false, false], 2)).toBe(0);
    expect(nextUnanswered([false, true, false], 1)).toBe(-1);
    expect(nextUnanswered([false, false], 0)).toBe(-1);
    expect(nextUnanswered([true], 0)).toBe(-1);
  });

  it("show a button to the next while another waits, and send once none does", () => {
    const next = i18next.t("chat.question.next");
    const send = i18next.t("chat.question.submit");
    const several = render({
      toolName: "AskUserQuestion",
      input: { questions: [question("Port", true), question("Host")] },
    });
    expect(several).toContain(next);
    expect(several).not.toContain(send);
    const one = render({ toolName: "AskUserQuestion", input: { questions: [question("Port")] } });
    expect(one).toContain(send);
    expect(one).not.toContain(next);
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
      i18next.t("chat.permission.suggest_mode", {
        mode: i18next.t("agentConfig.claude.permissionMode.acceptEdits"),
      }),
      i18next.t("chat.permission.suggest_session"),
    ]);
    expect(scopes[1].suggestion).toEqual({ type: "setMode", mode: "acceptEdits" });
  });
});

describe("focusChatTab", () => {
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
    expect(focused).toEqual(["box"]);
    expect(box.dataset.cardKeys).toBeDefined();
    expect(press("Enter")).toBe(true);
    expect(press("a")).toBe(false);
    expect(got).toEqual(["Enter", "a"]);
  });

  it("gives the box back its keys once the user types in it", () => {
    const { tab, box, got, press } = chatTab(true);
    focusChatTab(tab);
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
