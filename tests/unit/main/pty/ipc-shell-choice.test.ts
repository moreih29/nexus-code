/**
 * ipc-shell-choice.test.ts — the shell a local terminal starts with
 * (Settings › Terminal › Default shell, or the tab's own shell), its
 * fallback when that shell is gone, and that SSH workspaces never get one.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";
import type { PtyChannelOptions } from "../../../../src/main/features/pty/ipc";
import type { ShellHost } from "../../../../src/main/features/pty/shells";
import type { CustomShell, ShellChoice } from "../../../../src/shared/pty/shell";

const mockHandle = mock((_channel: string, _handler: unknown) => {});

mock.module("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: mockHandle, on: mock(() => {}) },
  webContents: { getAllWebContents: () => [] },
}));

const { setupRouter } = await import("../../../../src/main/infra/ipc-router");
const { startAgentPtyHost } = await import("../../../../src/main/features/pty/agent-host");
const { registerPtyChannel } = await import("../../../../src/main/features/pty/ipc");

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

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (method === "pty.spawn") {
      this.spawnCalls.push(params as SpawnCall);
      return { pid: 42 } as TResult;
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

// A Windows machine with Windows PowerShell and Git Bash.
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
}): { call: (method: string, args: unknown) => Promise<unknown>; agent: FakeAgentChannel } {
  const agent = new FakeAgentChannel();
  const agentHost = startAgentPtyHost({
    getAgentChannel: async () => agent,
    tryGetAgentChannel: async () => agent,
  });
  const wm: PtyChannelOptions["workspaceManager"] = {
    getName: () => "ws",
    activate: async () => {},
    getHookInfo: () => null,
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
  });
  const calls = mockHandle.mock.calls as [string, IpcHandler][];
  const handler = calls.filter(([channel]) => channel === "ipc:call").at(-1)?.[1];
  if (!handler) throw new Error("ipc:call was not registered");
  return {
    // Handlers return either a plain value (spawn) or an IpcResult.
    call: async (method, args) => {
      const result = (await handler({}, "pty", method, args)) as { ok?: boolean; value?: unknown };
      if (result.ok === false) throw new Error(JSON.stringify(result));
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
  test("no choice: the agent picks the system default, and main reports which one", async () => {
    const { call, agent } = setup({});
    const result = await call("spawn", spawnArgs());

    expect(agent.spawnCalls[0]?.shell).toBeUndefined();
    expect(agent.spawnCalls[0]?.args).toBeUndefined();
    expect(result).toEqual({ pid: 42, shellPath: POWERSHELL });
  });

  test("the default shell from the settings starts with its arguments", async () => {
    const { call, agent } = setup({ defaultShell: { kind: "detected", id: "git-bash" } });
    const result = await call("spawn", spawnArgs());

    expect(agent.spawnCalls[0]).toMatchObject({ shell: GIT_BASH, args: ["--login", "-i"] });
    expect(result).toEqual({ pid: 42, shellPath: GIT_BASH });
  });

  test("the tab's own shell wins over the setting", async () => {
    const { call, agent } = setup({ defaultShell: { kind: "detected", id: "git-bash" } });
    await call("spawn", spawnArgs({ shell: { kind: "detected", id: "powershell" } }));

    expect(agent.spawnCalls[0]?.shell).toBe(POWERSHELL);
    expect(agent.spawnCalls[0]?.args).toBeUndefined();
  });

  test("an added shell starts with its program and arguments", async () => {
    const { call, agent } = setup({
      customShells: [{ id: "ps-nologo", name: "PS", path: "powershell", args: ["-NoLogo"] }],
    });
    const result = await call("spawn", spawnArgs({ shell: { kind: "custom", id: "ps-nologo" } }));

    expect(agent.spawnCalls[0]).toMatchObject({ shell: POWERSHELL, args: ["-NoLogo"] });
    expect(result).toEqual({ pid: 42, shellPath: POWERSHELL });
  });

  test("a tab whose added shell was removed falls back and is reported without a name", async () => {
    const { call, agent } = setup({ customShells: [] });
    const result = await call("spawn", spawnArgs({ shell: { kind: "custom", id: "ps-nologo" } }));

    expect(agent.spawnCalls[0]?.shell).toBeUndefined();
    expect(result).toEqual({ pid: 42, shellPath: POWERSHELL, missingShell: "" });
  });

  test("a shell that's gone falls back to the system default and is reported", async () => {
    const { call, agent } = setup({ defaultShell: { kind: "detected", id: "pwsh" } });
    const result = await call("spawn", spawnArgs());

    expect(agent.spawnCalls[0]?.shell).toBeUndefined();
    expect(result).toEqual({ pid: 42, shellPath: POWERSHELL, missingShell: "PowerShell" });
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
    // bash takes the shim through --rcfile; zsh's ZDOTDIR is not set.
    expect(sent?.args).toEqual(["--rcfile", "/w/shim/bashrc", "-i"]);
    expect(sent?.env?.ZDOTDIR).toBeUndefined();
  });
});

describe("pty.listShells and pty.findShell", () => {
  test("lists the installed shells and the system default", async () => {
    const { call } = setup({});
    const result = (await call("listShells", undefined)) as {
      shells: { id: string }[];
      systemDefault: { id: string };
    };
    expect(result.shells.map((s) => s.id)).toEqual(["powershell", "cmd", "git-bash"]);
    expect(result.systemDefault.id).toBe("powershell");
  });

  test("finds a custom shell's program, or reports null", async () => {
    const { call } = setup({});
    expect(await call("findShell", { program: "powershell" })).toEqual({ path: POWERSHELL });
    expect(await call("findShell", { program: "nu" })).toEqual({ path: null });
  });
});
