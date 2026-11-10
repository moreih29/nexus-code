import { describe, expect, test } from "bun:test";
import { ChatHost, type ChatWorkspaceManager } from "../../../../src/main/features/chat/host";
import {
  CLAUDE_TAB_ARGS,
  CLAUDE_TAB_PROMPT,
  claudeCommandArgs,
  claudeTabArgs,
  claudeTabEnv,
  codexTabEnv,
  gitBashPath,
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
    getWrapperShimDir: () => "/home/u/.nexus-code/shim/ws",
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
    expect(claudeTabArgs({})).toEqual([
      ...CLAUDE_TAB_ARGS,
      "--append-system-prompt",
      CLAUDE_TAB_PROMPT,
    ]);
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
      NEXUS_AGENT_EXEC_RUN: "1",
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
    expect(windows.BASH_ENV).toBeUndefined();

    // Its Bash tool's Git Bash puts the wrappers first, named as Git Bash names them.
    const gitBash = claudeTabEnv({
      workspaceId: WS,
      tabId: TAB,
      wrapperBinDir: null,
      agentBin: null,
      withoutWrapper: true,
      gitBash: {
        wrapperDir: "C:\\Users\\u\\.nexus-code\\bin",
        bashEnv: "C:\\Users\\u\\.nexus-code\\shim\\ws\\bashenv",
      },
    });
    expect(gitBash.BASH_ENV).toBe("/c/Users/u/.nexus-code/shim/ws/bashenv");
    expect(gitBash.NEXUS_BASH_WRAPPER_DIR).toBe("/c/Users/u/.nexus-code/bin");
    expect(gitBash.PATH).toBeUndefined();
  });

  test("a Windows path as Git Bash names it", () => {
    expect(gitBashPath("C:\\Users\\u\\.nexus-code\\bin")).toBe("/c/Users/u/.nexus-code/bin");
    expect(gitBashPath("d:\\x")).toBe("/d/x");
    expect(gitBashPath("\\\\server\\share\\x")).toBe("//server/share/x");
    expect(gitBashPath("/already/posix")).toBe("/already/posix");
  });

  test("a Codex tab's env marks its commands as inside the tab's own session", () => {
    const context = {
      workspaceId: WS,
      tabId: TAB,
      path: "/a:/b",
      wrapperBinDir: "/w",
      agentBin: "/w/agent",
      agentSocket: "/s",
      hookToken: "t",
      shimDir: "/shim",
    };
    expect(codexTabEnv(context)).toEqual({
      NEXUS_IN_APP: "1",
      NEXUS_WRAPPER_SELF_DIR: "/w",
      NEXUS_WORKSPACE_ID: WS,
      NEXUS_TAB_ID: TAB,
      NEXUS_CLAUDE_TAB_ID: TAB,
      NEXUS_AGENT_BIN: "/w/agent",
      NEXUS_AGENT_PRINT_RUN: "1",
      NEXUS_AGENT_EXEC_RUN: "1",
      NEXUS_AGENT_SOCKET: "/s",
      NEXUS_HOOK_TOKEN: "t",
      PATH: "/a:/b",
      // Its commands' login shell keeps the wrappers first through the shim files.
      ZDOTDIR: "/shim",
      NEXUS_USER_ZDOTDIR: "",
      BASH_ENV: "/shim/bashenv",
    });
    // Without the shim files, the wrappers stay first only where no profile moves them.
    const unshimmed = codexTabEnv({ ...context, shimDir: null });
    expect(unshimmed.NEXUS_CLAUDE_TAB_ID).toBe(TAB);
    expect(unshimmed.ZDOTDIR).toBeUndefined();
    expect(unshimmed.BASH_ENV).toBeUndefined();
    // Without the wrappers, the PATH codex was found with and the mark.
    expect(
      codexTabEnv({
        workspaceId: WS,
        tabId: TAB,
        wrapperBinDir: null,
        agentBin: null,
        shimDir: "/shim",
      }),
    ).toEqual({ NEXUS_CLAUDE_TAB_ID: TAB });
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

  test("start on Windows runs claude itself, its Bash tool's Git Bash on the wrappers", async () => {
    const channel = new FakeChannel();
    channel.found = { path: "C:\\Users\\u\\.local\\bin\\claude.exe" };
    const host = new ChatHost({
      workspaceManager: {
        getAgentChannel: async () => channel,
        tryGetAgentChannel: async () => channel,
        onProviderReady: () => () => {},
        getHookInfo: () => null,
        getWrapperBinDir: () => "C:\\Users\\u\\.nexus-code\\cli",
        getWrapperAgentBin: () => null,
        getWrapperShimDir: () => "C:\\Users\\u\\.nexus-code\\shim\\ws",
        isLocal: () => true,
      },
      broadcast: () => {},
      windowsAgentFiles: async () => ({
        binDir: "C:\\Users\\u\\.nexus-code\\bin",
        settingsPath: "C:\\Users\\u\\.nexus-code\\bin\\claude-settings.json",
        cmdCodexNoDaemon: false,
      }),
    });
    await host.start(WS, TAB, "C:\\repo", {});
    const start = channel.calls.find((c) => c.method === "chat.start")?.params as {
      program: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(start.program).toBe("C:\\Users\\u\\.local\\bin\\claude.exe");
    expect(start.args.slice(0, 2)).toEqual([
      "--settings",
      "C:\\Users\\u\\.nexus-code\\bin\\claude-settings.json",
    ]);
    expect(start.env).toMatchObject({
      NEXUS_CLAUDE_TAB_ID: TAB,
      BASH_ENV: "/c/Users/u/.nexus-code/shim/ws/bashenv",
      NEXUS_BASH_WRAPPER_DIR: "/c/Users/u/.nexus-code/bin",
    });
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

  test("a Codex tab runs the app server of the codex the PATH has", async () => {
    const { channel, host } = setup();
    channel.found = { path: "/home/u/.local/bin/codex", envPath: "/home/u/.local/bin:/usr/bin" };
    channel.versionOutput = "codex-cli 0.166.0\n";
    const result = await host.startCodex(WS, TAB, "/repo", { resetLog: true });
    expect(result).toEqual({ ok: true, pid: 42, attached: false, version: "0.166.0" });
    expect(channel.calls.find((c) => c.method === "lsp.findBinary")?.params).toMatchObject({
      name: "codex",
    });
    expect(channel.calls.find((c) => c.method === "chat.start")?.params).toEqual({
      workspaceId: WS,
      tabId: TAB,
      cwd: "/repo",
      program: "/home/u/.local/bin/codex",
      args: ["app-server"],
      env: expect.objectContaining({
        PATH: "/home/u/.local/bin:/usr/bin",
        NEXUS_WRAPPER_SELF_DIR: "/home/u/.nexus-code/bin",
        NEXUS_TAB_ID: TAB,
        NEXUS_CLAUDE_TAB_ID: TAB,
        NEXUS_AGENT_BIN: "/home/u/.nexus-code/bin/agent",
        NEXUS_AGENT_SOCKET: "/tmp/h.sock",
        NEXUS_HOOK_TOKEN: "tok",
        BASH_ENV: "/home/u/.nexus-code/shim/ws/bashenv",
      }),
      resetLog: true,
    });
    // `codex --version` needs none of it.
    const version = channel.calls.find((c) => c.method === "chat.exec")?.params as {
      env: Record<string, string>;
    };
    expect(version.env).toEqual({ PATH: "/home/u/.local/bin:/usr/bin" });
    channel.found = { path: "" };
    const missing = await host.startCodex(WS, TAB, "/repo", {});
    expect(missing.ok === false && missing.reason).toBe("not-found");
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
