import { describe, expect, test } from "bun:test";
import type { IPtyForkOptions } from "node-pty";

import type { TerminalOpenCommand } from "../../../shared/src/contracts/terminal-ipc";
import type { TerminalTabId } from "../../../shared/src/contracts/terminal-tab";
import {
  type TerminalHostClearTimeout,
  type TerminalHostEnvironmentResolver,
  type TerminalHostLogger,
  type TerminalHostPty,
  type TerminalHostSetTimeout,
  type TerminalHostSpawnFactory,
  TerminalHost,
} from "./terminal-host";

const DEFAULT_TAB_ID = "tt_ws_alpha_001" as TerminalTabId;

describe("TerminalHost", () => {
  test("spawns with shell-environment resolver defaults and merges env overrides", async () => {
    const fakePty = new FakePty(4312);
    const resolver = createResolver({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        FROM_BASE: "yes",
      },
      defaultShell: "/bin/zsh",
      defaultShellArgs: ["-l", "-i"],
    });
    const spawnCalls: SpawnCall[] = [];
    const host = await createTerminalHost({
      pty: fakePty,
      resolver,
      openCommand: {
        ...createOpenCommand(),
        envOverrides: {
          PATH: "/custom/bin",
          FROM_OVERRIDE: "yes",
        },
      },
      spawnFactory: createCaptureSpawnFactory(fakePty, spawnCalls),
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual({
      file: "/bin/zsh",
      args: ["-l", "-i"],
      options: {
        name: "xterm-256color",
        cols: 120,
        rows: 32,
        cwd: undefined,
        env: {
          PATH: "/custom/bin",
          TERM: "xterm-256color",
          LANG: "en_US.UTF-8",
          FROM_BASE: "yes",
          FROM_OVERRIDE: "yes",
        },
      },
    });
    expect(host.toOpenedEvent()).toEqual({
      type: "terminal/opened",
      tabId: DEFAULT_TAB_ID,
      workspaceId: "ws_alpha",
      pid: 4312,
    });

    expect(resolver.getBaseEnvCalls).toBe(1);
    expect(resolver.getDefaultShellCalls).toBe(1);
    expect(resolver.getDefaultShellArgsCalls).toBe(1);
  });

  test("prefers explicit shell/shellArgs/cwd overrides from terminal open command", async () => {
    const fakePty = new FakePty(7891);
    const resolver = createResolver({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        TERM: "xterm-256color",
      },
      defaultShell: "/bin/zsh",
      defaultShellArgs: ["-l", "-i"],
    });
    const spawnCalls: SpawnCall[] = [];

    await createTerminalHost({
      pty: fakePty,
      resolver,
      openCommand: {
        ...createOpenCommand(),
        shell: "/bin/bash",
        shellArgs: ["--noprofile", "--norc"],
        cwd: "/tmp/workspace-alpha",
        envOverrides: {
          LANG: "ko_KR.UTF-8",
        },
      },
      spawnFactory: createCaptureSpawnFactory(fakePty, spawnCalls),
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.file).toBe("/bin/bash");
    expect(spawnCalls[0]?.args).toEqual(["--noprofile", "--norc"]);
    expect(spawnCalls[0]?.options.cwd).toBe("/tmp/workspace-alpha");
    expect(spawnCalls[0]?.options.env).toEqual({
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
      LANG: "ko_KR.UTF-8",
    });

    expect(resolver.getDefaultShellCalls).toBe(0);
    expect(resolver.getDefaultShellArgsCalls).toBe(0);
  });

  test("emits stdout chunks with deterministic, monotonic seq values", async () => {
    const fakePty = new FakePty(2001);
    const host = await createTerminalHost({
      pty: fakePty,
    });

    const chunks: Array<{ seq: number; data: string }> = [];
    host.onStdout((chunk) => {
      chunks.push({ seq: chunk.seq, data: chunk.data });
    });

    fakePty.emitData("first");
    fakePty.emitData("second");
    fakePty.emitData("third");

    expect(chunks).toEqual([
      { seq: 0, data: "first" },
      { seq: 1, data: "second" },
      { seq: 2, data: "third" },
    ]);
  });

  test("forwards write/input and resize commands to the underlying PTY", async () => {
    const fakePty = new FakePty(2002);
    const host = await createTerminalHost({
      pty: fakePty,
    });

    host.write("npm test\n");
    host.resize(180, 50);

    expect(fakePty.writeCalls).toEqual(["npm test\n"]);
    expect(fakePty.resizeCalls).toEqual([{ cols: 180, rows: 50 }]);
  });

  test("tracks natural process exit as process-exit with exit code", async () => {
    const fakePty = new FakePty(2003);
    const host = await createTerminalHost({
      pty: fakePty,
    });

    const exitEvents: Array<{ reason: string; exitCode: number | null }> = [];
    host.onExit((event) => {
      exitEvents.push({ reason: event.reason, exitCode: event.exitCode });
    });

    fakePty.emitExit(17);
    const exitEvent = await host.waitForExit();

    expect(exitEvent).toMatchObject({
      type: "terminal/exited",
      tabId: DEFAULT_TAB_ID,
      workspaceId: "ws_alpha",
      reason: "process-exit",
      exitCode: 17,
    });
    expect(host.getExitReason()).toBe("process-exit");
    expect(host.getExitCode()).toBe(17);
    expect(exitEvents).toEqual([{ reason: "process-exit", exitCode: 17 }]);
  });

  test("close() sends SIGHUP immediately, waits 5s, and preserves close reason on exit", async () => {
    const fakePty = new FakePty(2004);
    const timerScheduler = new ManualTimerScheduler();
    const host = await createTerminalHost({
      pty: fakePty,
      setTimeoutFn: timerScheduler.setTimeout,
      clearTimeoutFn: timerScheduler.clearTimeout,
    });

    const closePromise = host.close("workspace-close");

    expect(fakePty.killCalls).toEqual(["SIGHUP"]);
    expect(timerScheduler.records).toHaveLength(1);
    expect(timerScheduler.records[0]?.delayMs).toBe(5_000);
    expect(timerScheduler.records[0]?.unrefCalled).toBe(true);

    fakePty.emitExit(0);
    const exitEvent = await closePromise;

    expect(exitEvent.reason).toBe("workspace-close");
    expect(exitEvent.exitCode).toBe(0);
    expect(host.getExitReason()).toBe("workspace-close");
    expect(timerScheduler.records[0]?.cleared).toBe(true);

    timerScheduler.fire(0);
    expect(fakePty.killCalls).toEqual(["SIGHUP"]);
  });

  test("logs and forces SIGKILL when close grace period is missed", async () => {
    const fakePty = new FakePty(2005);
    const timerScheduler = new ManualTimerScheduler();
    const errorLogs: Array<{ message: string; error?: unknown }> = [];
    const host = await createTerminalHost({
      pty: fakePty,
      logger: {
        error: (message, error) => {
          errorLogs.push({ message, error });
        },
      },
      setTimeoutFn: timerScheduler.setTimeout,
      clearTimeoutFn: timerScheduler.clearTimeout,
    });

    const closePromise = host.close("app-shutdown");

    expect(fakePty.killCalls).toEqual(["SIGHUP"]);

    timerScheduler.fire(0);

    expect(fakePty.killCalls).toEqual(["SIGHUP", "SIGKILL"]);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.message).toContain("forcing SIGKILL");
    expect(errorLogs[0]?.message).toContain("missed 5000ms kill deadline");
    expect(errorLogs[0]?.error).toBeUndefined();

    fakePty.emitExit(137);
    const exitEvent = await closePromise;
    expect(exitEvent.reason).toBe("app-shutdown");
    expect(exitEvent.exitCode).toBe(137);
  });
});

type SpawnCall = {
  file: string;
  args: string[];
  options: IPtyForkOptions;
};

type ResolverSetup = {
  baseEnv: Record<string, string>;
  defaultShell: string;
  defaultShellArgs: string[];
};

class FakeResolver implements TerminalHostEnvironmentResolver {
  public getBaseEnvCalls = 0;
  public getDefaultShellCalls = 0;
  public getDefaultShellArgsCalls = 0;

  public constructor(private readonly setup: ResolverSetup) {}

  public async getBaseEnv(): Promise<Record<string, string>> {
    this.getBaseEnvCalls += 1;
    return { ...this.setup.baseEnv };
  }

  public getDefaultShell(): string {
    this.getDefaultShellCalls += 1;
    return this.setup.defaultShell;
  }

  public getDefaultShellArgs(): string[] {
    this.getDefaultShellArgsCalls += 1;
    return [...this.setup.defaultShellArgs];
  }
}

class FakePty implements TerminalHostPty {
  public readonly writeCalls: string[] = [];
  public readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  public readonly killCalls: string[] = [];

  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  public constructor(public readonly pid: number) {}

  public onData(listener: (data: string) => unknown): { dispose(): void } {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  public onExit(
    listener: (event: { exitCode: number; signal?: number }) => unknown,
  ): { dispose(): void } {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  public write(data: string | Buffer): void {
    this.writeCalls.push(typeof data === "string" ? data : data.toString("utf8"));
  }

  public resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  public kill(signal?: string): void {
    this.killCalls.push(signal ?? "SIGHUP");
  }

  public emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  public emitExit(exitCode: number, signal?: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode, signal });
    }
  }
}

type ManualTimerRecord = {
  delayMs: number;
  callback: () => void;
  cleared: boolean;
  unrefCalled: boolean;
  handle: ManualTimerHandle;
};

type ManualTimerHandle = {
  id: number;
  unref: () => void;
};

class ManualTimerScheduler {
  public readonly records: ManualTimerRecord[] = [];
  private nextId = 1;

  public readonly setTimeout: TerminalHostSetTimeout = (callback, delayMs) => {
    const handle: ManualTimerHandle = {
      id: this.nextId,
      unref: () => {
        const record = this.records.find((entry) => entry.handle.id === handle.id);
        if (record) {
          record.unrefCalled = true;
        }
      },
    };
    this.nextId += 1;

    const record: ManualTimerRecord = {
      delayMs,
      callback,
      cleared: false,
      unrefCalled: false,
      handle,
    };
    this.records.push(record);
    return handle as unknown as ReturnType<typeof setTimeout>;
  };

  public readonly clearTimeout: TerminalHostClearTimeout = (timeoutHandle) => {
    const handle = timeoutHandle as unknown as ManualTimerHandle;
    const record = this.records.find((entry) => entry.handle.id === handle.id);
    if (record) {
      record.cleared = true;
    }
  };

  public fire(index: number): void {
    const record = this.records[index];
    if (!record || record.cleared) {
      return;
    }

    record.callback();
  }
}

function createResolver(setup?: Partial<ResolverSetup>): FakeResolver {
  return new FakeResolver({
    baseEnv: setup?.baseEnv ?? {
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
    },
    defaultShell: setup?.defaultShell ?? "/bin/zsh",
    defaultShellArgs: setup?.defaultShellArgs ?? ["-l", "-i"],
  });
}

function createOpenCommand(overrides: Partial<TerminalOpenCommand> = {}): TerminalOpenCommand {
  return {
    type: "terminal/open",
    workspaceId: "ws_alpha",
    cols: 120,
    rows: 32,
    ...overrides,
  };
}

function createCaptureSpawnFactory(pty: TerminalHostPty, calls: SpawnCall[]): TerminalHostSpawnFactory {
  return (file, args, options) => {
    calls.push({
      file,
      args: [...args],
      options: {
        ...options,
        env: options.env ? { ...options.env } : options.env,
      },
    });
    return pty;
  };
}

async function createTerminalHost(options: {
  pty?: TerminalHostPty;
  resolver?: FakeResolver;
  openCommand?: TerminalOpenCommand;
  spawnFactory?: TerminalHostSpawnFactory;
  logger?: TerminalHostLogger;
  setTimeoutFn?: TerminalHostSetTimeout;
  clearTimeoutFn?: TerminalHostClearTimeout;
}): Promise<TerminalHost> {
  const pty = options.pty ?? new FakePty(9999);
  const resolver = options.resolver ?? createResolver();
  const openCommand = options.openCommand ?? createOpenCommand();

  return TerminalHost.create({
    tabId: DEFAULT_TAB_ID,
    openCommand,
    shellEnvironmentResolver: resolver,
    spawnFactory: options.spawnFactory ?? ((file, args, spawnOptions) => pty),
    logger: options.logger,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
  });
}
