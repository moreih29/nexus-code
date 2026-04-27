import { randomUUID } from "node:crypto";

import {
  isTerminalIpcCommand,
  isTerminalIpcEvent,
  type TerminalCloseCommand,
  type TerminalIpcCommand,
  type TerminalIpcEvent,
  type TerminalOpenCommand,
  type TerminalOpenedEvent,
  type TerminalScrollbackStatsQuery,
  type TerminalScrollbackStatsReply,
  type TerminalStdoutChunk,
} from "../../../../shared/src/contracts/terminal/terminal-ipc";
import type { TerminalTabId } from "../../../../shared/src/contracts/terminal/terminal-tab";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type {
  TerminalHostClearTimeout,
  TerminalHostDisposable,
  TerminalHostEnvironmentResolver,
  TerminalHostSetTimeout,
} from "./terminal-host";
import type { WorkspaceTerminalRegistry } from "../workspace/shell/workspace-terminal-registry";

export const MIN_STDOUT_COALESCE_WINDOW_MS = 10;
export const MAX_STDOUT_COALESCE_WINDOW_MS = 16;
export const DEFAULT_STDOUT_COALESCE_WINDOW_MS = 12;

export interface TerminalMainIpcDisposable {
  dispose(): void;
}

export interface TerminalMainIpcAdapter {
  onCommand(handler: (payload: unknown) => Promise<unknown> | unknown): TerminalMainIpcDisposable;
  sendEvent(payload: unknown): void;
}

export type TerminalWorkspaceCwdResolver = (
  workspaceId: WorkspaceId,
) => Promise<string | null | undefined> | string | null | undefined;

export interface TerminalWorkspaceEnvContext {
  readonly baseEnvironment: Record<string, string>;
}

export type TerminalWorkspaceEnvResolver = (
  workspaceId: WorkspaceId,
  context: TerminalWorkspaceEnvContext,
) => Promise<Record<string, string> | null | undefined> | Record<string, string> | null | undefined;

export interface TerminalMainIpcRouterDependencies {
  registry: WorkspaceTerminalRegistry;
  shellEnvironmentResolver: TerminalHostEnvironmentResolver;
  ipcAdapter: TerminalMainIpcAdapter;
  resolveWorkspaceCwd?: TerminalWorkspaceCwdResolver;
  resolveWorkspaceEnvOverrides?: TerminalWorkspaceEnvResolver;
}

export interface TerminalMainIpcRouterOptions {
  createTabId?: (workspaceId: WorkspaceId) => TerminalTabId;
  stdoutCoalesceWindowMs?: number;
  setTimeoutFn?: TerminalHostSetTimeout;
  clearTimeoutFn?: TerminalHostClearTimeout;
}

let nextTabNonce = 0;

export function createDefaultTerminalTabId(workspaceId: WorkspaceId): TerminalTabId {
  const nonce = `${nextTabNonce.toString(36).padStart(4, "0")}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  nextTabNonce += 1;
  return `tt_${workspaceId}_${nonce}` as TerminalTabId;
}

export function normalizeStdoutCoalesceWindowMs(candidate: number | undefined): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return DEFAULT_STDOUT_COALESCE_WINDOW_MS;
  }

  const rounded = Math.round(candidate);
  if (rounded < MIN_STDOUT_COALESCE_WINDOW_MS) {
    return MIN_STDOUT_COALESCE_WINDOW_MS;
  }
  if (rounded > MAX_STDOUT_COALESCE_WINDOW_MS) {
    return MAX_STDOUT_COALESCE_WINDOW_MS;
  }
  return rounded;
}

export class TerminalMainIpcRouter {
  private readonly createTabId: (workspaceId: WorkspaceId) => TerminalTabId;
  private readonly stdoutCoalescer: TerminalStdoutCoalescer;

  private readonly registrySubscriptions: TerminalHostDisposable[] = [];
  private commandSubscription: TerminalMainIpcDisposable | null = null;
  private started = false;

  public constructor(
    private readonly dependencies: TerminalMainIpcRouterDependencies,
    options: TerminalMainIpcRouterOptions = {},
  ) {
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

    this.createTabId = options.createTabId ?? createDefaultTerminalTabId;
    this.stdoutCoalescer = new TerminalStdoutCoalescer({
      windowMs: normalizeStdoutCoalesceWindowMs(options.stdoutCoalesceWindowMs),
      setTimeoutFn,
      clearTimeoutFn,
      emit: (chunk) => {
        this.emitEvent(chunk);
      },
    });
  }

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    this.commandSubscription = this.dependencies.ipcAdapter.onCommand((payload) => {
      return this.handleCommandPayload(payload);
    });

    this.registrySubscriptions.push(
      this.dependencies.registry.onStdout((chunk) => {
        this.stdoutCoalescer.enqueue(chunk);
      }),
    );
    this.registrySubscriptions.push(
      this.dependencies.registry.onExit((event) => {
        this.emitEvent(event);
      }),
    );
  }

  public stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;

    this.commandSubscription?.dispose();
    this.commandSubscription = null;

    while (this.registrySubscriptions.length > 0) {
      this.registrySubscriptions.pop()?.dispose();
    }

    this.stdoutCoalescer.dispose();
  }

  private async handleCommandPayload(payload: unknown): Promise<unknown> {
    if (!isTerminalIpcCommand(payload)) {
      throw new Error("Invalid terminal IPC command payload.");
    }

    switch (payload.type) {
      case "terminal/open":
        return this.handleOpenCommand(payload);
      case "terminal/input":
        this.dependencies.registry.handleInputCommand(payload);
        return null;
      case "terminal/resize":
        this.dependencies.registry.handleResizeCommand(payload);
        return null;
      case "terminal/close":
        return this.handleCloseCommand(payload);
      case "terminal/scrollback-stats/query":
        return this.handleScrollbackStatsQuery(payload);
      default:
        return assertNever(payload);
    }
  }

  private async handleOpenCommand(command: TerminalOpenCommand): Promise<TerminalOpenedEvent> {
    const baseEnvironment = await this.dependencies.shellEnvironmentResolver.getBaseEnv();
    const openCommand = await this.resolveOpenCommand(command, baseEnvironment);
    const openedEvent = await this.dependencies.registry.openTerminal({
      tabId: this.createTabId(openCommand.workspaceId),
      openCommand,
      shellEnvironmentResolver: createStaticBaseEnvironmentResolver(
        this.dependencies.shellEnvironmentResolver,
        baseEnvironment,
      ),
    });
    this.emitEvent(openedEvent);
    return openedEvent;
  }

  private async resolveOpenCommand(
    command: TerminalOpenCommand,
    baseEnvironment: Record<string, string>,
  ): Promise<TerminalOpenCommand> {
    const cwd = await this.resolveOpenCommandCwd(command);
    const envOverrides = await this.resolveOpenCommandEnvOverrides(command, baseEnvironment);

    if (cwd === command.cwd && envOverrides === command.envOverrides) {
      return command;
    }

    return {
      ...command,
      cwd,
      envOverrides,
    };
  }

  private async resolveOpenCommandCwd(command: TerminalOpenCommand): Promise<string | undefined> {
    if (command.cwd) {
      return command.cwd;
    }

    const resolveWorkspaceCwd = this.dependencies.resolveWorkspaceCwd;
    if (!resolveWorkspaceCwd) {
      return undefined;
    }

    const cwd = await resolveWorkspaceCwd(command.workspaceId);
    if (!cwd) {
      throw new Error(`No terminal cwd is registered for workspace "${command.workspaceId}".`);
    }

    return cwd;
  }

  private async resolveOpenCommandEnvOverrides(
    command: TerminalOpenCommand,
    baseEnvironment: Record<string, string>,
  ): Promise<Record<string, string> | undefined> {
    const workspaceEnvOverrides = await this.dependencies.resolveWorkspaceEnvOverrides?.(
      command.workspaceId,
      { baseEnvironment },
    );
    const commandEnvOverrides = command.envOverrides;
    if (!workspaceEnvOverrides) {
      return commandEnvOverrides;
    }

    return {
      ...workspaceEnvOverrides,
      ...(commandEnvOverrides ?? {}),
    };
  }

  private async handleCloseCommand(
    command: TerminalCloseCommand,
  ): Promise<TerminalIpcEvent | null> {
    return this.dependencies.registry.handleCloseCommand(command);
  }

  private handleScrollbackStatsQuery(
    query: TerminalScrollbackStatsQuery,
  ): TerminalScrollbackStatsReply {
    const reply = this.dependencies.registry.handleScrollbackStatsQuery(query);
    if (!reply) {
      throw new Error(`Terminal tab \"${query.tabId}\" is not registered.`);
    }
    return reply;
  }

  private emitEvent(event: TerminalIpcEvent): void {
    if (!isTerminalIpcEvent(event)) {
      throw new Error("Invalid terminal IPC event payload.");
    }

    this.dependencies.ipcAdapter.sendEvent(event);
  }
}

interface TerminalStdoutCoalescerOptions {
  windowMs: number;
  setTimeoutFn: TerminalHostSetTimeout;
  clearTimeoutFn: TerminalHostClearTimeout;
  emit: (chunk: TerminalStdoutChunk) => void;
}

class TerminalStdoutCoalescer {
  private readonly queue: TerminalStdoutChunk[] = [];
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;

  public constructor(private readonly options: TerminalStdoutCoalescerOptions) {}

  public enqueue(chunk: TerminalStdoutChunk): void {
    this.queue.push(chunk);
    if (this.flushTimeout !== null) {
      return;
    }

    this.flushTimeout = this.options.setTimeoutFn(() => {
      this.flushTimeout = null;
      this.flush();
    }, this.options.windowMs);

    const timeoutWithUnref = this.flushTimeout as { unref?: () => void };
    timeoutWithUnref.unref?.();
  }

  public dispose(): void {
    if (this.flushTimeout !== null) {
      this.options.clearTimeoutFn(this.flushTimeout);
      this.flushTimeout = null;
    }

    this.flush();
  }

  private flush(): void {
    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue.splice(0, this.queue.length);
    for (const chunk of batch) {
      this.options.emit(chunk);
    }
  }
}

function createStaticBaseEnvironmentResolver(
  resolver: TerminalHostEnvironmentResolver,
  baseEnvironment: Record<string, string>,
): TerminalHostEnvironmentResolver {
  return {
    getBaseEnv: () => Promise.resolve({ ...baseEnvironment }),
    getDefaultShell: () => resolver.getDefaultShell(),
    getDefaultShellArgs: () => resolver.getDefaultShellArgs(),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled terminal IPC command: ${JSON.stringify(value)}`);
}
