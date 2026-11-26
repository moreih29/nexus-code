import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import i18next from "i18next";
import { act, type MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteConsent, RemoteSession } from "../../../../../packages/remote-protocol/src/rpc";
import * as buttons from "../../../../../src/renderer/components/ui/button";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { ipcOk } from "../../../../../src/shared/ipc/result";
import { withTestDom } from "../../../../helpers/test-dom";

const {
  PeerConsentCard,
  RemoteConsentCard,
  CONSENT_SWAP_HOLD_MS,
  ConsentPages,
  consentActionOf,
  consentFromChat,
  consentHeadlineOf,
  consentSentenceOf,
  usePeerConsents,
} = await import("../../../../../src/renderer/components/agent-view/remote-consents");

const t = i18next.getFixedT("en", "settings");

const consent = (over: Partial<RemoteConsent> = {}): RemoteConsent => ({
  id: "c1",
  at: 1_000,
  expiresAt: 61_000,
  expiresInMs: 42_000,
  from: { workspaceId: "w-app", workspaceName: "app", tabId: "t-zsh", name: "zsh" },
  workspaceId: "w1",
  change: { kind: "terminalInput", detail: "dev", body: "rm -rf dist\nbun run build" },
  eachTime: false,
  answerable: true,
  ...over,
});

const card0 = (text: string) => <span key={text}>{text}</span>;

const card = (c: RemoteConsent) =>
  renderToStaticMarkup(
    <RemoteConsentCard
      consent={c}
      device="Work PC"
      workspaceName="api"
      onAnswer={() => Promise.resolve({ ok: true } as never)}
      onSettled={() => {}}
    />,
  );

describe("another computer's consent in the sidebar and chat", () => {
  test("matches the asking workspace and tab on the serving computer", () => {
    const from = { workspaceId: "w1", tabId: "t1" };
    const prompt = consent({ from, workspaceId: "other-workspace" });
    expect(consentFromChat(prompt, from)).toBe(true);
    expect(consentFromChat(prompt, { ...from, tabId: "t2" })).toBe(false);
    expect(consentFromChat(prompt, { ...from, workspaceId: "w2" })).toBe(false);
    expect(consentFromChat(consent({ from: { ...from, manager: true } }), from)).toBe(false);
    const device = { id: "d3", name: "Another PC" };
    expect(consentFromChat(consent({ from: { ...from, device } }), from)).toBe(false);
  });

  test("an answer clears both surfaces even if they still have the old list", async () => {
    const prompt = consent({ id: "shared-answer" });
    const sessions: RemoteSession[] = [
      { ...prompt.from, title: "Review", kind: "claude", state: "idle" },
    ];
    function Cards({ deviceId, inChat }: { deviceId: string; inChat?: boolean }) {
      return usePeerConsents(deviceId, [prompt])
        .filter((entry) => !inChat || consentFromChat(entry, prompt.from))
        .map((entry) => (
          <PeerConsentCard
            key={entry.id}
            consent={entry}
            deviceId={deviceId}
            device="Work PC"
            workspaceName="api"
            sessions={sessions}
          />
        ));
    }

    const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(ipcOk({}));
    const renderButton = spyOn(buttons, "Button");
    try {
      const sidebar = () => renderToStaticMarkup(<Cards deviceId="d2" />);
      const chat = () => renderToStaticMarkup(<Cards deviceId="d2" inChat />);
      expect(sidebar()).toContain("The Claude tab");
      renderButton.mockClear();
      expect(chat()).toContain("The Claude tab");
      const allow = renderButton.mock.calls.find(([props]) => props.children === "Allow")?.[0]
        .onClick;
      expect(allow).toBeDefined();
      allow?.({} as MouseEvent<HTMLButtonElement>);
      await Promise.resolve();
      expect(call).toHaveBeenCalledWith("remote", "peerConsentAnswer", {
        deviceId: "d2",
        id: prompt.id,
        answer: "once",
      });
      expect(sidebar()).toBe("");
      expect(chat()).toBe("");
      expect(renderToStaticMarkup(<Cards deviceId="d3" />)).toContain(">Allow<");
    } finally {
      renderButton.mockRestore();
      call.mockRestore();
    }
  });
});

describe("what another computer's consent prompt says", () => {
  test("shows the workspace and worktree with the host's conversation approval choices", () => {
    const scoped = consent({
      kind: "cross-workspace",
      scope: { workspaceName: "app", worktreeName: "review" },
      allowScopes: { once: "once", session: "chat-session" },
    });
    const html = card(scoped);
    expect(html).toContain("zsh → app · review");
    expect(html).toContain("Session approval covers app and its worktrees");
    expect(html).toContain(">Allow for session<");
    expect(html).toContain(">Allow once<");
    const once = card({ ...scoped, eachTime: true, allowScopes: { once: "once" } });
    expect(once).toContain("zsh → app · review");
    expect(once).toContain(">Allow<");
    expect(once).not.toContain("Session approval");
    expect(once).not.toContain(">Allow for session<");
  });

  test("what it would do, as this computer's prompt words it", () => {
    expect(consentActionOf(t, { kind: "tabClose", detail: "Review" })).toBe(
      'close the tab "Review"',
    );
    expect(consentActionOf(t, { kind: "teleport", detail: "x" })).toBe("make a change (teleport)");
  });

  test("who asks: a tab of a workspace there, another computer's agent, or the manager", () => {
    expect(consentSentenceOf(t, consent(), "api")).toBe(
      'The terminal "zsh" in app asks to type into the terminal "dev" in api.',
    );
    expect(
      consentSentenceOf(
        t,
        consent({ from: { device: { id: "d3", name: "Laptop" }, workspaceId: "x", tabId: "t" } }),
        "api",
      ),
    ).toBe('"t" on the computer Laptop asks to type into the terminal "dev" in api.');
    expect(
      consentSentenceOf(
        t,
        consent({ from: { manager: true, workspaceId: "w1", tabId: "m" } }),
        "api",
      ),
    ).toBe('The manager asks to type into the terminal "dev" in api.');
  });

  test.each([
    ["claude", "Claude"],
    ["codex", "Codex"],
  ] as const)("names a %s tab only when the workspace and tab IDs match", (kind, agent) => {
    const prompt = consent({
      from: { workspaceId: "w1", workspaceName: "app", tabId: "t1", name: "Review" },
    });
    const sender = { workspaceId: "w1", tabId: "t1", title: "Review", state: "idle" } as const;
    const sessions: RemoteSession[] = [
      { ...sender, workspaceId: "w2", kind: "terminal" },
      { ...sender, tabId: "t2", kind: "terminal" },
      { ...sender, kind },
    ];
    expect(consentSentenceOf(t, prompt, "api", sessions)).toContain(`The ${agent} tab "Review"`);
    expect(
      consentSentenceOf(i18next.getFixedT("ko", "settings"), prompt, "api", sessions),
    ).toContain(`app의 ${agent} 탭 "Review":`);
    expect(consentSentenceOf(t, prompt, "api", sessions.slice(0, 2))).toContain(
      'The terminal "Review"',
    );
  });

  test("a card: what it would do, who asks, what it would run, and the answers", () => {
    const html = card(consent());
    expect(html).toContain('aria-label="Allow an agent to change another workspace?"');
    expect(html).toContain('class="rounded-(--radius-raised) border border-border border-l-2');
    expect(html).toMatch(
      /<span class="font-semibold[^"]*">Type into the terminal &quot;dev&quot;<\/span>/,
    );
    expect(html).toContain(">zsh → api<");
    expect(html).toContain(
      '<p class="sr-only">The terminal &quot;zsh&quot; in app asks to type into the terminal &quot;dev&quot; in api.</p>',
    );
    expect(html).toMatch(/aria-expanded="true"[^>]*>rm -rf dist\nbun run build<\/button>/);
    expect(html).not.toContain("It is turned down if not answered");
    expect(html).toMatch(/>Deny<\/button>.*>Allow<\/button>.*aria-label="Allow options"/s);
    expect(html).not.toContain("Allow once");
    expect(html).not.toContain("remote-consent-there");
  });

  test("among several computers' prompts a card names the computer it is on", () => {
    const placed = (c: RemoteConsent) =>
      renderToStaticMarkup(
        <RemoteConsentCard
          consent={c}
          device="Work PC"
          workspaceName="api"
          showDevice
          onAnswer={() => Promise.resolve({ ok: true } as never)}
          onSettled={() => {}}
        />,
      );
    const tags = (html: string) =>
      [
        ...html.matchAll(
          /data-testid="session-row-device"><svg[\s\S]*?<\/svg><span class="truncate">([^<]*)</g,
        ),
      ].map((match) => match[1]);
    expect(tags(card(consent()))).toEqual([]);
    expect(tags(placed(consent()))).toEqual(["Work PC"]);
    expect(placed(consent())).toContain(">zsh → api<");
    const device = { id: "d3", name: "Laptop" };
    const from = { ...consent().from, device };
    expect(tags(card(consent({ from })))).toEqual(["Laptop"]);
    const both = placed(consent({ from }));
    expect(tags(both)).toEqual(["Laptop", "Work PC"]);
    expect(both).toMatch(/>zsh →<.*>Work PC<.*>api</s);
    const manager = { workspaceId: "w-app", tabId: "t-m", manager: true };
    expect(tags(placed(consent({ from: manager })))).toEqual(["Work PC"]);
  });

  test("headlines come from their own keys, the question when a kind has none", () => {
    const ko = i18next.getFixedT("ko", "settings");
    expect(consentHeadlineOf(ko, { kind: "terminalInput", detail: "dev" }, "")).toBe(
      '터미널 "dev"에 입력',
    );
    expect(consentHeadlineOf(t, { kind: "teleport" }, "Question?")).toBe("Question?");
    expect(consentHeadlineOf(t, { kind: "chatRewind", detail: "Review" }, "")).toBe(
      "Rewind the tab Review to before that message",
    );
    expect(consentHeadlineOf(ko, { kind: "chatRewind", detail: "Review" }, "")).toBe(
      "탭 Review 되감기(그 메시지 전으로)",
    );
  });

  test("its question follows what it asks, as the prompt's does", () => {
    expect(card(consent({ change: { kind: "permissionAllow", detail: "Bash" } }))).toContain(
      "Answer another session&#x27;s permission request?",
    );
  });

  test.each([
    ["terminalInput", "Allow an agent on another computer to change this one?"],
    ["permissionAllow", "Answer another session&#x27;s permission request?"],
  ])("a remote %s request uses the local dialog's title selection", (kind, title) => {
    const from = {
      ...consent().from,
      device: { id: "d3", name: "Laptop" },
    };
    const html = card(consent({ from, change: { kind } }));
    expect(html).toContain(`aria-label="${title}"`);
    expect(html).toContain("Laptop");
  });

  test("instruction prompts use the viewer's language and name the layer", () => {
    const change = {
      kind: "instructionsEdit",
      instructionEdit: {
        layer: { kind: "profile", agent: "claude", name: "default", id: "claude-default" },
        clear: true,
      },
      detail: "Old display text",
      body: "이전 표시 문구",
    } as const satisfies RemoteConsent["change"];
    const prompt = consent({ change });
    expect(consentActionOf(i18next.getFixedT("ko", "settings"), change)).toBe(
      'Claude 프로필 "default" 지시 바꾸기를',
    );
    expect(consentSentenceOf(t, prompt, "api")).toBe(
      'The terminal "zsh" in app asks to change instructions for Claude profile "default".',
    );
    const html = card(prompt);
    expect(html).toContain("Allow an agent to change instructions?");
    expect(html).toContain("Clear instructions");
    expect(html).not.toContain(change.body);
    const duplicate = {
      ...change,
      instructionEdit: {
        ...change.instructionEdit,
        layer: { ...change.instructionEdit.layer, showId: true },
      },
    };
    expect(consentActionOf(t, duplicate)).toBe(
      'change instructions for Claude profile "default" (claude-default)',
    );
  });

  test("one asked about each time offers Deny and Allow, with no other choices", () => {
    const html = card(consent({ eachTime: true }));
    expect(html).toContain(">Deny</button>");
    expect(html).not.toContain("Allow options");
    expect(html).toMatch(/data-variant="default"[^>]*hover:bg-primary\/90[^>]*>Allow<\/button>/);
  });

  test("sandbox approval asks its question as the headline, with the same choices", () => {
    const change = { kind: "sandboxExecution", body: "nexus terminal new" };
    const html = card(consent({ change }));
    expect(html).toContain('aria-label="Let an agent run a command outside its sandbox?"');
    expect(html).toMatch(/font-semibold[^"]*">Run a command outside its sandbox</);
    expect(html).toMatch(/>Deny<\/button>.*>Allow<\/button>.*Allow options/s);
    expect(card(consent({ change, eachTime: true }))).not.toContain("Allow options");
  });

  test("one this computer may not answer says where to, with no answers", () => {
    const html = card(consent({ answerable: false }));
    expect(html).toContain("Answer it on Work PC");
    expect(html).not.toContain(">Deny<");
    expect(html).not.toContain(">Allow<");
  });

  test("one past its expiresAt still shows until the list leaves it out", () => {
    const html = card(consent({ expiresInMs: 0 }));
    expect(html).toContain(">Allow<");
    expect(html).not.toContain("seconds");
  });

  test("several in one place show one at a time, with a pager", () => {
    const one = renderToStaticMarkup(<ConsentPages place="p">{[card0("a")]}</ConsentPages>);
    expect(one).not.toContain("remote-consent-pages");
    const two = renderToStaticMarkup(
      <ConsentPages place="p">{[card0("a"), card0("b")]}</ConsentPages>,
    );
    expect(two).toContain("1 of 2");
    expect(two).toContain('aria-label="Previous request"');
    expect(two).toContain(">a<");
    expect(two).not.toContain(">b<");
  });
});

describe("several consent prompts in one place", () => {
  const prompt = (id: string) =>
    consent({ id, eachTime: true, change: { kind: "chatInput", detail: id.toUpperCase() } });

  let run = 0;
  beforeEach(() => {
    run += 1;
  });

  function Pages({
    ids,
    answers,
    pending = false,
    change,
  }: {
    ids: string[];
    answers: string[];
    pending?: boolean;
    change?: RemoteConsent["change"];
  }) {
    if (ids.length === 0) return null;
    return (
      <ConsentPages place={`pages-${run}`}>
        {ids.map((id) => (
          <RemoteConsentCard
            key={id}
            consent={change ? { ...prompt(id), change } : prompt(id)}
            device="Work PC"
            workspaceName="api"
            onAnswer={(answer) => {
              answers.push(`${id}:${answer}`);
              return pending ? new Promise(() => {}) : Promise.resolve(ipcOk({}));
            }}
            onSettled={() => {}}
          />
        ))}
      </ConsentPages>
    );
  }

  const headline = (host: HTMLElement) => host.querySelector(".font-semibold")?.textContent;
  const page = (host: HTMLElement) =>
    host.querySelector('[data-testid="remote-consent-pages"] span')?.textContent;
  const find = (host: HTMLElement, label: string) => {
    const button = Array.from(host.querySelectorAll("button")).find(
      (node) => node.textContent === label || node.getAttribute("aria-label") === label,
    );
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
  };
  const press = async (host: HTMLElement, label: string) => {
    const button = find(host, label);
    await act(async () => button.click());
  };
  const clickWith = async (host: HTMLElement, label: string, detail: number) => {
    const button = find(host, label);
    const event = document.createEvent("MouseEvent");
    event.initEvent("click", true, true);
    Object.defineProperty(event, "detail", { value: detail });
    await act(async () => {
      button.dispatchEvent(event);
    });
  };

  test("the card in view stays when a new prompt arrives before or after it", async () => {
    await withTestDom(async (host, root) => {
      const answers: string[] = [];
      await act(async () => root.render(<Pages ids={["a", "b"]} answers={answers} />));
      await press(host, "Next request");
      expect(headline(host)).toContain('"B"');
      await act(async () => root.render(<Pages ids={["c", "a", "b"]} answers={answers} />));
      expect(headline(host)).toContain('"B"');
      expect(page(host)).toBe("3 of 3");
      await act(async () => root.render(<Pages ids={["c", "a", "b", "d"]} answers={answers} />));
      expect(headline(host)).toContain('"B"');
      expect(page(host)).toBe("3 of 4");
      await act(async () => root.render(<Pages ids={["c", "a", "d"]} answers={answers} />));
      expect(headline(host)).toContain('"D"');
      await act(async () => root.render(<Pages ids={["c", "a"]} answers={answers} />));
      expect(headline(host)).toContain('"A"');
    });
  });

  test("a card that takes the place of one gone elsewhere ignores answers for a moment", async () => {
    const now = spyOn(performance, "now").mockReturnValue(10_000);
    try {
      await withTestDom(async (host, root) => {
        const answers: string[] = [];
        await act(async () => root.render(<Pages ids={["a", "b"]} answers={answers} />));
        await act(async () => root.render(<Pages ids={["b"]} answers={answers} />));
        expect(headline(host)).toContain('"B"');
        await press(host, "Allow");
        expect(answers).toEqual([]);
        now.mockReturnValue(10_000 + CONSENT_SWAP_HOLD_MS);
        await press(host, "Allow");
        expect(answers).toEqual(["b:once"]);
      });
    } finally {
      now.mockRestore();
    }
  });

  test("no pause after the user answers one or pages to another", async () => {
    const now = spyOn(performance, "now").mockReturnValue(10_000);
    try {
      await withTestDom(async (host, root) => {
        const answers: string[] = [];
        await act(async () => root.render(<Pages ids={["a", "b", "c"]} answers={answers} />));
        await press(host, "Allow");
        await act(async () => root.render(<Pages ids={["b", "c"]} answers={answers} />));
        expect(headline(host)).toContain('"B"');
        await press(host, "Deny");
        expect(answers).toEqual(["a:once", "b:deny"]);
        await act(async () => root.render(<Pages ids={["c", "d"]} answers={answers} />));
        await act(async () => {
          now.mockReturnValue(10_000 + CONSENT_SWAP_HOLD_MS);
        });
        await press(host, "Next request");
        expect(headline(host)).toContain('"D"');
        await press(host, "Allow");
        expect(answers).toEqual(["a:once", "b:deny", "d:once"]);
      });
    } finally {
      now.mockRestore();
    }
  });

  test("a prompt that comes right after the one in view went away elsewhere is held too", async () => {
    const now = spyOn(performance, "now").mockReturnValue(10_000);
    try {
      await withTestDom(async (host, root) => {
        const answers: string[] = [];
        await act(async () => root.render(<Pages ids={["a"]} answers={answers} />));
        await act(async () => root.render(<Pages ids={[]} answers={answers} />));
        now.mockReturnValue(10_050);
        await act(async () => root.render(<Pages ids={["b"]} answers={answers} />));
        now.mockReturnValue(10_100);
        await press(host, "Allow");
        expect(answers).toEqual([]);
        now.mockReturnValue(10_000 + CONSENT_SWAP_HOLD_MS);
        await press(host, "Allow");
        expect(answers).toEqual(["b:once"]);
      });
    } finally {
      now.mockRestore();
    }
  });

  test("a prompt after one the user answered and that then left is not held", async () => {
    const now = spyOn(performance, "now").mockReturnValue(10_000);
    try {
      await withTestDom(async (host, root) => {
        const answers: string[] = [];
        await act(async () => root.render(<Pages ids={["a"]} answers={answers} />));
        await press(host, "Allow");
        await act(async () => root.render(<Pages ids={[]} answers={answers} />));
        await act(async () => root.render(<Pages ids={["b"]} answers={answers} />));
        await press(host, "Allow");
        expect(answers).toEqual(["a:once", "b:once"]);
      });
    } finally {
      now.mockRestore();
    }
  });

  test("the card in view keeps its state when a second prompt arrives", async () => {
    await withTestDom(async (host, root) => {
      const answers: string[] = [];
      const change = { kind: "terminalInput", detail: "dev", body: "a\nb" } as const;
      await act(async () =>
        root.render(<Pages ids={["a"]} answers={answers} change={change} pending />),
      );
      const deny = find(host, "Deny");
      await press(host, "Allow");
      expect(answers).toEqual(["a:once"]);
      await act(async () =>
        root.render(<Pages ids={["a", "b"]} answers={answers} change={change} pending />),
      );
      expect(deny.isConnected).toBe(true);
      expect(deny.disabled).toBe(true);
      await press(host, "Allow");
      await press(host, "Deny");
      expect(answers).toEqual(["a:once"]);
      await act(async () =>
        root.render(<Pages ids={["a"]} answers={answers} change={change} pending />),
      );
      expect(deny.isConnected).toBe(true);
    });
  });

  test("the second click of a double click answers nothing, a key press does", async () => {
    await withTestDom(async (host, root) => {
      const answers: string[] = [];
      await act(async () => root.render(<Pages ids={["a", "b"]} answers={answers} />));
      await clickWith(host, "Allow", 2);
      expect(answers).toEqual([]);
      await clickWith(host, "Deny", 0);
      expect(answers).toEqual(["a:deny"]);
      await act(async () => root.render(<Pages ids={["b"]} answers={answers} />));
      await clickWith(host, "Allow", 1);
      expect(answers).toEqual(["a:deny", "b:once"]);
    });
  });
});

describe("what another computer's prompt would run", () => {
  const shownBody = (host: HTMLElement) =>
    host.querySelector<HTMLButtonElement>("button[aria-expanded]");

  async function cardWith(body: string, widths?: { scroll: number; client: number }) {
    let result: { expanded: string | null | undefined; className: string | undefined } = {
      expanded: undefined,
      className: undefined,
    };
    await withTestDom(async (host, root) => {
      const proto = Object.getPrototypeOf(document.createElement("button"));
      const saved = ["scrollWidth", "clientWidth"].map(
        (name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
      );
      if (widths) {
        Object.defineProperty(proto, "scrollWidth", {
          configurable: true,
          get: () => widths.scroll,
        });
        Object.defineProperty(proto, "clientWidth", {
          configurable: true,
          get: () => widths.client,
        });
      }
      try {
        await act(async () =>
          root.render(
            <RemoteConsentCard
              consent={consent({ change: { kind: "terminalInput", detail: "dev", body } })}
              device="Work PC"
              workspaceName="api"
              onAnswer={() => Promise.resolve(ipcOk({}))}
              onSettled={() => {}}
            />,
          ),
        );
        result = {
          expanded: shownBody(host)?.getAttribute("aria-expanded"),
          className: shownBody(host)?.className,
        };
      } finally {
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(proto, name, descriptor);
          else Reflect.deleteProperty(proto, name);
        }
      }
    });
    return result;
  }

  test("a command of several lines shows whole, scrolling past the chat card's height", async () => {
    const shown = await cardWith("echo ok\nrm -rf ~");
    expect(shown.expanded).toBe("true");
    expect(shown.className).toContain("max-h-40 overflow-auto whitespace-pre-wrap");
  });

  test("a one-line command opens when it does not fit, and stays on one line when it does", async () => {
    expect((await cardWith("x".repeat(400), { scroll: 900, client: 200 })).expanded).toBe("true");
    const fits = await cardWith("bun run build", { scroll: 120, client: 200 });
    expect(fits.expanded).toBe("false");
    expect(fits.className).toContain("whitespace-nowrap");
  });
});
