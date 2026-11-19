/**
 * The model and effort picked in a Codex tab are the tab's, as a Claude
 * tab's are: the tab is told to keep them, and after a restart its chips
 * show them over the thread's own and its next turn is sent with them.
 * The real ipc client is spread under a spy, so later files keep its
 * other exports.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { CODEX_CONFIG_PROFILE_KEY } from "../../../../../src/renderer/services/chat/codex-config";

// The version the app tells Codex it is.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

type Message = Record<string, unknown> & { params?: Record<string, unknown> };
/** A Codex program that comes up, answering what is sent to it as the test says. */
let codex: ((message: Message) => void) | undefined;
/** Whether a Codex program fails to come up, as a fork's does when its thread cannot be read. */
let startFails = false;

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    if (method === "send") codex?.(args.message as Message);
    if (method === "codexStart") {
      return Promise.resolve({
        ok: true,
        value: startFails
          ? { ok: false, reason: "failed", message: "no thread to fork" }
          : { ok: true, pid: 1, attached: false, version: null },
      });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { CodexController, closeCodexTab, codexController } = await import(
  "../../../../../src/renderer/services/chat/codex-controller"
);
const { useChatStore } = await import("../../../../../src/renderer/services/chat/store");
const { chatHandlers } = await import("../../../../../src/renderer/services/cli/chat-actions");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
type Controller = InstanceType<typeof CodexController>;

let seq = 0;
let lineSeq = 1000;
const live: Controller[] = [];
const sent: Message[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  startFails = false;
  codex = undefined;
  sent.length = 0;
});

/**
 * A tab whose program comes up and goes on with thread "t1", which ran
 * on gpt-5.5 at high effort; every request is echoed and answered.
 */
function tab(
  chosen?: { model?: string; effort?: string },
  onChosen?: (pick: unknown) => void,
  configReply?: (
    message: Message,
  ) =>
    | { result?: unknown; error?: unknown }
    | Promise<{ result?: unknown; error?: unknown }>
    | undefined,
  ref?: { workspaceId: string; tabId: string },
) {
  const target = {
    workspaceId: "ws-codex-chosen",
    tabId: `c${++seq}`,
    ...ref,
    cwd: "/p",
    threadId: "t1",
    ...(chosen ? { chosen } : {}),
  };
  const hooks = onChosen ? { onChosen } : {};
  const c = ref ? codexController(target, hooks) : new CodexController(target, hooks);
  live.push(c);
  codex = (message) => {
    sent.push(message);
    if (message.id === undefined) return;
    const result =
      message.method === "thread/resume"
        ? { thread: { id: "t1" }, model: "gpt-5.5", reasoningEffort: "high" }
        : message.method === "thread/start"
          ? { thread: { id: "t2" }, model: "gpt-5.5", reasoningEffort: "high" }
          : message.method === "turn/start"
            ? { turn: { id: "turn-1" } }
            : message.method === "config/read"
              ? { config: {} }
              : {};
    queueMicrotask(async () => {
      if (message.method === "initialize") {
        c.receive({ seq: ++lineSeq, dir: "sys", message: { event: "start", pid: 1 } } as never);
      }
      c.receive({ seq: ++lineSeq, dir: "in", message } as never);
      c.receive({
        seq: ++lineSeq,
        dir: "out",
        message: { id: message.id, ...((await configReply?.(message)) ?? { result }) },
      } as never);
    });
  };
  // Its program is not running: what the tab does next starts it.
  useChatStore.getState().update(c.key, (prev) => ({ ...prev, phase: "ended" }));
  return c;
}

function shown(c: Controller): { model?: unknown; effort?: unknown } {
  const { model, effort } = c.state.model as Record<string, unknown>;
  return { model, effort };
}

describe("the model and effort picked in a Codex tab", () => {
  test("are told to the tab to keep", async () => {
    const picks: unknown[] = [];
    const c = tab(undefined, (pick) => picks.push(pick));
    await c.setModel("gpt-5.4-mini");
    await c.setEffort("low");
    expect(picks).toEqual([{ model: "gpt-5.4-mini" }, { effort: "low" }]);
    expect(c.inheritedChoice()).toEqual({ model: "gpt-5.4-mini", effort: "low" });
  });

  test("show over the thread's own once its program is back, and go with its next turn", async () => {
    const c = tab({ model: "gpt-5.4-mini", effort: "low" });
    await c.readDefaults();
    await Bun.sleep(40);
    expect(shown(c)).toEqual({ model: "gpt-5.4-mini", effort: "low" });
    await c.send("hi");
    const turn = sent.find((m) => m.method === "turn/start");
    expect(turn?.params).toMatchObject({ threadId: "t1", model: "gpt-5.4-mini", effort: "low" });
  });

  test("are forgotten once a turn takes them: the thread holds them from then on", async () => {
    const picks: unknown[] = [];
    const c = tab({ model: "gpt-5.4-mini" }, (pick) => picks.push(pick));
    await c.readDefaults();
    await Bun.sleep(40);
    await c.send("hi");
    expect(picks).toEqual([{}]);
    // A second turn has nothing of its own to send, nor to forget.
    await Bun.sleep(40);
    await c.send("again");
    const turns = sent.filter((m) => m.method === "turn/start");
    expect(turns[1]?.params?.model).toBeUndefined();
    expect(picks).toEqual([{}]);
  });

  test("leave a tab without a pick on the thread's", async () => {
    const c = tab();
    await c.readDefaults();
    await Bun.sleep(40);
    expect(shown(c)).toEqual({ model: "gpt-5.5", effort: "high" });
    await c.send("hi");
    const turn = sent.find((m) => m.method === "turn/start");
    expect(turn?.params?.model).toBeUndefined();
    expect(turn?.params?.effort).toBeUndefined();
  });
});

describe("the pick a Codex tab keeps", () => {
  test("goes on with its thread until a turn takes it, and not to another profile", () => {
    const tabs = () => useTabsStore.getState();
    const t = tabs().createTab("ws-codex-chosen-store", { type: "codex", props: { cwd: "/p" } });
    const props = () => tabs().byWorkspace["ws-codex-chosen-store"]?.[t.id]?.props;
    tabs().setChatChosen("ws-codex-chosen-store", t.id, { model: "gpt-5.4-mini" });
    tabs().setChatChosen("ws-codex-chosen-store", t.id, { effort: "low" });
    tabs().setCodexThread("ws-codex-chosen-store", t.id, "t1");
    expect(props()).toEqual({
      cwd: "/p",
      threadId: "t1",
      chosen: { model: "gpt-5.4-mini", effort: "low" },
    });
    tabs().setChatChosen("ws-codex-chosen-store", t.id, {});
    expect(props()).toEqual({ cwd: "/p", threadId: "t1" });
    tabs().setChatChosen("ws-codex-chosen-store", t.id, { effort: "low" });
    tabs().setChatProfile("ws-codex-chosen-store", t.id, "work");
    expect(props()).toEqual({ cwd: "/p", profileId: "work" });
  });
});

describe("delivering a Codex queue entry", () => {
  test("keeps a rejected prompt and its image recoverable without retrying it", async () => {
    let rejectDelivery!: (reply: { error: { code: number; message: string } }) => void;
    const delivery = new Promise<{ error: { code: number; message: string } }>((resolve) => {
      rejectDelivery = resolve;
    });
    const c = tab(undefined, undefined, ({ method, params }) =>
      method === "turn/start" && params?.clientUserMessageId === "peer-queued-id"
        ? delivery
        : undefined,
    );
    await c.sendPeer("first turn", [], "first-id");
    const images = [{ mediaType: "image/png", data: "image bytes" }];
    expect(c.enqueue("recover me", images, undefined, "phone", "queued-id")).toBe("queued-id");

    c.receive({
      seq: ++lineSeq,
      dir: "out",
      message: {
        method: "turn/completed",
        params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } },
      },
    } as never);
    c.flushNow();
    expect(c.state.queue).toMatchObject([{ id: "queued-id", status: "sending" }]);
    expect(c.removeQueued("queued-id")).toBeUndefined();
    expect(c.editQueued("queued-id", "changed")).toBe(false);
    rejectDelivery({ error: { code: -32602, message: "message rejected" } });
    await Bun.sleep(25);

    expect(c.state.queue).toMatchObject([
      {
        id: "queued-id",
        status: "failed",
        error: "message rejected",
        text: "recover me",
        images,
      },
    ]);
    expect(
      sent.filter(({ params }) => params?.clientUserMessageId === "peer-queued-id"),
    ).toHaveLength(1);
    expect(c.removeQueued("queued-id")).toMatchObject({ text: "recover me", images });
    expect(c.state.queue).toEqual([]);
  });
});

describe("saving Codex defaults", () => {
  function configFixture(failedWrite?: "okOverridden" | "conflict") {
    const config: Record<string, unknown> = {
      model: "gpt-5.5",
      model_reasoning_effort: "high",
      approval_policy: "on-request",
      sandbox_mode: "read-only",
      service_tier: null,
      web_search: "cached",
      model_auto_compact_token_limit: null,
    };
    let version = "before";
    const reply = ({ method, params }: Message) => {
      switch (method) {
        case "model/list":
          return {
            result: {
              data: [
                { model: "gpt-5.5", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
                { model: "gpt-a", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
              ],
            },
          };
        case "config/read":
          return {
            result: {
              config: { ...config },
              layers: [{ name: { type: "user", file: "/codex/config.toml" }, version }],
            },
          };
        case "configRequirements/read":
          return {
            result: { requirements: { allowedApprovalPolicies: ["on-request", "never"] } },
          };
        case "config/batchWrite":
          if (failedWrite === "okOverridden") return { result: { status: "okOverridden" } };
          if (failedWrite === "conflict")
            return { error: { code: -32600, message: "Configuration was modified" } };
          expect(params?.expectedVersion).toBe(version);
          expect(params?.filePath).toBe("/codex/config.toml");
          for (const { keyPath, value } of params?.edits as {
            keyPath: string;
            value: string | number | null;
          }[]) {
            config[keyPath] = value;
          }
          version = "after";
          return { result: { status: "ok" } };
        default:
          return undefined;
      }
    };
    return { reply };
  }

  test("writes the profile in one batch, and only model and effort go with this tab's next turn", async () => {
    const c = tab(undefined, undefined, configFixture().reply);
    const before = await c.readDefaults();
    expect(before.keys.find(({ key }) => key === "sandbox_mode")?.value).toBe("read-only");
    await c.saveDefaults({
      changes: {
        model: "gpt-a",
        approval_policy: "never",
        sandbox_mode: "workspace-write",
        web_search: "disabled",
      },
      effort: "low",
    });
    const writes = sent.filter((m) => m.method === "config/batchWrite");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.params?.reloadUserConfig).toBeUndefined();
    expect(shown(c)).toEqual({ model: "gpt-a", effort: "low" });
    const after = await c.readDefaults();
    expect(after.keys.find(({ key }) => key === "sandbox_mode")?.value).toBe("workspace-write");
    await c.send("next turn");
    const turn = sent.find((m) => m.method === "turn/start");
    expect(turn?.params).toMatchObject({ model: "gpt-a", effort: "low" });
    expect(turn?.params?.sandboxPolicy).toBeUndefined();
    expect(turn?.params?.approvalPolicy).toBeUndefined();
    expect(sent.some((m) => m.method === "thread/settings/update")).toBe(false);
  });

  test.each([
    "okOverridden",
    "conflict",
  ] as const)("leaves tab picks alone when a write reports %s", async (status) => {
    const c = tab(undefined, undefined, configFixture(status).reply);
    await expect(c.saveDefaults({ changes: { model: "gpt-a" } })).rejects.toThrow(
      status === "conflict" ? "Configuration was modified" : "overrides a saved value",
    );
    expect(c.inheritedChoice()?.model).not.toBe("gpt-a");
  });

  test("reads and saves model settings when an old Codex lacks configRequirements/read", async () => {
    const { reply } = configFixture();
    const c = tab(undefined, undefined, (message) =>
      message.method === "configRequirements/read"
        ? {
            error: {
              code: -32600,
              message: "Invalid request: unknown variant `configRequirements/read`",
            },
          }
        : reply(message),
    );
    const defaults = await c.readDefaults();
    expect(defaults.keys.find(({ key }) => key === "web_search")?.options).toEqual([]);
    await c.saveDefaults({ changes: { model: "gpt-a" }, effort: "low" });
    expect(c.inheritedChoice()).toEqual({ model: "gpt-a", effort: "low" });
  });

  test("refuses a desktop or mobile save bound to the profile read before a move", async () => {
    const workspaceId = "ws-codex-stale-config";
    const t = useTabsStore
      .getState()
      .createTab(workspaceId, { type: "codex", props: { cwd: "/p" } });
    const ref = { workspaceId, tabId: t.id };
    const c = tab(undefined, undefined, configFixture().reply, ref);
    try {
      const request = chatHandlers["chat.config"];
      const { config } = await request(ref);
      const origin = config?.keys.find(({ key }) => key === CODEX_CONFIG_PROFILE_KEY)?.value;
      expect(origin).toBe("codex-default");
      await c.switchProfile("work");
      const stale = {
        changes: { [CODEX_CONFIG_PROFILE_KEY]: String(origin), web_search: "disabled" },
      };
      await expect(request({ ...ref, set: stale })).rejects.toThrow("The Codex profile changed");
      await expect(c.saveDefaults(stale)).rejects.toThrow("The Codex profile changed");
      expect(sent.some((m) => m.method === "config/batchWrite")).toBe(false);

      const { config: current } = await request(ref);
      expect(current?.keys.find(({ key }) => key === CODEX_CONFIG_PROFILE_KEY)?.value).toBe("work");
      await request({
        ...ref,
        set: { changes: { [CODEX_CONFIG_PROFILE_KEY]: "work", web_search: "disabled" } },
      });
      const write = sent.find((m) => m.method === "config/batchWrite");
      expect(write?.params?.edits).toEqual([
        { keyPath: "web_search", value: "disabled", mergeStrategy: "replace" },
      ]);
    } finally {
      closeCodexTab(workspaceId, t.id);
    }
  });

  test("saves and clears the threshold through the peer/mobile host handler", async () => {
    const workspaceId = "ws-codex-peer-compact-config";
    const t = useTabsStore
      .getState()
      .createTab(workspaceId, { type: "codex", props: { cwd: "/p" } });
    const ref = { workspaceId, tabId: t.id };
    tab(undefined, undefined, configFixture().reply, ref);
    try {
      const request = chatHandlers["chat.config"];
      const readThreshold = async () => {
        const { config } = await request(ref);
        return config?.keys.find(({ key }) => key === "model_auto_compact_token_limit");
      };
      const saveThreshold = (value: string) =>
        request({
          ...ref,
          set: {
            changes: {
              [CODEX_CONFIG_PROFILE_KEY]: "codex-default",
              model_auto_compact_token_limit: value,
            },
          },
        });
      expect((await readThreshold())?.value).toBeUndefined();
      await saveThreshold("400000");
      expect((await readThreshold())?.value).toBe("400000");
      await saveThreshold("");
      expect((await readThreshold())?.value).toBeUndefined();
      expect(
        sent.filter((m) => m.method === "config/batchWrite").map((m) => m.params?.edits),
      ).toEqual([
        [{ keyPath: "model_auto_compact_token_limit", value: 400000, mergeStrategy: "replace" }],
        [{ keyPath: "model_auto_compact_token_limit", value: null, mergeStrategy: "replace" }],
      ]);
    } finally {
      closeCodexTab(workspaceId, t.id);
    }
  });

  test("the peer/mobile host handler refuses direct unsafe inputs before writing", async () => {
    const workspaceId = "ws-codex-config-remote";
    const t = useTabsStore
      .getState()
      .createTab(workspaceId, { type: "codex", props: { cwd: "/p" } });
    const ref = { workspaceId, tabId: t.id };
    tab(undefined, undefined, configFixture().reply, ref);
    try {
      const request = chatHandlers["chat.config"];
      const { config } = await request(ref);
      expect(config?.keys.find(({ key }) => key === "sandbox_mode")?.options).toEqual([
        "read-only",
        "workspace-write",
      ]);
      for (const changes of [
        { sandbox_mode: "danger-full-access", web_search: "disabled" },
        { approval_policy: "never" },
        { filePath: "/some/other/config.toml" },
      ]) {
        await expect(request({ ...ref, set: { changes } })).rejects.toThrow();
      }
      expect(sent.some((m) => m.method === "config/batchWrite")).toBe(false);
      await expect(
        request({ ...ref, set: { changes: { web_search: "disabled" } } }),
      ).resolves.toEqual({});
      const { config: saved } = await request(ref);
      expect(saved?.keys.find(({ key }) => key === "web_search")?.value).toBe("disabled");
    } finally {
      closeCodexTab(workspaceId, t.id);
    }
  });
});

describe("Codex collaboration modes", () => {
  const presets = {
    data: [
      { mode: "plan", reasoning_effort: "medium" },
      { mode: "default", reasoning_effort: null },
    ],
  };
  function collaborationServer(message: Message, includeInstructions = true) {
    if (message.method === "collaborationMode/list") return { result: presets };
    if (message.method === "config/read")
      return {
        result: {
          config: {
            plan_mode_reasoning_effort: "xhigh",
            include_collaboration_mode_instructions: includeInstructions,
            developer_instructions: "Keep the profile's developer instructions",
          },
        },
      };
    if (message.method === "thread/resume")
      return {
        result: {
          thread: { id: "t1" },
          model: "gpt-5.5",
          reasoningEffort: "high",
          sandbox: { type: "readOnly" },
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.5",
              reasoning_effort: "high",
              developer_instructions: "Existing Default instructions",
            },
          },
        },
      };
    return undefined;
  }

  test("Plan and Default preserve permission and restore configured collaboration behavior", async () => {
    const c = tab(undefined, undefined, collaborationServer);
    await c.setCollaborationMode("plan");
    expect(c.model.collaborationMode).toBe("plan");
    expect(c.model.effort).toBe("xhigh");
    expect(c.model.permissionMode).toBe("readOnly");
    await c.setCollaborationMode("default");
    expect(c.model.collaborationMode).toBe("default");
    expect(c.model.effort).toBe("high");
    expect(c.model.permissionMode).toBe("readOnly");
    const updates = sent.filter((message) => message.method === "thread/settings/update");
    expect(updates.map(({ params }) => params)).toEqual([
      {
        threadId: "t1",
        collaborationMode: {
          mode: "plan",
          settings: { model: "gpt-5.5", reasoning_effort: "xhigh", developer_instructions: null },
        },
      },
      {
        threadId: "t1",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.5",
            reasoning_effort: "high",
            developer_instructions: "Existing Default instructions",
          },
        },
      },
    ]);
    expect(sent.some((message) => message.method === "turn/start")).toBe(false);
  });

  test("host advertises and runs mode commands over the existing peer/mobile handlers", async () => {
    const workspaceId = "ws-codex-collaboration-remote";
    const t = useTabsStore
      .getState()
      .createTab(workspaceId, { type: "codex", props: { cwd: "/p" } });
    const ref = { workspaceId, tabId: t.id };
    const c = tab(undefined, undefined, (message) => collaborationServer(message, false), ref);
    try {
      await c.prepareSend();
      const { commands } = await chatHandlers["chat.commands"](ref);
      for (const name of ["plan", "default"]) {
        expect(commands.find((command) => command.name === name)).toMatchObject({
          runs: "command",
        });
        const result = await chatHandlers["chat.command"]({ ...ref, name });
        expect(result).toMatchObject({ message: expect.any(String), card: false });
        expect(c.model.collaborationMode).toBe(name);
      }
      const updates = sent.filter((message) => message.method === "thread/settings/update");
      expect(updates).toHaveLength(2);
      for (const update of updates) {
        expect(update.params?.collaborationMode).toMatchObject({
          settings: { developer_instructions: "" },
        });
      }
    } finally {
      closeCodexTab(workspaceId, t.id);
    }
  });

  test("a fork that does not start leaves no tab behind and tells the device that asked", async () => {
    const workspaceId = "ws-codex-fork-fails";
    const t = useTabsStore
      .getState()
      .createTab(workspaceId, { type: "codex", props: { cwd: "/p" } });
    const ref = { workspaceId, tabId: t.id };
    const c = tab(undefined, undefined, (message) => collaborationServer(message, false), ref);
    const tabsOf = () => Object.keys(useTabsStore.getState().byWorkspace[workspaceId] ?? {});
    try {
      await c.prepareSend();
      // A conversation with something to fork, as the tab has once it has run.
      c.forkPoint = () => ({ threadId: "t1" });
      startFails = true;
      await expect(chatHandlers["chat.fork"](ref)).rejects.toThrow("Codex is not running");
      expect(tabsOf()).toEqual([t.id]);
    } finally {
      closeCodexTab(workspaceId, t.id);
    }
  });

  test("a send issued while Plan is switching waits for the app-server acknowledgement", async () => {
    const updating = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<{ result: unknown }>();
    const c = tab(undefined, undefined, (message) => {
      if (message.method !== "thread/settings/update") return collaborationServer(message);
      updating.resolve();
      return finish.promise;
    });
    await c.prepareSend();
    const mode = c.setCollaborationMode("plan");
    await updating.promise;
    const send = c.send("plan this");
    await Bun.sleep(5);
    const wentBeforeAck = sent.some((message) => message.method === "turn/start");
    finish.resolve({ result: {} });
    await Promise.all([mode, send]);
    expect(wentBeforeAck).toBe(false);
    expect(sent.some((message) => message.method === "turn/start")).toBe(true);
    expect(c.model.collaborationMode).toBe("plan");
  });

  test("an unsupported older host neither switches settings nor sends a prompt", async () => {
    const c = tab(undefined, undefined, (message) =>
      message.method === "collaborationMode/list"
        ? { error: { code: -32601, message: "Method not found" } }
        : undefined,
    );
    await expect(c.setCollaborationMode("plan")).rejects.toThrow("does not offer Plan and Default");
    expect(
      sent.some((message) =>
        ["thread/settings/update", "turn/start"].includes(String(message.method)),
      ),
    ).toBe(false);
    expect(c.model.collaborationMode).toBe("default");
  });
});
