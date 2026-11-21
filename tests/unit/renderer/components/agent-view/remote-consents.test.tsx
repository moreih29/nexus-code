/**
 * Another computer's consent prompts in the agent view's list, told in the
 * words of this computer's own prompt: who asks to do what, all of what it
 * would run, the seconds left, and the answers it allows; or, where this
 * computer may not answer it, where to.
 */
import { describe, expect, test } from "bun:test";
import i18next from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteConsent } from "../../../../../packages/remote-protocol/src/rpc";

const { RemoteConsentCard, consentActionOf, consentSentenceOf } = await import(
  "../../../../../src/renderer/components/agent-view/remote-consents"
);

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

  test("a card: its question, all it would run, the seconds left, and the three answers", () => {
    const html = card(consent());
    expect(html).toContain("Allow an agent to change another workspace?");
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

  test("one asked about each time is not answered until restart", () => {
    const html = card(consent({ eachTime: true }));
    expect(html).not.toContain("Allow until restart");
    expect(html).toContain("Allow once");
    expect(html).toMatch(/data-variant="default"[^>]*hover:bg-primary\/90[^>]*>Allow once/);
  });

  test("one this computer may not answer says where to, with no answers", () => {
    const html = card(consent({ answerable: false }));
    expect(html).toContain("Answer it on Work PC");
    expect(html).not.toContain("Allow once");
  });

  test("one run out is gone", () => {
    expect(card(consent({ expiresInMs: 0 }))).toBe("");
  });
});
