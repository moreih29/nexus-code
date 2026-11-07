/**
 * The card an agent's request shows in: the tool and its call with the
 * answers, the key on the button Enter presses, and what "always allow"
 * would add; a question's options with their number keys; a plan with its
 * approval.
 */

import { describe, expect, it } from "bun:test";
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
  /** A chat tab with its message box, and a request waiting when `waiting`; what took focus. */
  function chatTab(waiting: boolean): { tab: Element; focused: string[] } {
    const focused: string[] = [];
    const part = (name: string) => ({ focus: () => focused.push(name) });
    const tab = {
      querySelector: (selector: string) =>
        selector.includes("chat-permission")
          ? waiting
            ? part("card")
            : null
          : selector.includes("chat-composer")
            ? part("box")
            : null,
    } as unknown as Element;
    return { tab, focused };
  }

  it("puts the keyboard in a request waiting on the user, so Enter answers it", () => {
    const { tab, focused } = chatTab(true);
    focusChatTab(tab);
    expect(focused).toEqual(["card"]);
  });

  it("puts it in the message box when nothing waits", () => {
    const { tab, focused } = chatTab(false);
    focusChatTab(tab);
    expect(focused).toEqual(["box"]);
  });

  it("does nothing without a tab", () => {
    expect(() => focusChatTab(null)).not.toThrow();
  });
});
