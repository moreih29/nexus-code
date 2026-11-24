import { describe, expect, mock, test } from "bun:test";
import type { PtyChannelOptions } from "../../../../../src/main/features/pty/ipc";
import type { ShellHost } from "../../../../../src/main/features/pty/shells";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../../src/main/infra/agent/channel";
import type { CustomShell, ShellChoice } from "../../../../../src/shared/pty/shell";

const mockHandle = mock((_channel: string, _handler: unknown) => {});

mock.module("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: mockHandle, on: mock(() => {}) },
  webContents: { getAllWebContents: () => [] },
}));

const { setupRouter } = await import("../../../../../src/main/infra/ipc-router");
const { startAgentPtyHost } = await import("../../../../../src/main/features/pty/agent-host");
const { registerPtyChannel } = await import("../../../../../src/main/features/pty/ipc");

setupRouter();

const WORKSPACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TAB_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type IpcHandler = (
  event: { sender?: { id?: number } },
  channelName: string,
  method: string,
  args: unknown,
) => Promise<unknown>;

interface SpawnCall {
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
}

class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly spawnCalls: SpawnCall[] = [];
  attach = false;

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (method === "pty.spawn") {
      this.spawnCalls.push(params as SpawnCall);
      return (this.attach ? { pid: 42, attached: true } : { pid: 42 }) as TResult;
    }
    return {} as TResult;
  }
  fire(): void {}
  on(_event: string, _callback: ChannelEventCallback): () => void {
    return () => {};
  }
  onLifecycle(_callback: ChannelLifecycleCallback): () => void {
    return () => {};
  }
  dispose(): void {}
}

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const windowsHost: ShellHost = {
  platform: "win32",
  env: {
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    Path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
  },
  homedir: "C:\\Users\\me",
  isFile: (p) =>
    [
      POWERSHELL,
      GIT_BASH,
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Windows\\system32\\cmd.exe",
    ]
      .map((f) => f.toLowerCase())
      .includes(p.toLowerCase()),
  readText: () => null,
  realpath: (p) => p,
};

function setup(opts: {
  local?: boolean;
  defaultShell?: ShellChoice;
  customShells?: CustomShell[];
  host?: ShellHost;
  wrapper?: { binDir: string; shell: string; shimDir: string };
  windowsAgentFiles?: PtyChannelOptions["windowsAgentFiles"];
  profileEnv?: PtyChannelOptions["profileEnv"];
}): { call: (method: string, args: unknown) => Promise<unknown>; agent: FakeAgentChannel } {
  const agent = new FakeAgentChannel();
  const agentHost = startAgentPtyHost({
    getAgentChannel: async () => agent,
    tryGetAgentChannel: async () => agent,
  });
  const wm: PtyChannelOptions["workspaceManager"] = {
    getName: () => "ws",
    connect: async () => {},
    getAgentChannel: async () => agent,
    getWrapperBinDir: () => opts.wrapper?.binDir ?? null,
    getWrapperAgentBin: () => null,
    getWrapperShell: () => opts.wrapper?.shell ?? null,
    getWrapperShimDir: () => opts.wrapper?.shimDir ?? null,
    isLocal: () => opts.local ?? true,
  };
  registerPtyChannel({
    agentHost,
    workspaceManager: wm,
    getDefaultShell: () => opts.defaultShell,
    getCustomShells: () => opts.customShells,
    shellHost: opts.host ?? windowsHost,
    windowsAgentFiles: opts.windowsAgentFiles,
    ...(opts.profileEnv ? { profileEnv: opts.profileEnv } : {}),
  });
  const calls = mockHandle.mock.calls as [string, IpcHandler][];
  const handler = calls.filter(([channel]) => channel === "ipc:call").at(-1)?.[1];
  if (!handler) throw new Error("ipc:call was not registered");
  return {
    call: async (method, args) => {
      const result = (await handler({}, "pty", method, args)) as { ok?: boolean; value?: unknown };
      return result.ok === true ? result.value : result;
    },
    agent,
  };
}

const spawnArgs = (extra: Record<string, unknown> = {}) => ({
  workspaceId: WORKSPACE_ID,
  tabId: TAB_ID,
  cwd: "C:\\work",
  cols: 80,
  rows: 24,
  ...extra,
});

describe("pty.spawn — the shell of a local terminal", () => {
  test("a tab whose added shell was removed falls back and is reported without a name", async () => {
    const { call, agent } = setup({ customShells: [] });
    const result = await call("spawn", spawnArgs({ shell: { kind: "custom", id: "ps-nologo" } }));

    expect(agent.spawnCalls[0]?.shell).toBeUndefined();
    expect(result).toEqual({ pid: 42, shellPath: POWERSHELL, missingShell: "" });
  });

  test("a tab whose shell is gone falls back to the default shell from the settings", async () => {
    const { call, agent } = setup({ defaultShell: { kind: "detected", id: "git-bash" } });
    const result = await call("spawn", spawnArgs({ shell: { kind: "detected", id: "pwsh" } }));

    expect(agent.spawnCalls[0]).toMatchObject({ shell: GIT_BASH, args: ["--login", "-i"] });
    expect(result).toEqual({ pid: 42, shellPath: GIT_BASH, missingShell: "PowerShell" });
  });

  test("a shell that's gone falls back to the system default and is reported", async () => {
    const { call, agent } = setup({ defaultShell: { kind: "detected", id: "pwsh" } });
    const result = await call("spawn", spawnArgs());

    expect(agent.spawnCalls[0]?.shell).toBeUndefined();
    expect(result).toEqual({ pid: 42, shellPath: POWERSHELL, missingShell: "PowerShell" });
  });

  test("a tab that reconnects to its running shell reports that shell, not the setting", async () => {
    const settings: { defaultShell?: ShellChoice } = {};
    const { call, agent } = setup({
      get defaultShell() {
        return settings.defaultShell;
      },
      customShells: [],
    });
    await call("spawn", spawnArgs({ shell: { kind: "detected", id: "git-bash" } }));

    settings.defaultShell = { kind: "custom", id: "removed" };
    agent.attach = true;
    const result = await call("spawn", spawnArgs({ shell: { kind: "detected", id: "pwsh" } }));

    expect(result).toEqual({ pid: 42, shellPath: GIT_BASH });
  });

  test("an SSH workspace never gets a local shell", async () => {
    const { call, agent } = setup({
      local: false,
      defaultShell: { kind: "detected", id: "git-bash" },
    });
    const result = await call("spawn", spawnArgs({ shell: { kind: "detected", id: "git-bash" } }));

    expect(agent.spawnCalls[0]?.shell).toBeUndefined();
    expect(result).toEqual({ pid: 42 });
  });

  test("the zsh/bash shim follows the chosen shell, not $SHELL", async () => {
    const host: ShellHost = {
      platform: "darwin",
      env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      homedir: "/Users/me",
      isFile: (p) => ["/bin/zsh", "/bin/bash"].includes(p),
      readText: (p) => (p === "/etc/shells" ? "/bin/zsh\n/bin/bash\n" : null),
      realpath: (p) => p,
    };
    const { call, agent } = setup({
      host,
      defaultShell: { kind: "detected", id: "/bin/bash" },
      wrapper: { binDir: "/w/bin", shell: "/bin/zsh", shimDir: "/w/shim" },
    });
    await call("spawn", spawnArgs({ cwd: "/repo" }));

    const sent = agent.spawnCalls[0];
    expect(sent?.shell).toBe("/bin/bash");
    expect(sent?.args).toEqual(["--rcfile", "/w/shim/bashrc", "-i"]);
    expect(sent?.env?.ZDOTDIR).toBeUndefined();
  });
});

describe("pty.spawn — claude's hooks and codex's --no-daemon in a local Windows terminal", () => {
  const BIN = "C:\\Users\\me\\.nexus-code\\bin";
  const LAUNCHERS = "C:\\Users\\me\\.nexus-code\\cli";
  const SETTINGS = "C:\\Users\\me\\.nexus-code\\claude-settings.json";
  const SERVERLESS = "C:\\Users\\me\\.nexus-code\\claude-settings-serverless.json";
  const CMD_CLAUDE =
    `doskey claude=set "NEXUS_CLAUDE_TAB_ID=%NEXUS_TAB_ID%" ^& ` +
    `claude --settings "%NEXUS_CLAUDE_SETTINGS%" $* ^& set "NEXUS_CLAUDE_TAB_ID="`;
  const wrapper = { binDir: LAUNCHERS, shell: "", shimDir: "C:\\Users\\me\\.nexus-code\\shim\\ws" };
  const files = async () => ({
    binDir: BIN,
    settingsPath: SETTINGS,
    serverlessSettingsPath: SERVERLESS,
    cmdLauncherDir: `${BIN}\\cmd`,
  });

  test("PowerShell, the system default, defines claude and codex, with the serverless hooks here", async () => {
    const { call, agent } = setup({ wrapper, windowsAgentFiles: files });
    await call("spawn", spawnArgs());

    const sent = agent.spawnCalls[0];
    expect(sent?.shell).toBe(POWERSHELL);
    expect(sent?.args?.slice(0, 2)).toEqual(["-NoExit", "-EncodedCommand"]);
    const script = Buffer.from(sent?.args?.at(-1) ?? "", "base64").toString("utf16le");
    expect(script).toContain("function global:claude {");
    expect(script).toContain("function global:codex {");
    expect(sent?.env?.NEXUS_CLAUDE_SETTINGS).toBe(SERVERLESS);
    expect(sent?.env?.NEXUS_CLAUDE_SERVERLESS_SETTINGS).toBeUndefined();
    expect(sent?.env?.NEXUS_IN_APP).toBe("1");
    expect(sent?.env?.NEXUS_TAB_ID).toBe(TAB_ID);
    expect(sent?.env?.NEXUS_WRAPPER_SELF_DIR).toBe(LAUNCHERS);
    expect(sent?.env?.ZDOTDIR).toBeUndefined();
  });

  test("Git Bash keeps its arguments and gets the wrapper first on PATH", async () => {
    const { call, agent } = setup({
      wrapper,
      windowsAgentFiles: files,
      defaultShell: { kind: "detected", id: "git-bash" },
    });
    await call("spawn", spawnArgs());

    const sent = agent.spawnCalls[0];
    expect(sent?.shell).toBe(GIT_BASH);
    expect(sent?.args).toEqual(["--login", "-i"]);
    expect(sent?.env?.NEXUS_WRAPPER_SELF_DIR).toBe(BIN);
  });

  test("cmd gets the Codex launcher directory and Claude macro", async () => {
    const { call, agent } = setup({
      wrapper,
      windowsAgentFiles: files,
      defaultShell: { kind: "detected", id: "cmd" },
    });
    await call("spawn", spawnArgs());

    const sent = agent.spawnCalls[0];
    expect(sent?.args).toEqual(["/k", "%NEXUS_CMD_INIT%"]);
    expect(sent?.env?.NEXUS_CMD_INIT).toBe(CMD_CLAUDE);
    expect(sent?.env?.NEXUS_CMD_CODEX_DIR).toBe(`${BIN}\\cmd`);
  });

  test("cmd keeps the Claude macro when its Codex launcher is unavailable", async () => {
    const { call, agent } = setup({
      wrapper,
      windowsAgentFiles: async () => ({
        binDir: BIN,
        settingsPath: SETTINGS,
      }),
      defaultShell: { kind: "detected", id: "cmd" },
    });
    await call("spawn", spawnArgs());

    expect(agent.spawnCalls[0]?.env?.NEXUS_CMD_INIT).toBe(CMD_CLAUDE);
  });

  test("without the wrappers, the shell starts as it is, with the nexus launchers", async () => {
    const { call, agent } = setup({ wrapper, windowsAgentFiles: async () => null });
    await call("spawn", spawnArgs());

    const sent = agent.spawnCalls[0];
    expect(sent?.args).toBeUndefined();
    expect(sent?.env?.NEXUS_WRAPPER_SELF_DIR).toBe(LAUNCHERS);
    expect(sent?.env?.NEXUS_CLAUDE_SETTINGS).toBeUndefined();
  });
});

describe("pty.spawn — a terminal opened for an agent profile", () => {
  const profileEnv: PtyChannelOptions["profileEnv"] = async (_w, id) =>
    id === "codex-ab12"
      ? { CODEX_HOME: "C:Usersme.codex-work", WORK: "1" }
      : id === "codex-default"
        ? {}
        : null;

  test("its shell runs with what a chat of the profile runs with", async () => {
    const { call, agent } = setup({ profileEnv });
    await call("spawn", spawnArgs({ profile: "codex-ab12", env: { TERM_PROGRAM: "nexus" } }));
    expect(agent.spawnCalls[0]?.env).toMatchObject({
      CODEX_HOME: "C:Usersme.codex-work",
      WORK: "1",
      TERM_PROGRAM: "nexus",
    });
    await call("spawn", spawnArgs({ profile: "codex-default" }));
    expect(agent.spawnCalls[1]?.env?.CODEX_HOME).toBeUndefined();
  });

  test("one that is not there fails: never the default folder in its place", async () => {
    const { call, agent } = setup({ profileEnv });
    expect(await call("spawn", spawnArgs({ profile: "codex-gone" }))).toMatchObject({
      ok: false,
      kind: "not-found",
      category: "failed",
      message: "no profile codex-gone",
    });
    expect(agent.spawnCalls).toEqual([]);
  });

  test("loads the default profile and merges Windows variable names before the shell runs", async () => {
    const { call, agent } = setup({
      windowsAgentFiles: async () => null,
      profileEnv: async (_ws, id) =>
        id === undefined
          ? { PATH: "profile", Mode: "first", MODE: "last", nexus_hook_token: "stale" }
          : null,
    });
    await call("spawn", spawnArgs({ env: { Path: "caller", mode: "caller" } }));
    const env = agent.spawnCalls[0]?.env;
    expect(env).toMatchObject({ PATH: "profile", MODE: "last" });
    expect(env).not.toHaveProperty("Path");
    expect(env).not.toHaveProperty("mode");
    expect(env).not.toHaveProperty("Mode");
    expect(env).not.toHaveProperty("nexus_hook_token");
  });
});
