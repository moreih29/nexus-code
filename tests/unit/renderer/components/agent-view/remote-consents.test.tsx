/**
 * Another computer's consent prompts in the agent view's list, told in the
 * words of this computer's own prompt: who asks to do what, all of what it
 * would run, the seconds left, and the answers it allows; or, where this
 * computer may not answer it, where to.
 */
import { describe, expect, spyOn, test } from "bun:test";
import i18next from "i18next";
import type { MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteConsent, RemoteSession } from "../../../../../packages/remote-protocol/src/rpc";
import * as buttons from "../../../../../src/renderer/components/ui/button";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { ipcOk } from "../../../../../src/shared/ipc/result";

const {
  PeerConsentCard,
  RemoteConsentCard,
  consentActionOf,
  consentFromChat,
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
      const allow = renderButton.mock.calls.at(-1)?.[0].onClick;
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
      expect(renderToStaticMarkup(<Cards deviceId="d3" />)).toContain("Allow once");
    } finally {
      renderButton.mockRestore();
      call.mockRestore();
    }
  });
});

describe("what another computer's consent prompt says", () => {
  test("what it would do, as this computer's prompt words it", () => {
    expect(consentActionOf(t, { kind: "tabClose", detail: "Review" })).toBe(
      'close the tab "Review"',
    );
    // A kind this version does not know is named as it came.
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
    ).toContain(`app의 ${agent} 탭 "Review"이(가)`);
    expect(consentSentenceOf(t, prompt, "api", sessions.slice(0, 2))).toContain(
      'The terminal "Review"',
    );
  });

  test("a card: its question, all it would run, the seconds left, and the three answers", () => {
    const html = card(consent());
    expect(html).toContain("Allow an agent to change another workspace?");
    expect(html).toMatch(/<p class="[^"]*break-keep \[overflow-wrap:anywhere\][^"]*">The terminal/);
    expect(html).toContain("rm -rf dist\nbun run build");
    // The body scrolls, as the prompt's box does.
    expect(html).toMatch(/<pre class="[^"]*overflow-auto/);
    expect(html).toContain("It is turned down if not answered in 42 seconds.");
    expect(html).toContain("Don&#x27;t allow");
    expect(html).toContain("Allow until restart");
    expect(html).toContain("Allow once");
    expect(html).not.toContain("remote-consent-there");
  });

  test("its question follows what it asks, as the prompt's does", () => {
    expect(card(consent({ change: { kind: "permissionAllow", detail: "Bash" } }))).toContain(
      "Answer another session&#x27;s permission request?",
    );
  });

  test("a request from another computer uses the remote title", () => {
    const from = {
      ...consent().from,
      device: { id: "d3", name: "Laptop" },
    };
    for (const kind of ["terminalInput", "permissionAllow"]) {
      const html = card(consent({ from, change: { kind } }));
      expect(html).toContain('aria-label="Allow an agent on another computer to change this one?"');
      expect(html).toContain("Laptop");
    }
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

  test("one asked about each time offers Don't allow and Allow", () => {
    const html = card(consent({ eachTime: true }));
    expect(html).toContain("Don&#x27;t allow</button>");
    expect(html).not.toContain("Allow until restart");
    expect(html).not.toContain("Allow once");
    expect(html).toMatch(/data-variant="default"[^>]*hover:bg-primary\/90[^>]*>Allow<\/button>/);
  });

  test("sandbox approval offers the same choices in the same order", () => {
    const change = { kind: "sandboxExecution", body: "nexus terminal new" };
    const html = card(consent({ change }));
    expect(html).toContain("Let an agent run a command outside its sandbox?");
    expect(html).toMatch(/Don&#x27;t allow.*Allow until restart.*Allow once/s);
    expect(card(consent({ change, eachTime: true }))).not.toContain("Allow until restart");
  });

  test("one this computer may not answer says where to, with no answers", () => {
    const html = card(consent({ answerable: false }));
    expect(html).toContain("Answer it on Work PC");
    expect(html).not.toContain("<button");
  });

  test("one run out is gone", () => {
    expect(card(consent({ expiresInMs: 0 }))).toBe("");
  });
});
