import type {
  TerminalExitedEvent,
  TerminalExitedReason,
  TerminalOpenCommand,
  TerminalOpenedEvent,
  TerminalStdoutChunk,
} from "../../../../shared/src/contracts/terminal/terminal-ipc";
import type { TerminalCloseReason } from "../../../../shared/src/contracts/terminal/terminal-lifecycle";
import type { TerminalTabId } from "../../../../shared/src/contracts/terminal/terminal-tab";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { IDisposable, IPty, IPtyForkOptions } from "node-pty";

const DEFAULT_KILL_GRACE_PERIOD_MS = 5_000;
const DEFAULT_STDOUT_SEQUENCE_START = 0;

type TerminalHostNodePtyModule = {
  spawn: (file: string, args: string[] | string, options: IPtyForkOptions) => IPty;
};

export type TerminalHostPty = Pick<IPty, "pid" | "onData" | "onExit" | "write" | "resize" | "kill">;

export type TerminalHostSpawnFactory = (
  file: string,
  args: string[],
  options: IPtyForkOptions,
) => TerminalHostPty;

export interface TerminalHostEnvironmentResolver {
  getBaseEnv(): Promise<Record<string, string>>;
  getDefaultShell(): string;
  getDefaultShellArgs(): string[];
}

export interface TerminalHostLogger {
  error(message: string, error?: unknown): void;
}

export type TerminalHostTimeoutHandle = ReturnType<typeof setTimeout>;
export type TerminalHostSetTimeout = (
  callback: () => void,
  delayMs: number,
) => TerminalHostTimeoutHandle;
export type TerminalHostClearTimeout = (handle: TerminalHostTimeoutHandle) => void;

export interface TerminalHostCreateOptions {
  tabId: TerminalTabId;
  openCommand: TerminalOpenCommand;
  shellEnvironmentResolver: TerminalHostEnvironmentResolver;
  spawnFactory?: TerminalHostSpawnFactory;
  logger?: TerminalHostLogger;
  sequenceStart?: number;
  killGracePeriodMs?: number;
  setTimeoutFn?: TerminalHostSetTimeout;
  clearTimeoutFn?: TerminalHostClearTimeout;
}

export interface TerminalHostDisposable {
  dispose(): void;
}

interface TerminalHostConstructorOptions {
  tabId: TerminalTabId;
  workspaceId: WorkspaceId;
  pty: TerminalHostPty;
  logger: TerminalHostLogger;
  sequenceStart: number;
  killGracePeriodMs: number;
  setTimeoutFn: TerminalHostSetTimeout;
  clearTimeoutFn: TerminalHostClearTimeout;
}

export class TerminalHost {
  public readonly tabId: TerminalTabId;
  public readonly workspaceId: WorkspaceId;
  public readonly pid: number;

  private readonly pty: TerminalHostPty;
  private readonly logger: TerminalHostLogger;
  private readonly killGracePeriodMs: number;
  private readonly setTimeoutFn: TerminalHostSetTimeout;
  private readonly clearTimeoutFn: TerminalHostClearTimeout;

  private readonly ptyListenerDisposables: IDisposable[] = [];
  private readonly stdoutListeners = new Set<(chunk: TerminalStdoutChunk) => void>();
  private readonly exitListeners = new Set<(event: TerminalExitedEvent) => void>();

  private nextStdoutSequence: number;
  private closeReason: TerminalCloseReason | null = null;
  private killDeadlineTimer: TerminalHostTimeoutHandle | null = null;

  private exitEvent: TerminalExitedEvent | null = null;
  private resolveExit: ((event: TerminalExitedEvent) => void) | null = null;
  private readonly exitPromise: Promise<TerminalExitedEvent>;

  private constructor(options: TerminalHostConstructorOptions) {
    this.tabId = options.tabId;
    this.workspaceId = options.workspaceId;
    this.pid = options.pty.pid;

    this.pty = options.pty;
    this.logger = options.logger;
    this.killGracePeriodMs = options.killGracePeriodMs;
    this.setTimeoutFn = options.setTimeoutFn;
    this.clearTimeoutFn = options.clearTimeoutFn;
    this.nextStdoutSequence = options.sequenceStart;

    this.exitPromise = new Promise<TerminalExitedEvent>((resolve) => {
      this.resolveExit = resolve;
    });

    this.attachPtyListeners();
  }

  public static async create(options: TerminalHostCreateOptions): Promise<TerminalHost> {
    const environmentResolver = options.shellEnvironmentResolver;
    const baseEnvironment = await environmentResolver.getBaseEnv();

    const shell = options.openCommand.shell ?? environmentResolver.getDefaultShell();
    const shellArgs = options.openCommand.shellArgs ?? environmentResolver.getDefaultShellArgs();
    const mergedEnvironment: Record<string, string> = {
      ...baseEnvironment,
      ...(options.openCommand.envOverrides ?? {}),
    };

    const spawnFactory = options.spawnFactory ?? (await resolveDefaultSpawnFactory());
    const pty = spawnFactory(shell, [...shellArgs], {
      name: mergedEnvironment.TERM,
      cols: options.openCommand.cols,
      rows: options.openCommand.rows,
      cwd: options.openCommand.cwd,
      env: mergedEnvironment,
    });

    return new TerminalHost({
      tabId: options.tabId,
      workspaceId: options.openCommand.workspaceId,
      pty,
      logger: options.logger ?? DEFAULT_TERMINAL_HOST_LOGGER,
      sequenceStart: options.sequenceStart ?? DEFAULT_STDOUT_SEQUENCE_START,
      killGracePeriodMs: options.killGracePeriodMs ?? DEFAULT_KILL_GRACE_PERIOD_MS,
      setTimeoutFn: options.setTimeoutFn ?? setTimeout,
      clearTimeoutFn: options.clearTimeoutFn ?? clearTimeout,
    });
  }

  public toOpenedEvent(): TerminalOpenedEvent {
    return {
      type: "terminal/opened",
      tabId: this.tabId,
      workspaceId: this.workspaceId,
      pid: this.pid,
    };
  }

  public write(data: string): void {
    if (this.exitEvent) {
      return;
    }

    this.pty.write(data);
  }

  public resize(cols: number, rows: number): void {
    if (this.exitEvent) {
      return;
    }

    this.pty.resize(cols, rows);
  }

  public close(reason: TerminalCloseReason): Promise<TerminalExitedEvent> {
    if (this.exitEvent) {
      return Promise.resolve(this.exitEvent);
    }

    if (this.closeReason === null) {
      this.closeReason = reason;
      this.killWithSignal("SIGHUP");
      this.startKillDeadlineTimer();
    }

    return this.exitPromise;
  }

  public onStdout(listener: (chunk: TerminalStdoutChunk) => void): TerminalHostDisposable {
    this.stdoutListeners.add(listener);
    return {
      dispose: () => {
        this.stdoutListeners.delete(listener);
      },
    };
  }

  public onExit(listener: (event: TerminalExitedEvent) => void): TerminalHostDisposable {
    if (this.exitEvent) {
      listener(this.exitEvent);
      return {
        dispose: () => undefined,
      };
    }

    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  public waitForExit(): Promise<TerminalExitedEvent> {
    if (this.exitEvent) {
      return Promise.resolve(this.exitEvent);
    }

    return this.exitPromise;
  }

  public getExitCode(): number | null {
    return this.exitEvent?.exitCode ?? null;
  }

  public getExitReason(): TerminalExitedReason | null {
    return this.exitEvent?.reason ?? null;
  }

  private attachPtyListeners(): void {
    this.ptyListenerDisposables.push(
      this.pty.onData((chunk) => {
        this.emitStdoutChunk(chunk);
      }),
    );
    this.ptyListenerDisposables.push(
      this.pty.onExit((event) => {
        this.handleProcessExit(event.exitCode);
      }),
    );
  }

  private emitStdoutChunk(data: string): void {
    if (this.exitEvent) {
      return;
    }

    const stdoutChunk: TerminalStdoutChunk = {
      type: "terminal/stdout",
      tabId: this.tabId,
      seq: this.nextStdoutSequence,
      data,
    };
    this.nextStdoutSequence += 1;

    for (const listener of this.stdoutListeners) {
      listener(stdoutChunk);
    }
  }

  private handleProcessExit(exitCodeValue: number | null | undefined): void {
    if (this.exitEvent) {
      return;
    }

    this.clearKillDeadlineTimer();
    this.disposePtyListeners();

    const exitCode =
      typeof exitCodeValue === "number" && Number.isFinite(exitCodeValue) ? exitCodeValue : null;
    const reason: TerminalExitedReason = this.closeReason ?? "process-exit";
    const exitEvent: TerminalExitedEvent = {
      type: "terminal/exited",
      tabId: this.tabId,
      workspaceId: this.workspaceId,
      reason,
      exitCode,
    };

    this.exitEvent = exitEvent;
    const listeners = Array.from(this.exitListeners);
    this.exitListeners.clear();
    for (const listener of listeners) {
      listener(exitEvent);
    }

    this.resolveExit?.(exitEvent);
    this.resolveExit = null;
  }

  private startKillDeadlineTimer(): void {
    this.killDeadlineTimer = this.setTimeoutFn(() => {
      this.killDeadlineTimer = null;
      if (this.exitEvent) {
        return;
      }

      this.logger.error(
        `TerminalHost: PTY ${this.pid} for tab ${this.tabId} missed ${this.killGracePeriodMs}ms kill deadline; forcing SIGKILL.`,
      );
      this.killWithSignal("SIGKILL");
    }, this.killGracePeriodMs);
    const timeoutWithUnref = this.killDeadlineTimer as { unref?: () => void };
    timeoutWithUnref.unref?.();
  }

  private clearKillDeadlineTimer(): void {
    if (this.killDeadlineTimer === null) {
      return;
    }

    this.clearTimeoutFn(this.killDeadlineTimer);
    this.killDeadlineTimer = null;
  }

  private killWithSignal(signal: "SIGHUP" | "SIGKILL"): void {
    try {
      this.pty.kill(signal);
    } catch (error) {
      this.logger.error(
        `TerminalHost: failed to send ${signal} to PTY ${this.pid} (tab ${this.tabId}).`,
        error,
      );
    }
  }

  private disposePtyListeners(): void {
    while (this.ptyListenerDisposables.length > 0) {
      const disposable = this.ptyListenerDisposables.pop();
      disposable?.dispose();
    }
  }
}

const DEFAULT_TERMINAL_HOST_LOGGER: TerminalHostLogger = {
  error: (message, error) => {
    if (error === undefined) {
      console.error(message);
      return;
    }

    console.error(message, error);
  },
};

let defaultSpawnFactoryPromise: Promise<TerminalHostSpawnFactory> | null = null;

async function resolveDefaultSpawnFactory(): Promise<TerminalHostSpawnFactory> {
  if (!defaultSpawnFactoryPromise) {
    defaultSpawnFactoryPromise = import("node-pty").then((module) => {
      const nodePty = module as TerminalHostNodePtyModule;
      return (file, args, options) => nodePty.spawn(file, args, options);
    });
  }

  return defaultSpawnFactoryPromise;
}
