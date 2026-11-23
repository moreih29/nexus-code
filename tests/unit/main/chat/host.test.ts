import { describe, expect, jest, mock, test } from "bun:test";
import {
  ChatHost,
  type ChatHostOptions,
  type ChatWorkspaceManager,
} from "../../../../src/main/features/chat/host";
import {
  claudeInstructionLaunchState,
  instructionsFor,
} from "../../../../src/main/features/chat/instructions";
import {
  APPEND_PROMPT_FILE_FROM,
  CLAUDE_TAB_ARGS,
  CLAUDE_TAB_PROMPT,
  claudeCommandArgs,
  claudeTabArgs,
  claudeTabEnv,
  codexTabEnv,
  escapeWindowsArg,
  gitBashPath,
  parseClaudeVersion,
  THINKING_DISPLAY_FROM,
  takesAppendPromptFile,
  takesThinkingDisplay,
  WINDOWS_COMMAND_LINE_MAX,
  windowsCommandLineLength,
  windowsCommandLineTooLong,
} from "../../../../src/main/features/chat/launch";
import { SessionActivityLog } from "../../../../src/main/features/claude/session-activity";
import { sessionAgents } from "../../../../src/main/features/remote/serving/sessions";
import type {
  AgentCallOptions,
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "../../../../src/main/infra/agent/channel";
import { liveAgents } from "../../../../src/renderer/services/agent-sessions/agents";
import type { CustomConnection } from "../../../../src/shared/agent-profiles/connection";
import type { AgentProfile } from "../../../../src/shared/agent-profiles/profiles";
import { WorkspaceMetaSchema } from "../../../../src/shared/types/workspace";

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
  versionWait?: Promise<void>;
  transcriptPageError?: string;
  attachRootAnswer: unknown = {};
  attachRootError?: string;
  private readonly listeners = new Map<string, Set<ChannelEventCallback>>();
  private readonly lifecycle = new Set<ChannelLifecycleCallback>();

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "lsp.findBinary") return this.found as T;
    if (method === "chat.exec") {
      await this.versionWait;
      return { code: 0, stdout: this.versionOutput, stderr: "" } as T;
    }
    if (method === "chat.start") return { pid: 42 } as T;
    if (method === "chat.writeCodexCatalog")
      return "/home/u/.nexus-code/run/codex-catalogs/catalog.json" as T;
    if (method === "chat.transcriptPage" && this.transcriptPageError) {
      throw Object.assign(new Error("transcript page failed"), { code: this.transcriptPageError });
    }
    if (method === "chat.transcript") return { found: true, lines: [] } as T;
    if (method === "chat.attachRoot") {
      if (this.attachRootError) {
        throw Object.assign(new Error("attach root failed"), { code: this.attachRootError });
      }
      return this.attachRootAnswer as T;
    }
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

function setup(
  overrides: Partial<ChatWorkspaceManager> = {},
  agentContext?: ChatHostOptions["agentContext"],
  onTaskEvent?: ChatHostOptions["onTaskEvent"],
  profile?: ChatHostOptions["profile"],
  options: Partial<ChatHostOptions> = {},
) {
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
    getSpawnHookInfo: async () => ({ socketPath: "/tmp/h.sock", token: "tok" }),
    getWrapperBinDir: () => "/home/u/.nexus-code/bin",
    getWrapperAgentBin: () => "/home/u/.nexus-code/bin/agent",
    getWrapperShimDir: () => "/home/u/.nexus-code/shim/ws",
    isLocal: () => false,
    ...overrides,
  };
  const host = new ChatHost({
    workspaceManager: manager,
    agentContext,
    onTaskEvent,
    profile,
    broadcast: (event, args) => events.push({ event, args }),
    onTurnResult: (ws, tab, result) => status.push(`${result.outcome} ${ws} ${tab}`),
    onProgramExit: (ws, tab) => status.push(`exit ${ws} ${tab}`),
    ...options,
  });
  return { channel, events, status, host, providerReady: (id: string) => providerReady?.(id) };
}

test.each([
  ["unsupported-method", undefined, true],
  ["unsupported-method", "snapshot-cursor", false],
  ["server.request-failed", undefined, false],
  ["transport.timeout", undefined, false],
] as const)("transcript page fallback with %s and cursor %s", async (code, cursor, fallback) => {
  const { host, channel } = setup();
  channel.transcriptPageError = code;
  const page = host.transcriptPage(WS, "session-id", undefined, { cursor });
  if (fallback) {
    expect(await page).toEqual({ found: true, lines: [], truncated: false });
    expect(channel.calls.map((call) => call.method)).toEqual([
      "chat.transcriptPage",
      "chat.transcript",
    ]);
  } else {
    await expect(page).rejects.toMatchObject({ code });
    expect(channel.calls.map((call) => call.method)).toEqual(["chat.transcriptPage"]);
  }
});

describe("attachRoot", () => {
  const asked = (channel: FakeChannel) =>
    channel.calls.filter((call) => call.method === "chat.attachRoot").length;

  test("is what the workspace's agent answers, asked once a connection", async () => {
    let channel = new FakeChannel();
    const { host } = setup({ peekAgentChannel: async () => channel });
    channel.attachRootAnswer = { root: "\\\\server\\share\\Users\\k\\.nexus-code\\attach" };
    expect(await host.attachRoot(WS)).toBe("\\\\server\\share\\Users\\k\\.nexus-code\\attach");
    expect(await host.attachRoot(WS)).toBe("\\\\server\\share\\Users\\k\\.nexus-code\\attach");
    expect(asked(channel)).toBe(1);
    // A new connection is asked anew.
    channel = new FakeChannel();
    channel.attachRootAnswer = { root: "/home/k/elsewhere/attach" };
    expect(await host.attachRoot(WS)).toBe("/home/k/elsewhere/attach");
    expect(asked(channel)).toBe(1);
  });

  test("is null from an agent too old to tell, asked no more on that connection", async () => {
    const channel = new FakeChannel();
    channel.attachRootError = "unsupported-method";
    const { host } = setup({ peekAgentChannel: async () => channel });
    expect(await host.attachRoot(WS)).toBeNull();
    expect(await host.attachRoot(WS)).toBeNull();
    expect(asked(channel)).toBe(1);
  });

  test("is null when asking fails, and asked again the next time", async () => {
    const channel = new FakeChannel();
    channel.attachRootError = "transport.timeout";
    const { host } = setup({ peekAgentChannel: async () => channel });
    expect(await host.attachRoot(WS)).toBeNull();
    channel.attachRootError = undefined;
    channel.attachRootAnswer = { root: "/home/k/.nexus-code/attach" };
    expect(await host.attachRoot(WS)).toBe("/home/k/.nexus-code/attach");
    expect(asked(channel)).toBe(2);
  });

  test("is null with no agent up, or no answer in it, and dials no host", async () => {
    const channel = new FakeChannel();
    const dialed: string[] = [];
    const { host } = setup({
      peekAgentChannel: async () => null,
      getAgentChannel: async (id) => {
        dialed.push(id);
        return channel;
      },
    });
    expect(await host.attachRoot(WS)).toBeNull();
    expect(dialed).toEqual([]);
    const answered = setup({ peekAgentChannel: async () => channel });
    expect(await answered.host.attachRoot(WS)).toBeNull();
    expect(await setup().host.attachRoot(WS)).toBeNull();
  });
});

describe("Claude instruction history", () => {
  const parent = "11111111-aaaa-4aaa-8aaa-111111111111";
  const child = "22222222-bbbb-4bbb-8bbb-222222222222";
  const childTab = "33333333-cccc-4ccc-8ccc-333333333333";

  function instructionsFixture() {
    const digests = new Map<string, string | null>();
    const open = () =>
      setup({}, undefined, undefined, undefined, {
        instructions: (_workspaceId, _profile, session) => session ?? "",
        claudeInstructionDigests: {
          get: (workspaceId, sessionId) => digests.get(`${workspaceId}:${sessionId}`),
          save: (workspaceId, sessionId, digest) => {
            digests.set(`${workspaceId}:${sessionId}`, digest);
          },
        },
      });

    async function sendOriginalReplacement(...later: string[]) {
      const { host, channel } = open();
      await host.start(WS, TAB, "/repo", {}, undefined, "BASE");
      const launch = launchOf(channel);
      expect(
        host.claudeHookInstructions(WS, TAB, launch, { sessionId: parent, phase: "start" }),
      ).toBe("");
      for (const instructions of ["ECHO", ...later]) {
        await host.send(WS, TAB, { type: "user" }, { instructions });
        expect(
          host.claudeHookInstructions(WS, TAB, launch, { sessionId: parent, phase: "prompt" }),
        ).toEndWith(instructions);
      }
      await host.call("close", { workspaceId: WS, tabId: TAB });
    }

    return { open, digests, sendOriginalReplacement };
  }

  function launchOf(channel: FakeChannel): string {
    const params = channel.calls.findLast(({ method }) => method === "chat.start")?.params as {
      env: Record<string, string>;
    };
    return params.env.NEXUS_CHAT_INSTRUCTION_LAUNCH ?? "";
  }

  test.each([
    "prompt",
    "restore",
  ] as const)("a %s hook picks up saved session edits and clears without another send", async (phase) => {
    let saved = { profileId: "claude-default", instructions: "BASE" };
    const instructions = mock(
      (_workspaceId: string, _profile: AgentProfile, session?: string) => session ?? "",
    );
    const { host, channel } = setup({}, undefined, undefined, undefined, {
      instructions,
      savedClaudeInstructions: () => saved,
    });
    await host.start(WS, TAB, "/repo", {}, undefined, saved.instructions);
    await host.send(WS, TAB, { type: "user" }, { instructions: saved.instructions });
    const launch = launchOf(channel);
    const hook = { sessionId: parent, phase };

    saved = { profileId: "other-profile", instructions: "EDITED" };
    expect(host.claudeHookInstructions(WS, TAB, launch, hook)).toEndWith("EDITED");
    expect(instructions).toHaveBeenLastCalledWith(
      WS,
      expect.objectContaining({ id: "claude-default" }),
      "EDITED",
    );

    saved = { ...saved, instructions: "" };
    expect(host.claudeHookInstructions(WS, TAB, launch, hook)).toContain(
      "NexusCode instructions were cleared.",
    );
  });

  test("a restarted app replaces a stale block on the first prompt of a resumed chat", async () => {
    const { open, sendOriginalReplacement } = instructionsFixture();
    await sendOriginalReplacement();
    const { host, channel } = open();
    await host.start(WS, TAB, "/repo", { resume: parent }, undefined, "KILO");
    const launch = launchOf(channel);

    expect(
      host.claudeHookInstructions(WS, TAB, launch, { sessionId: parent, phase: "start" }),
    ).toBe("");
    expect(
      host.claudeHookInstructions(WS, TAB, launch, { sessionId: parent, phase: "prompt" }),
    ).toEndWith("KILO");
    expect(
      host.claudeHookInstructions(WS, TAB, launch, { sessionId: parent, phase: "prompt" }),
    ).toBe("");
    expect(
      host.claudeHookInstructions(WS, TAB, launch, { sessionId: parent, phase: "restore" }),
    ).toBe("");
  });

  test("a fork replaces its inherited block on the first prompt without changing the source", async () => {
    const { open, digests, sendOriginalReplacement } = instructionsFixture();
    await sendOriginalReplacement();
    const original = digests.get(`${WS}:${parent}`);
    const { host, channel } = open();
    await host.start(
      WS,
      childTab,
      "/repo",
      { resume: `/profile/${parent}.jsonl`, fork: true },
      undefined,
      "KILO",
    );
    const launch = launchOf(channel);

    expect(
      host.claudeHookInstructions(WS, childTab, launch, { sessionId: child, phase: "start" }),
    ).toBe("");
    expect(digests.get(`${WS}:${child}`)).toBe(original);
    expect(
      host.claudeHookInstructions(WS, childTab, launch, { sessionId: child, phase: "prompt" }),
    ).toEndWith("KILO");
    expect(
      host.claudeHookInstructions(WS, childTab, launch, { sessionId: child, phase: "prompt" }),
    ).toBe("");
    expect(digests.get(`${WS}:${parent}`)).toBe(original);
    expect(digests.get(`${WS}:${child}`)).toBe(claudeInstructionLaunchState(launch)?.systemDigest);
  });

  test("a fork keeps a matching inherited block without repeating it and passes it to later resumes", async () => {
    const { open, digests, sendOriginalReplacement } = instructionsFixture();
    await sendOriginalReplacement();
    const { host, channel } = open();
    await host.start(WS, childTab, "/repo", { resume: parent, fork: true }, undefined, "ECHO");
    const launch = launchOf(channel);
    host.claudeHookInstructions(WS, childTab, launch, { sessionId: child, phase: "start" });
    expect(
      host.claudeHookInstructions(WS, childTab, launch, { sessionId: child, phase: "prompt" }),
    ).toBe("");
    expect(digests.get(`${WS}:${child}`)).toBe(digests.get(`${WS}:${parent}`));

    const resumed = open();
    await resumed.host.start(WS, childTab, "/repo", { resume: child }, undefined, "KILO");
    expect(
      resumed.host.claudeHookInstructions(WS, childTab, launchOf(resumed.channel), {
        sessionId: child,
        phase: "prompt",
      }),
    ).toEndWith("KILO");
  });

  test("a fork from an earlier message refreshes instructions once even when the source matches", async () => {
    const { open, digests, sendOriginalReplacement } = instructionsFixture();
    await sendOriginalReplacement("KILO");
    const source = digests.get(`${WS}:${parent}`);
    const { host, channel } = open();
    await host.start(
      WS,
      childTab,
      "/repo",
      { resume: parent, fork: true, resumeAt: "earlier-message" },
      undefined,
      "KILO",
    );
    const launch = launchOf(channel);

    expect(source).toBe(claudeInstructionLaunchState(launch)?.systemDigest);
    expect(
      host.claudeHookInstructions(WS, childTab, launch, { sessionId: child, phase: "start" }),
    ).toBe("");
    expect(
      host.claudeHookInstructions(WS, childTab, launch, { sessionId: child, phase: "prompt" }),
    ).toEndWith("KILO");
    expect(
      host.claudeHookInstructions(WS, childTab, launch, { sessionId: child, phase: "prompt" }),
    ).toBe("");
    expect(digests.get(`${WS}:${parent}`)).toBe(source);
    expect(digests.get(`${WS}:${child}`)).toBe(source);
  });

  test.each([
    false,
    true,
  ])("resuming skips a replacement when the history had a matching block: %s", async (hadBlock) => {
    const { open, digests, sendOriginalReplacement } = instructionsFixture();
    if (hadBlock) await sendOriginalReplacement();
    const { host, channel } = open();
    await host.start(WS, TAB, "/repo", { resume: parent }, undefined, "ECHO");
    const launch = launchOf(channel);

    expect(
      host.claudeHookInstructions(WS, TAB, launch, { sessionId: parent, phase: "start" }),
    ).toBe("");
    expect(
      host.claudeHookInstructions(WS, TAB, launch, { sessionId: parent, phase: "prompt" }),
    ).toBe("");
    expect(digests.has(`${WS}:${parent}`)).toBe(hadBlock);
  });
});

describe("chat launch", () => {
  test("the Claude usage probe starts the profile directly without session hooks or persistence", async () => {
    const { host, channel } = setup({}, undefined, undefined, (id) => ({
      agent: "claude",
      id,
      name: "",
      color: "",
      dir: "",
      env: { PROFILE_MARKER: "account" },
    }));
    try {
      expect(await host.start(WS, TAB, "/repo", { usageOnly: true })).toMatchObject({ ok: true });
      const call = channel.calls.find(({ method }) => method === "chat.start");
      expect(call?.params).toMatchObject({
        program: channel.found.path,
        args: [
          ...CLAUDE_TAB_ARGS,
          "--no-session-persistence",
          "--strict-mcp-config",
          "--settings",
          '{"disableAllHooks":true}',
        ],
        env: { PROFILE_MARKER: "account" },
      });
    } finally {
      await host.call("close", { workspaceId: WS, tabId: TAB });
    }
  });

  test("Claude launches and Codex turns in a task use the parent workspace layer", async () => {
    const defaults = { pinned: false, tabs: [] };
    const parent = WorkspaceMetaSchema.parse({
      ...defaults,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb",
      name: "Parent",
      rootPath: "/repo",
    });
    const task = WorkspaceMetaSchema.parse({
      ...defaults,
      id: WS,
      name: "Task",
      rootPath: "/worktree",
      task: { parentId: parent.id, branch: "task", worktreePath: "/worktree" },
    });
    const config = { workspaces: { [parent.id]: "Parent rules", [task.id]: "Legacy rules" } };
    const { host, channel } = setup({}, undefined, undefined, undefined, {
      instructions: (workspaceId, profile, session) =>
        instructionsFor(config, profile, workspaceId, [parent, task], session),
    });
    const layers = "## Workspace: Parent\nParent rules\n\n## This session\nSession rules";

    await host.start(WS, TAB, "/worktree", {}, undefined, "Session rules");
    const { args } = channel.calls.find(({ method }) => method === "chat.start")?.params as {
      args: string[];
    };
    const prompt = args[args.indexOf("--append-system-prompt") + 1];
    expect(prompt).toEndWith(layers);
    expect(prompt).not.toContain("Legacy rules");

    await host.send(WS, TAB, { method: "turn/start" }, { instructions: "Session rules" });
    const { codexContext } = channel.calls.at(-1)?.params as {
      codexContext: { instructions: string };
    };
    expect(codexContext.instructions).toEndWith(layers);
    expect(codexContext.instructions).not.toContain("Legacy rules");
  });

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

  test("adds the merged instructions to the existing system prompt argument", () => {
    const instructions = "# Instructions set in NexusCode\n\n## This session\nUse Korean.";
    const args = claudeTabArgs({ resume: "s1" }, undefined, null, instructions);
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(
      `${CLAUDE_TAB_PROMPT}\n\n${instructions}`,
    );
    expect(args.filter((arg) => arg === "--append-system-prompt")).toHaveLength(1);
  });

  test("a prompt file replaces the prompt argument and carries no text on the line", () => {
    const args = claudeTabArgs({ resume: "s1" }, undefined, null, "x", "C:\runp.txt");
    expect(args).not.toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("C:\runp.txt");
    expect(args.join(" ")).not.toContain(CLAUDE_TAB_PROMPT);
  });

  test("only a claude known to take --append-system-prompt-file is given a file", () => {
    expect(takesAppendPromptFile(APPEND_PROMPT_FILE_FROM)).toBe(true);
    expect(takesAppendPromptFile("2.1.321")).toBe(true);
    for (const version of ["2.1.68", null, "garbage"]) {
      expect(takesAppendPromptFile(version)).toBe(false);
    }
  });

  test("Windows argument escaping matches Go's os/exec", () => {
    expect(escapeWindowsArg("")).toBe('""');
    expect(escapeWindowsArg("plain")).toBe("plain");
    expect(escapeWindowsArg('a"b')).toBe('a\\"b');
    expect(escapeWindowsArg('a\\"b')).toBe('a\\\\\\"b');
    expect(escapeWindowsArg("a\b")).toBe("a\b");
    expect(escapeWindowsArg("a b")).toBe('"a b"');
    expect(escapeWindowsArg("a b\\")).toBe('"a b\\\\"');
  });

  test("the command line length counts the escapes, and quotes can exceed the limit", () => {
    expect(windowsCommandLineLength("c.exe", ["-p", "a b"])).toBe('c.exe -p "a b"'.length);
    const quotes = '"'.repeat(WINDOWS_COMMAND_LINE_MAX / 2);
    expect(windowsCommandLineTooLong("c.exe", ["--append-system-prompt", quotes])).toBe(true);
    expect(windowsCommandLineTooLong("c.exe", ["--append-system-prompt", "a".repeat(30_000)])).toBe(
      false,
    );
  });

  test("a claude that takes it is asked for its thinking's summaries, before a resume", () => {
    const flag = ["--thinking-display", "summarized"];
    const args = claudeTabArgs({ resume: "s1" }, undefined, "2.1.323");
    expect(args.slice(-4)).toEqual([...flag, "--resume", "s1"]);
    expect(claudeTabArgs({}, undefined, THINKING_DISPLAY_FROM).slice(-2)).toEqual(flag);
    // An older claude refuses the flag and does not start; an unknown one is not risked.
    for (const version of ["2.1.0", null, "garbage"]) {
      expect(claudeTabArgs({}, undefined, version)).not.toContain("--thinking-display");
    }
    expect(takesThinkingDisplay(THINKING_DISPLAY_FROM)).toBe(true);
    expect(takesThinkingDisplay("3.0.0")).toBe(true);
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
    expect(parseClaudeVersion("Node 22.14.0 was found\r\n  codex-cli 0.166.0\r\n")).toBe("0.166.0");
    expect(parseClaudeVersion("diagnostic: settings schema 2.1.318")).toBeNull();
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

  test("/config's list: no session, hooks or MCP servers, then the bare command", () => {
    const args = claudeCommandArgs({ kind: "configUsage" }, "/r");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args.slice(-1)).toEqual(["/config"]);
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
  test("an omitted default profile has the same environment in chat and the terminal", async () => {
    const profile: AgentProfile = {
      id: "claude-default",
      agent: "claude",
      name: "",
      color: "blue",
      dir: "",
      env: {
        CLAUDE_CONFIG_DIR: "/profiles/default",
        CUSTOM: "configured",
        nexus_hook_token: "stale",
        NEXUS_AGENT_SOCKET: "/stale.sock",
        NEXUS_OTHER: "stale",
      },
    };
    const { host, channel } = setup({}, undefined, undefined, (id) =>
      id === profile.id ? profile : null,
    );
    await host.start(WS, TAB, "/repo", {});
    const terminal = await host.terminalProfileEnv(WS, undefined);
    expect(terminal).toEqual(await host.terminalProfileEnv(WS, profile.id));
    expect(terminal).toEqual({ CLAUDE_CONFIG_DIR: "/profiles/default", CUSTOM: "configured" });
    const start = channel.calls.find(({ method }) => method === "chat.start")?.params;
    expect(start).toMatchObject({
      env: { ...terminal, NEXUS_AGENT_SOCKET: "/tmp/h.sock", NEXUS_HOOK_TOKEN: "tok" },
    });
    expect((start as { env: Record<string, string> }).env).not.toHaveProperty("NEXUS_OTHER");
    await host.transcript(WS, "session");
    await host.transcriptPage(WS, "session", undefined, {});
    await host.deleteSession(WS, "/repo", "session");
    expect(
      channel.calls.filter(
        ({ method }) =>
          method === "chat.transcript" ||
          method === "chat.transcriptPage" ||
          method === "chat.deleteSession",
      ),
    ).toEqual([
      {
        method: "chat.transcript",
        params: { sessionId: "session", configDir: "/profiles/default" },
      },
      {
        method: "chat.transcriptPage",
        params: { sessionId: "session", configDir: "/profiles/default" },
      },
      {
        method: "chat.deleteSession",
        params: { sessionId: "session", cwd: "/repo", configDir: "/profiles/default" },
      },
    ]);
  });

  test("passes a custom Claude profile to the wrapper and terminal on the workspace host", async () => {
    const connection: CustomConnection = {
      method: "custom",
      baseUrl: "http://127.0.0.1:8080",
      auth: "bearer",
      defaultModel: "custom-model",
      models: [{ id: "custom-model", label: "Custom" }],
    };
    const profile: AgentProfile = {
      id: "claude-default",
      agent: "claude",
      name: "",
      color: "blue",
      dir: "",
      connection,
      env: { ANTHROPIC_AUTH_TOKEN: "older key" },
    };
    const { host, channel } = setup(
      {},
      undefined,
      undefined,
      (id) => (id === profile.id ? profile : null),
      { connectionKey: async () => "sealed-key" },
    );
    expect(await host.start(WS, TAB, "/repo", {})).toMatchObject({ ok: true });
    expect(await host.terminalProfileEnv(WS, profile.id)).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "sealed-key",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
    });
    const launch = channel.calls.find(({ method }) => method === "chat.start")?.params;
    expect(launch).toMatchObject({
      args: expect.arrayContaining(["--model=custom-model"]),
      env: {
        ANTHROPIC_AUTH_TOKEN: "sealed-key",
        NEXUS_CLAUDE_MODEL_PICKER:
          '{"replaceBuiltInOptions":true,"options":[{"model":"custom-model","label":"Custom"}]}',
      },
    });
  });

  test("puts Codex's catalog on the workspace agent before launching Codex", async () => {
    const profile: AgentProfile = {
      id: "codex-default",
      agent: "codex",
      name: "",
      color: "cyan",
      dir: "",
      connection: {
        method: "custom",
        baseUrl: "http://127.0.0.1:8080/v1",
        defaultModel: "custom-model",
        models: [{ id: "custom-model" }],
      },
    };
    const { host, channel } = setup(
      {},
      undefined,
      undefined,
      (id) => (id === profile.id ? profile : null),
      { connectionKey: async () => "sealed-key" },
    );
    channel.found = { path: "/remote/bin/codex" };
    expect(await host.startCodex(WS, TAB, "/repo", {})).toMatchObject({ ok: true });
    const calls = channel.calls.filter(({ method }) =>
      ["chat.writeCodexCatalog", "chat.start"].includes(method),
    );
    expect(calls).toMatchObject([
      {
        method: "chat.writeCodexCatalog",
        params: { catalog: { models: [{ slug: "custom-model" }] } },
      },
      {
        method: "chat.start",
        params: {
          program: "/remote/bin/codex",
          args: expect.arrayContaining([
            'model_catalog_json="/home/u/.nexus-code/run/codex-catalogs/catalog.json"',
          ]),
          env: { NEXUS_PROFILE_CODEX_API_KEY: "sealed-key" },
        },
      },
    ]);
    expect(await host.terminalProfileEnv(WS, profile.id)).toEqual({});
  });

  test("a missing or wrong-agent profile cannot spawn or read, delete, or stage default history", async () => {
    const { host, channel } = setup({}, undefined, undefined);
    for (const id of ["missing", "codex-default"]) {
      expect(await host.start(WS, TAB, "/repo", {}, id)).toMatchObject({
        ok: false,
        reason: "failed",
      });
      await expect(host.transcript(WS, "session", id)).rejects.toThrow(/profile/i);
      await expect(host.transcriptPage(WS, "session", id, {})).rejects.toThrow(/profile/i);
      await expect(host.deleteSession(WS, "/repo", "session", id)).rejects.toThrow(/profile/i);
    }
    await expect(host.stageThread(WS, "thread", { fromProfileId: "missing" })).rejects.toThrow(
      /profile/i,
    );
    expect(
      channel.calls.some(({ method }) =>
        /chat\.(start|transcript|deleteSession|stageThread)/.test(method),
      ),
    ).toBe(false);
  });

  test("a killed chat task ends its background agent in the phone and desktop session lists", async () => {
    const activity = new SessionActivityLog(() => 1234);
    const { host, channel } = setup({}, undefined, (workspaceId, tabId, message) =>
      activity.noteTask(workspaceId, tabId, message),
    );
    await host.start(WS, TAB, "/repo", {});
    const input = { subagent_type: "Explore", run_in_background: true };
    activity.noteHook(WS, TAB, "pre-tool-use", {
      tool_name: "Agent",
      tool_use_id: "toolu_agent",
      tool_input: input,
    });
    activity.noteHook(WS, TAB, "subagent-start", { agent_id: "agent-A", agent_type: "Explore" });
    const current = () => activity.get(WS, TAB)?.agents ?? [];
    expect(sessionAgents(current())?.map((agent) => agent.id)).toEqual(["agent-A"]);
    expect(liveAgents(current())).toHaveLength(1);
    channel.emit("chat.line", {
      workspaceId: WS,
      tabId: TAB,
      dir: "out",
      message: {
        type: "system",
        subtype: "task_started",
        task_type: "local_agent",
        task_id: "task-A",
        tool_use_id: "toolu_agent",
      },
    });
    // The stream can report the kill before the async Agent result hook reaches main.
    channel.emit("chat.line", {
      workspaceId: WS,
      tabId: TAB,
      dir: "out",
      replay: true,
      message: {
        type: "system",
        subtype: "task_notification",
        task_id: "task-A",
        status: "killed",
      },
    });
    activity.noteHook(WS, TAB, "post-tool-use", {
      tool_name: "Agent",
      tool_use_id: "toolu_agent",
      tool_input: input,
      tool_response: { status: "async_launched", agentId: "agent-A" },
    });
    expect(current()[0]).toMatchObject({ id: "agent-A", state: "stopped", end: 1234 });
    expect(sessionAgents(current())).toBeUndefined();
    expect(liveAgents(current())).toHaveLength(0);
    host.dispose();
  });

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
    const probe = channel.calls.find(({ method }) => method === "chat.exec")?.params as {
      program: string;
    };
    expect(start.env.NEXUS_CLAUDE_PROGRAM).toBe(probe.program);
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
        getSpawnHookInfo: async () => null,
        getWrapperBinDir: () => "C:\\Users\\u\\.nexus-code\\cli",
        getWrapperAgentBin: () => null,
        getWrapperShimDir: () => "C:\\Users\\u\\.nexus-code\\shim\\ws",
        isLocal: () => true,
      },
      broadcast: () => {},
      windowsAgentFiles: async () => ({
        binDir: "C:\\Users\\u\\.nexus-code\\bin",
        settingsPath: "C:\\Users\\u\\.nexus-code\\bin\\claude-settings.json",
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

  describe("Windows instructions file", () => {
    function windowsHost(instructions: string, files: string[], removed: string[]) {
      const channel = new FakeChannel();
      channel.found = { path: "C:/Users/u/.local/bin/claude.exe" };
      channel.versionOutput = "2.1.321 (Claude Code)\n";
      const host = new ChatHost({
        workspaceManager: {
          getAgentChannel: async () => channel,
          tryGetAgentChannel: async () => channel,
          onProviderReady: () => () => {},
          getSpawnHookInfo: async () => null,
          getWrapperBinDir: () => null,
          getWrapperAgentBin: () => null,
          getWrapperShimDir: () => null,
          isLocal: () => true,
        },
        broadcast: () => {},
        windowsAgentFiles: async () => ({ binDir: "C:/bin" }),
        instructions: () => instructions,
        promptFiles: {
          write: async (_tab, text) => {
            files.push(text);
            return `C:/run/p${files.length}.txt`;
          },
          remove: async (file) => {
            removed.push(file);
          },
        },
      });
      return { channel, host };
    }
    const argsOf = (channel: FakeChannel) =>
      (channel.calls.find((c) => c.method === "chat.start")?.params as { args: string[] }).args;

    test("passes the merged prompt by file, and removes it when the tab closes", async () => {
      const files: string[] = [];
      const removed: string[] = [];
      const { channel, host } = windowsHost("Use Korean.", files, removed);
      await host.start(WS, TAB, "C:/repo", {});
      const args = argsOf(channel);
      expect(args).not.toContain("--append-system-prompt");
      expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("C:/run/p1.txt");
      expect(files).toEqual([`${CLAUDE_TAB_PROMPT}\n\nUse Korean.`]);
      expect(removed).toEqual([]);
      await host.closeWorkspace(WS, channel);
      expect(removed).toEqual(["C:/run/p1.txt"]);
    });

    test("a restart writes a new file and removes the old one", async () => {
      const files: string[] = [];
      const removed: string[] = [];
      const { host } = windowsHost("A", files, removed);
      await host.start(WS, TAB, "C:/repo", {});
      await host.start(WS, TAB, "C:/repo", {});
      expect(files).toHaveLength(2);
      expect(removed).toEqual(["C:/run/p1.txt"]);
    });

    test("without instructions the prompt stays on the command line", async () => {
      const files: string[] = [];
      const { channel, host } = windowsHost("", files, []);
      await host.start(WS, TAB, "C:/repo", {});
      expect(files).toEqual([]);
      expect(argsOf(channel)).toContain("--append-system-prompt");
    });

    test("an unknown claude version keeps the argument, and a line too long is refused", async () => {
      const files: string[] = [];
      const { channel, host } = windowsHost('"'.repeat(20_000), files, []);
      channel.versionOutput = "not a version\n";
      const result = await host.start(WS, TAB, "C:/repo", {});
      expect(files).toEqual([]);
      expect(result.ok).toBe(false);
      expect(channel.calls.some((c) => c.method === "chat.start")).toBe(false);
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

  test("cli receives the agent's timeout result after the child and its pipes are closed", async () => {
    jest.useFakeTimers();
    const { channel, host } = setup();
    const original = channel.call.bind(channel);
    const dispatched = Promise.withResolvers<void>();
    const result = { code: -1, stdout: "partial output", stderr: "", timedOut: true };
    channel.call = async <T>(method: string, params?: unknown, options?: AgentCallOptions) => {
      if (method !== "chat.exec") return original<T>(method, params);
      const { timeoutMs } = params as { timeoutMs: number };
      const command = Promise.withResolvers<T>();
      const reply = setTimeout(() => command.resolve(result as T), timeoutMs + 1_000);
      const cutoff = setTimeout(
        () => command.reject(new Error("agent request timed out")),
        options?.timeoutMs ?? 30_000,
      );
      dispatched.resolve();
      return command.promise.finally(() => {
        clearTimeout(reply);
        clearTimeout(cutoff);
      });
    };
    try {
      const pending = host.cli(WS, "/repo", { kind: "plugins" }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await dispatched.promise;
      jest.advanceTimersByTime(31_000);
      expect(await pending).toEqual({ value: result });
    } finally {
      host.dispose();
      jest.useRealTimers();
    }
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
      tabGeneration: expect.any(String),
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

  test("Codex turns carry host guidance alongside the original message", async () => {
    let enabled = true;
    const { channel, host } = setup({}, (workspace, tab) =>
      enabled ? { status: `guidance for ${workspace}/${tab}`, commands: "nexus help" } : undefined,
    );
    const message = { method: "turn/start", params: { input: [{ type: "text", text: "hi" }] } };
    await host.send(WS, TAB, message);
    expect(channel.calls.at(-1)).toEqual({
      method: "chat.send",
      params: {
        workspaceId: WS,
        tabId: TAB,
        message,
        codexContext: {
          files: CLAUDE_TAB_PROMPT,
          cli: { status: `guidance for ${WS}/${TAB}`, commands: "nexus help" },
        },
      },
    });
    enabled = false;
    await host.send(WS, TAB, message);
    expect(channel.calls.at(-1)?.params).toMatchObject({
      message,
      codexContext: { files: CLAUDE_TAB_PROMPT, cli: undefined },
    });
    for (const method of ["thread/start", "thread/resume", "thread/fork", "turn/steer"]) {
      await host.send(WS, TAB, { method });
      expect(channel.calls.at(-1)?.params).toEqual({
        workspaceId: WS,
        tabId: TAB,
        message: { method },
      });
    }
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
    expect(status).toEqual([
      `completed ${WS} ${TAB}`,
      `error ${WS} ${TAB}`,
      `interrupted ${WS} ${TAB}`,
      `exit ${WS} ${TAB}`,
    ]);
  });

  test("reports success, error and interruption when Claude sends only a result", async () => {
    const { channel, host, status } = setup();
    await host.start(WS, TAB, "/repo", {});
    for (const result of [
      { subtype: "success" },
      { subtype: "success", is_error: true },
      { subtype: "success", terminal_reason: "interrupted" },
    ]) {
      channel.emit("chat.line", {
        workspaceId: WS,
        tabId: TAB,
        dir: "out",
        message: { type: "result", ...result },
      });
    }
    expect(status).toEqual([
      `completed ${WS} ${TAB}`,
      `error ${WS} ${TAB}`,
      `interrupted ${WS} ${TAB}`,
    ]);
  });

  test("closing a chat during version discovery cancels its late spawn", async () => {
    const { host, channel } = setup();
    const version = Promise.withResolvers<void>();
    channel.versionWait = version.promise;
    const start = host.start(WS, TAB, "/repo", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(channel.calls.some((call) => call.method === "chat.exec")).toBe(true);
    await host.call("close", { workspaceId: WS, tabId: TAB });
    version.resolve();
    expect(await start).toMatchObject({ ok: false });
    expect(channel.calls.some((call) => call.method === "chat.start")).toBe(false);
    expect(await host.start(WS, TAB, "/repo", {})).toMatchObject({ ok: true });
    const generation = (method: string) =>
      (channel.calls.find((call) => call.method === method)?.params as { tabGeneration?: string })
        ?.tabGeneration;
    const closed = generation("chat.close");
    expect(typeof closed).toBe("string");
    expect(generation("chat.start")).not.toBe(closed);
  });

  test("an old process exit and result leave the replacement's hook state alone", async () => {
    const { channel, host, status, events } = setup();
    await host.start(WS, TAB, "/repo", {});
    channel.emit("chat.line", {
      workspaceId: WS,
      tabId: TAB,
      dir: "sys",
      message: { event: "start", processGeneration: "new" },
    });
    channel.emit("chat.line", {
      workspaceId: WS,
      tabId: TAB,
      dir: "out",
      processGeneration: "old",
      message: { type: "result", subtype: "error" },
    });
    channel.emit("chat.exit", { workspaceId: WS, tabId: TAB, processGeneration: "old" });
    expect(status).toEqual([]);
    expect(events.map((event) => event.event)).toEqual(["line"]);
    channel.emit("chat.exit", { workspaceId: WS, tabId: TAB, processGeneration: "new" });
    expect(status).toEqual([`exit ${WS} ${TAB}`]);
  });

  test("removing a workspace sends chat.close and forgets its open tab intents", async () => {
    const { host, channel, status } = setup();
    await host.start(WS, TAB, "/repo", {});
    const generation = (
      channel.calls.find((call) => call.method === "chat.start")?.params as {
        tabGeneration: string;
      }
    ).tabGeneration;
    await host.closeWorkspace(WS, channel);
    expect(channel.calls.filter((call) => call.method === "chat.close")).toEqual([
      { method: "chat.close", params: { workspaceId: WS, tabId: TAB, tabGeneration: generation } },
    ]);
    expect(status).toEqual([`exit ${WS} ${TAB}`]);
    expect((host as unknown as { tabIntents: ReadonlyMap<string, unknown> }).tabIntents.size).toBe(
      0,
    );
  });

  test("removing a disconnected workspace forgets chats without connecting again", async () => {
    const lookup = mock(async () => {
      throw new Error("workspace offline");
    });
    const { host, channel, status } = setup({ tryGetAgentChannel: lookup });
    await host.startCodex(WS, TAB, "/repo", {});
    await host.closeWorkspace(WS, null);
    expect(lookup).not.toHaveBeenCalled();
    expect(channel.calls.some((call) => call.method === "chat.close")).toBe(false);
    expect(status).toEqual([`exit ${WS} ${TAB}`]);
    expect((host as unknown as { tabIntents: ReadonlyMap<string, unknown> }).tabIntents.size).toBe(
      0,
    );
  });

  test("reattach recognizes a missed start without reverting to an older replayed process", async () => {
    const { channel, host, status } = setup();
    await host.start(WS, TAB, "/repo", {});
    const start = (seq: number, generation: string, replay: boolean) =>
      channel.emit("chat.line", {
        workspaceId: WS,
        tabId: TAB,
        seq,
        replay,
        dir: "sys",
        message: { event: "start", processGeneration: generation },
      });
    start(1, "old", false);
    start(10, "current", true);
    start(1, "old", true);
    channel.emit("chat.exit", { workspaceId: WS, tabId: TAB, processGeneration: "current" });
    expect(status).toEqual([`exit ${WS} ${TAB}`]);
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
