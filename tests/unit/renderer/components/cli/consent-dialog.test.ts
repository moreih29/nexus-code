/** A consent prompt answered on another device of the user's comes down here, saying so. */
import { describe, expect, test } from "bun:test";
import {
  askCliConsent,
  describeConsent,
  settleCliConsent,
} from "../../../../../src/renderer/components/cli/consent-dialog";
import { type ToastInput, watchToasts } from "../../../../../src/renderer/components/ui/toast";

const prompt = (id?: string) => ({
  ...(id ? { id } : {}),
  fromWorkspace: "app",
  fromTab: "zsh",
  toWorkspace: "api",
  change: { kind: "chatInput" as const, detail: "Review" },
  timeoutMs: 60_000,
});

describe("settling a consent prompt from another device", () => {
  test("the prompt resolves to that answer, and a toast names the device", async () => {
    const toasts: ToastInput[] = [];
    const stop = watchToasts((t) => toasts.push(t));
    try {
      const first = askCliConsent(prompt("c1"));
      const second = askCliConsent(prompt("c2"));
      // One waiting its turn is settled too.
      expect(settleCliConsent("c2", "deny", "iPhone")).toBe(true);
      expect(await second).toBe("deny");
      expect(settleCliConsent("c1", "session", "iPhone")).toBe(true);
      expect(await first).toBe("session");
      expect(toasts).toHaveLength(2);
      expect(toasts.map((t) => t.kind)).toEqual(["info", "info"]);
    } finally {
      stop();
    }
  });

  test("one no longer waiting is not settled, and tells no one", async () => {
    const toasts: ToastInput[] = [];
    const stop = watchToasts((t) => toasts.push(t));
    try {
      const asked = askCliConsent(prompt("c3"));
      expect(settleCliConsent("c3", "once")).toBe(true);
      expect(await asked).toBe("once");
      expect(settleCliConsent("c3", "deny", "iPhone")).toBe(false);
      expect(settleCliConsent("gone", "once", "iPhone")).toBe(false);
      // Settled without a device's name: no toast.
      expect(toasts).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe("who a consent prompt says asks", () => {
  const t = (key: string, values: Record<string, string>) => `${key} ${JSON.stringify(values)}`;

  test("a terminal is told as one", () => {
    expect(describeConsent(t, prompt(), "send")).toBe(
      'agentCli.consent.description {"tab":"zsh","from":"app","to":"api","action":"send"}',
    );
  });

  test("a Claude or Codex tab is told as that agent's tab, not a terminal", () => {
    expect(
      describeConsent(t, { ...prompt(), fromTab: "Review", fromAgent: "claude" }, "send"),
    ).toBe(
      'agentCli.consent.agent_description {"agent":"Claude","tab":"Review","from":"app","to":"api","action":"send"}',
    );
    expect(describeConsent(t, { ...prompt(), fromAgent: "codex" }, "send")).toContain(
      '"agent":"Codex"',
    );
  });

  test("another computer's agent is told by that computer", () => {
    expect(
      describeConsent(t, { ...prompt(), fromDevice: "Mac", fromAgent: "claude" }, "send"),
    ).toBe(
      'agentCli.consent.remote_description {"device":"Mac","tab":"zsh","to":"api","action":"send"}',
    );
  });
});
