import { describe, expect, test } from "bun:test";
import { ChatHost, type ChatWorkspaceManager } from "../../../../src/main/features/chat/host";
import {
  CLAUDE_TAB_ARGS,
  claudeCommandArgs,
  claudeTabArgs,
  claudeTabEnv,
  parseClaudeVersion,
} from "../../../../src/main/features/chat/launch";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "../../../../src/main/infra/agent/channel";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAB = "11111111-1111-4111-8111-111111111111";

class FakeChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly calls: Array<{ method: string; params: unknown }> = [];
  found: { path: string; envPath?: string } = {
    path: "/home/u/.local/bin/claude",
    envPath: "/home/u/.local/bin:/usr/bin",
  };
  versionOutput = "2.1.318 (Claude Code)\n";
  private readonly listeners = new Map<string, Set<ChannelEventCallback>>();
  private readonly lifecycle = new Set<ChannelLifecycleCallback>();

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "lsp.findBinary") return this.found as T;
    if (method === "chat.exec") return { code: 0, stdout: this.versionOutput, stderr: "" } as T;
    if (method === "chat.start") return { pid: 42 } as T;
    return {} as T;
  }
  fire(): void {}
  on(event: string, cb: ChannelEventCallback): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  }
  onLifecycle(cb: ChannelLifecycleCallback): () => void {
    this.lifecycle.add(cb);
    return () => this.lifecycle.delete(cb);
  }
  emit(event: string, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(payload);
  }
  emitLifecycle(event: ChannelLifecycleEvent): void {
    for (const cb of Array.from(this.lifecycle)) cb(event);
  }
  dispose(): void {}
}

function setup(overrides: Partial<ChatWorkspaceManager> = {}) {
  const channel = new FakeChannel();
  const events: Array<{ event: string; args: unknown }> = [];
  const status: string[] = [];
  let providerReady: ((id: string) => void) | undefined;
  const manager: ChatWorkspaceManager = {
    getAgentChannel: async () => channel,
    tryGetAgentChannel: async () => channel,
    onProviderReady: (listener) => {
      providerReady = listener;
      return () => {};
    },
    getHookInfo: () => ({ socketPath: "/tmp/h.sock", token: "tok" }),
    getWrapperBinDir: () => "/home/u/.nexus-code/bin",
    getWrapperAgentBin: () => "/home/u/.nexus-code/bin/agent",
    isLocal: () => false,
    ...overrides,
  };
  const host = new ChatHost({
    workspaceManager: manager,
    broadcast: (event, args) => events.push({ event, args }),
    onTurnStopped: (ws, tab) => status.push(`stopped ${ws} ${tab}`),
    onProgramExit: (ws, tab) => status.push(`exit ${ws} ${tab}`),
  });
  return { channel, events, status, host, providerReady: (id: string) => providerReady?.(id) };
}

describe("chat launch", () => {
  test("resume and fork add their flags after the stream-json ones", () => {
    expect(claudeTabArgs({})).toEqual([...CLAUDE_TAB_ARGS]);
    expect(claudeTabArgs({ resume: "s1" }).slice(-2)).toEqual(["--resume", "s1"]);
    expect(claudeTabArgs({ resume: "s1", fork: true, resumeAt: "u9" }).slice(-5)).toEqual([
      "--resume",
      "s1",
      "--fork-session",
      "--resume-session-at",
      "u9",
    ]);
    // resumeAt means nothing without fork.
    expect(claudeTabArgs({ resume: "s1", resumeAt: "u9" })).not.toContain("--resume-session-at");
    expect(claudeTabArgs({}, "C:\\h.json").slice(0, 2)).toEqual(["--settings", "C:\\h.json"]);
  });

  test("the env marks the tab for the wrapper and turns on file checkpoints", () => {
    const env = claudeTabEnv({
      workspaceId: WS,
      tabId: TAB,
      path: "/a:/b",
      wrapperBinDir: "/w",
      agentBin: "/w/agent",
      agentSocket: "/s",
      hookToken: "t",
    });
    expect(env).toMatchObject({
      NEXUS_IN_APP: "1",
      NEXUS_WRAPPER_SELF_DIR: "/w",
      NEXUS_TAB_ID: TAB,
      NEXUS_AGENT_BIN: "/w/agent",
      NEXUS_AGENT_PRINT_RUN: "1",
      NEXUS_AGENT_SOCKET: "/s",
      NEXUS_HOOK_TOKEN: "t",
      PATH: "/a:/b",
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true",
    });
    expect(env.TERM_PROGRAM).toBeUndefined();
    expect(env.NEXUS_CLAUDE_TAB_ID).toBeUndefined();

    const windows = claudeTabEnv({
      workspaceId: WS,
      tabId: TAB,
      wrapperBinDir: null,
      agentBin: null,
      withoutWrapper: true,
    });
    expect(windows.NEXUS_CLAUDE_TAB_ID).toBe(TAB);
    expect(windows.NEXUS_CLAUDE_PRINT).toBe("1");
  });

  test("parses claude --version", () => {
    expect(parseClaudeVersion("2.1.318 (Claude Code)\n")).toBe("2.1.318");
    expect(parseClaudeVersion("nope")).toBeNull();
  });

  test("background sessions: list, send with the prompt after --, stop", () => {
    expect(claudeCommandArgs({ kind: "agents" }, "/repo")).toEqual([
      "agents",
      "--json",
      "--all",
      "--cwd",
      "/repo",
    ]);
    expect(
      claudeCommandArgs(
        { kind: "background", sessionId: "s1", model: "haiku", prompt: "-v go on" },
        "/r",
      ),
    ).toEqual(["--bg", "--resume", "s1", "--model", "haiku", "--", "-v go on"]);
    expect(claudeCommandArgs({ kind: "background", prompt: "" }, "/r")).toEqual(["--bg"]);
    expect(claudeCommandArgs({ kind: "stop", id: "8c55b250" }, "/r")).toEqual(["stop", "8c55b250"]);
  });

  test("plugins: the list, and each change as JSON in its scope", () => {
    expect(claudeCommandArgs({ kind: "plugins" }, "/r")).toEqual(["plugin", "list", "--json"]);
    expect(
      claudeCommandArgs(
        { kind: "plugin", action: "disable", plugin: "a@m", scope: "project" },
        "/r",
      ),
    ).toEqual(["plugin", "disable", "a@m", "--json", "--scope", "project"]);
    expect(claudeCommandArgs({ kind: "plugin", action: "uninstall", plugin: "a@m" }, "/r")).toEqual(
      ["plugin", "uninstall", "a@m", "--json", "--keep-data"],
    );
  });
});

describe("ChatHost", () => {
  test("start runs the wrapper with the PATH claude was found on", async () => {
    const { channel, host } = setup();
    const result = await host.start(WS, TAB, "/repo", { resume: "s1" });
    expect(result).toEqual({ ok: true, pid: 42, attached: false, version: "2.1.318" });
    const start = channel.calls.find((c) => c.method === "chat.start")?.params as {
      program: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
    };
    expect(start.program).toBe("/home/u/.nexus-code/bin/claude");
    expect(start.cwd).toBe("/repo");
    expect(start.args).toContain("--resume");
    expect(start.env.PATH).toBe("/home/u/.local/bin:/usr/bin");
    expect(start.env.NEXUS_HOOK_TOKEN).toBe("tok");
    expect(start).toMatchObject({ resumed: true });
    expect(start).not.toHaveProperty("resetLog");
  });

  test("a rewind's start drops the tab's log first", async () => {
    const { channel, host } = setup();
    await host.start(WS, TAB, "/repo", {
      resume: "s1",
      fork: true,
      resumeAt: "u1",
      resetLog: true,
    });
    const start = channel.calls.find((c) => c.method === "chat.start")?.params as {
      args: string[];
    };
    expect(start).toMatchObject({ resetLog: true, resumed: true });
    expect(start.args).toEqual(
      expect.arrayContaining(["--fork-session", "--resume-session-at", "u1"]),
    );
  });

  test("start without the wrapper runs claude itself", async () => {
    const { channel, host } = setup({ getWrapperBinDir: () => null });
    await host.start(WS, TAB, "/repo", {});
    const start = channel.calls.find((c) => c.method === "chat.start")?.params as {
      program: string;
    };
    expect(start.program).toBe("/home/u/.local/bin/claude");
  });

  test("cli runs the claude the PATH has, in the folder", async () => {
    const { channel, host } = setup();
    await host.cli(WS, "/repo", { kind: "stop", id: "abc" });
    expect(channel.calls.find((c) => c.method === "chat.exec")?.params).toMatchObject({
      cwd: "/repo",
      program: "/home/u/.local/bin/claude",
      args: ["stop", "abc"],
      env: { PATH: "/home/u/.local/bin:/usr/bin" },
    });
    channel.found = { path: "" };
    await expect(host.cli(WS, "/repo", { kind: "agents" })).rejects.toThrow("not found");
  });

  test("start says when claude is not found", async () => {
    const { channel, host } = setup();
    channel.found = { path: "" };
    const result = await host.start(WS, TAB, "/repo", {});
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("not-found");
    expect(channel.calls.some((c) => c.method === "chat.start")).toBe(false);
  });

  test("relays only the workspace's own lines", async () => {
    const { channel, events, host } = setup();
    await host.start(WS, TAB, "/repo", {});
    channel.emit("chat.line", { workspaceId: WS, tabId: TAB, seq: 1, dir: "out", message: {} });
    channel.emit("chat.line", {
      workspaceId: "other",
      tabId: TAB,
      seq: 2,
      dir: "out",
      message: {},
    });
    channel.emit("chat.exit", { workspaceId: WS, tabId: TAB, code: 0 });
    expect(events.map((e) => e.event)).toEqual(["line", "exit"]);
  });

  test("tells the Claude status of turns that stopped short and of exits", async () => {
    const { channel, status, host } = setup();
    await host.start(WS, TAB, "/repo", {});
    const result = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      channel.emit("chat.line", {
        workspaceId: WS,
        tabId: TAB,
        seq: 1,
        dir: "out",
        message: { type: "result", ...message },
        ...extra,
      });
    result({ subtype: "success", terminal_reason: "completed" });
    result({ subtype: "error_during_execution" });
    result({ subtype: "success", terminal_reason: "aborted_tools" });
    result({ subtype: "error_during_execution" }, { replay: true });
    channel.emit("chat.exit", { workspaceId: WS, tabId: TAB, code: 0 });
    expect(status).toEqual([`stopped ${WS} ${TAB}`, `stopped ${WS} ${TAB}`, `exit ${WS} ${TAB}`]);
  });

  test("holds on reconnecting and resyncs when the agent is back", async () => {
    const { channel, events, host, providerReady } = setup();
    await host.start(WS, TAB, "/repo", {});
    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "ready", epoch: 1 } as ChannelLifecycleEvent);
    expect(events.map((e) => e.event)).toEqual(["held", "resync"]);

    // A channel that failed is let go; a new agent resyncs the tabs.
    channel.emitLifecycle({ type: "failure", error: new Error("x") });
    providerReady(WS);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.map((e) => e.event)).toEqual(["held", "resync", "held", "resync"]);
  });

  test("a new agent for a workspace without Claude tabs is ignored", async () => {
    const { events, providerReady } = setup();
    providerReady(WS);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
  });
});
