/** Whether an agent on another computer may do what it asks here. */
import { describe, expect, test } from "bun:test";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { AgentGate, relaySenderOf } from "../../../../../src/main/features/remote/agent-gate";
import type { RemoteAgentsPolicy } from "../../../../../src/shared/types/app-state";

const device = { id: "dev-1", name: "MacBook" };
const from = {
  kind: "tab" as const,
  agent: "claude",
  name: "Fix build",
  workspaceId: "bw",
  tabId: "bt",
  hops: 1,
};
const send = (over: Partial<typeof from> = {}, workspaceId = "w1") => ({
  device,
  method: "chat.send" as const,
  params: { workspaceId, tabId: "t1", text: "hi", from: { ...from, ...over } },
});

function gate(policy: RemoteAgentsPolicy, answers: string[] = []) {
  let now = 0;
  const asked: Record<string, unknown>[] = [];
  const services = {
    ui: async (op: string, args: Record<string, unknown>) => {
      if (op === "tabs.list") return { tabs: [{ id: "t1", type: "claude", title: "Review" }] };
      if (op === "consent.ask") {
        asked.push(args);
        return { answer: answers.shift() ?? "deny" };
      }
      if (op === "chat.state")
        return {
          agent: "claude",
          state: "asking",
          waiting: { kind: "permission", text: "Bash rm -rf dist" },
        };
      throw new Error(op);
    },
    claudeAsks: () => [],
  } as unknown as CliServices;
  const g = new AgentGate({ policy: () => policy, now: () => now });
  return { g, services, asked, later: (ms: number) => (now += ms) };
}

describe("an agent's request from another computer", () => {
  test("allowed, it goes; turned down, it is Forbidden", async () => {
    const allow = gate("allow");
    await allow.g.check(allow.services, send());
    expect(allow.asked).toEqual([]);
    const deny = gate("deny");
    await expect(deny.g.check(deny.services, send())).rejects.toMatchObject({
      code: 1002,
      message: expect.stringContaining("control by agents is off"),
    });
  });

  test("past the chain's length, it is refused whatever the setting", async () => {
    const { g, services } = gate("allow");
    await g.check(services, send({ hops: 8 }));
    await expect(g.check(services, send({ hops: 9 }))).rejects.toMatchObject({
      code: 1002,
      message: "the agents' chain is too long (8 messages): a loop?",
    });
  });

  test("twenty a minute from one agent; more wait for the minute to pass", async () => {
    const { g, services, later } = gate("allow");
    for (let i = 0; i < 20; i++) await g.check(services, send());
    await expect(g.check(services, send())).rejects.toMatchObject({
      code: 1003,
      message: "too many messages from that agent",
    });
    // Another agent of that computer has its own share.
    await g.check(services, send({ tabId: "other" }));
    later(60_000);
    await g.check(services, send());
  });

  test("asked about: the computer and tab it comes from, and what it would do", async () => {
    const { g, services, asked } = gate("ask", ["once", "deny", "timeout"]);
    await g.check(services, send());
    expect(asked[0]).toMatchObject({
      fromDevice: "MacBook",
      fromName: "Fix build",
      fromWorkspaceId: "bw",
      toWorkspaceId: "w1",
      change: { kind: "chatInput", detail: "Review" },
      timeoutMs: 90_000,
    });
    await expect(g.check(services, send())).rejects.toMatchObject({
      message: "the user there did not allow it",
    });
    await expect(g.check(services, send())).rejects.toMatchObject({
      message: expect.stringContaining("did not answer in time"),
    });
  });

  test("allowed until restart for that pair of workspaces; an answer each time", async () => {
    const { g, services, asked } = gate("ask", ["session", "once"]);
    await g.check(services, send());
    await g.check(services, send());
    expect(asked).toHaveLength(1);
    // Another workspace here is asked about again.
    await g.check(services, send({}, "w2"));
    expect(asked).toHaveLength(2);
    const answer = {
      device,
      method: "chat.answer" as const,
      params: { workspaceId: "w1", tabId: "t1", requestId: "r", decision: "allow", from },
    };
    await expect(g.check(services, answer)).rejects.toMatchObject({ code: 1002 });
    expect(asked.at(-1)).toMatchObject({
      change: { kind: "permissionAllow", detail: "Bash rm -rf dist" },
    });
  });

  test("typing into a terminal shows what it would type", async () => {
    const { g, services, asked } = gate("ask", ["once"]);
    await g.check(services, {
      device,
      method: "terminal.input",
      params: {
        workspaceId: "w1",
        tabId: "t1",
        text: "rm -rf dist",
        keys: ["ctrl-c"],
        enter: true,
        from,
      },
    });
    expect(asked[0]).toMatchObject({
      change: { kind: "terminalInput", body: "rm -rf dist<ctrl-c><enter>" },
    });
  });
});

test("the sender a chat keeps: who, on which computer, how far down the chain", () => {
  expect(relaySenderOf({ ...from, agent: "gemini" }, device)).toEqual({
    kind: "tab",
    name: "Fix build",
    workspaceId: "bw",
    tabId: "bt",
    device,
    hops: 1,
  });
});
