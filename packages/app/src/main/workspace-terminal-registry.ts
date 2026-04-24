import type {
  TerminalCloseCommand,
  TerminalExitedEvent,
  TerminalInputCommand,
  TerminalOpenedEvent,
  TerminalResizeCommand,
  TerminalScrollbackStatsQuery,
  TerminalScrollbackStatsReply,
  TerminalStdoutChunk,
} from "../../../shared/src/contracts/terminal-ipc";
import type {
  TerminalCloseReason,
  WorkspaceTerminalsClosedEvent,
  WorkspaceTerminalsClosedReason,
} from "../../../shared/src/contracts/terminal-lifecycle";
import type { TerminalTabId } from "../../../shared/src/contracts/terminal-tab";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import {
  type TerminalHostCreateOptions as MainTerminalHostCreateOptions,
  type TerminalHostDisposable,
  TerminalHost,
} from "./terminal-host";

export const DEFAULT_MAIN_BUFFER_BYTE_LIMIT = 8 * 1024 * 1024;
export const DEFAULT_XTERM_SCROLLBACK_LINES = 10_000;

export interface WorkspaceTerminalHost {
  readonly tabId: TerminalTabId;
  readonly workspaceId: WorkspaceId;

  toOpenedEvent(): TerminalOpenedEvent;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(reason: TerminalCloseReason): Promise<TerminalExitedEvent>;
  onStdout(listener: (chunk: TerminalStdoutChunk) => void): TerminalHostDisposable;
  onExit(listener: (event: TerminalExitedEvent) => void): TerminalHostDisposable;
}

export interface WorkspaceTerminalHostFactory {
  create(options: MainTerminalHostCreateOptions): Promise<WorkspaceTerminalHost>;
}

export interface WorkspaceTerminalRegistryOptions {
  hostFactory?: WorkspaceTerminalHostFactory;
  defaultMainBufferByteLimit?: number;
  defaultXtermScrollbackLines?: number;
}

export interface WorkspaceTerminalRegistrationOptions {
  mainBufferByteLimit?: number;
  xtermScrollbackLines?: number;
}

interface TerminalRecord {
  host: WorkspaceTerminalHost;
  subscriptions: TerminalHostDisposable[];
  mainBuffer: ByteRingBuffer;
  mainBufferByteLimit: number;
  xtermScrollbackLines: number;
}

const DEFAULT_HOST_FACTORY: WorkspaceTerminalHostFactory = {
  create: (options) => TerminalHost.create(options),
};

const textEncoder = new TextEncoder();

export class WorkspaceTerminalRegistry {
  private readonly hostFactory: WorkspaceTerminalHostFactory;
  private readonly defaultMainBufferByteLimit: number;
  private readonly defaultXtermScrollbackLines: number;

  private readonly recordsByTabId = new Map<TerminalTabId, TerminalRecord>();
  private readonly tabOrderByWorkspaceId = new Map<WorkspaceId, TerminalTabId[]>();

  private readonly stdoutListeners = new Set<(chunk: TerminalStdoutChunk) => void>();
  private readonly exitListeners = new Set<(event: TerminalExitedEvent) => void>();
  private readonly workspaceCloseListeners = new Set<
    (event: WorkspaceTerminalsClosedEvent) => void
  >();

  public constructor(options: WorkspaceTerminalRegistryOptions = {}) {
    this.hostFactory = options.hostFactory ?? DEFAULT_HOST_FACTORY;
    this.defaultMainBufferByteLimit = normalizePositiveInteger(
      options.defaultMainBufferByteLimit,
      DEFAULT_MAIN_BUFFER_BYTE_LIMIT,
    );
    this.defaultXtermScrollbackLines = normalizePositiveInteger(
      options.defaultXtermScrollbackLines,
      DEFAULT_XTERM_SCROLLBACK_LINES,
    );
  }

  public async openTerminal(options: MainTerminalHostCreateOptions): Promise<TerminalOpenedEvent> {
    const host = await this.hostFactory.create(options);

    this.registerHost(host, {
      mainBufferByteLimit: options.openCommand.scrollbackMainBufferBytes,
      xtermScrollbackLines: options.openCommand.scrollbackXtermLines,
    });

    return host.toOpenedEvent();
  }

  public registerHost(
    host: WorkspaceTerminalHost,
    options: WorkspaceTerminalRegistrationOptions = {},
  ): TerminalOpenedEvent {
    if (this.recordsByTabId.has(host.tabId)) {
      throw new Error(`Terminal tab \"${host.tabId}\" is already registered.`);
    }

    const mainBufferByteLimit = normalizePositiveInteger(
      options.mainBufferByteLimit,
      this.defaultMainBufferByteLimit,
    );
    const xtermScrollbackLines = normalizePositiveInteger(
      options.xtermScrollbackLines,
      this.defaultXtermScrollbackLines,
    );

    const record: TerminalRecord = {
      host,
      subscriptions: [],
      mainBuffer: new ByteRingBuffer(mainBufferByteLimit),
      mainBufferByteLimit,
      xtermScrollbackLines,
    };

    record.subscriptions.push(
      host.onStdout((chunk) => {
        this.handleHostStdout(chunk);
      }),
    );
    record.subscriptions.push(
      host.onExit((event) => {
        this.handleHostExit(event);
      }),
    );

    this.recordsByTabId.set(host.tabId, record);
    this.appendTabIdToWorkspace(host.workspaceId, host.tabId);

    return host.toOpenedEvent();
  }

  public listTabIdsForWorkspace(workspaceId: WorkspaceId): TerminalTabId[] {
    return [...(this.tabOrderByWorkspaceId.get(workspaceId) ?? [])];
  }

  public hasTab(tabId: TerminalTabId): boolean {
    return this.recordsByTabId.has(tabId);
  }

  public handleInputCommand(command: TerminalInputCommand): void {
    const record = this.recordsByTabId.get(command.tabId);
    if (!record) {
      return;
    }

    record.host.write(command.data);
  }

  public handleResizeCommand(command: TerminalResizeCommand): void {
    const record = this.recordsByTabId.get(command.tabId);
    if (!record) {
      return;
    }

    record.host.resize(command.cols, command.rows);
  }

  public async handleCloseCommand(
    command: TerminalCloseCommand,
  ): Promise<TerminalExitedEvent | null> {
    const record = this.recordsByTabId.get(command.tabId);
    if (!record) {
      return null;
    }

    return record.host.close(command.reason);
  }

  public handleScrollbackStatsQuery(
    query: TerminalScrollbackStatsQuery,
  ): TerminalScrollbackStatsReply | null {
    const record = this.recordsByTabId.get(query.tabId);
    if (!record) {
      return null;
    }

    return {
      type: "terminal/scrollback-stats/reply",
      tabId: query.tabId,
      mainBufferByteLimit: record.mainBufferByteLimit,
      mainBufferStoredBytes: record.mainBuffer.getStoredBytes(),
      mainBufferDroppedBytesTotal: record.mainBuffer.getDroppedBytesTotal(),
      xtermScrollbackLines: record.xtermScrollbackLines,
    };
  }

  public async closeWorkspaceTerminals(
    workspaceId: WorkspaceId,
    reason: WorkspaceTerminalsClosedReason,
  ): Promise<WorkspaceTerminalsClosedEvent> {
    const closedTabIds = this.listTabIdsForWorkspace(workspaceId);
    if (closedTabIds.length > 0) {
      await Promise.all(
        closedTabIds.map((tabId) => {
          const record = this.recordsByTabId.get(tabId);
          return record ? record.host.close(reason) : Promise.resolve(null);
        }),
      );
    }

    const event: WorkspaceTerminalsClosedEvent = {
      type: "terminal/workspace-terminals-closed",
      workspaceId,
      closedTabIds,
      reason,
    };
    for (const listener of this.workspaceCloseListeners) {
      listener(event);
    }

    return event;
  }

  public async stopTerminalsForClosedWorkspace(workspaceId: WorkspaceId): Promise<void> {
    await this.closeWorkspaceTerminals(workspaceId, "workspace-close");
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
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  public onWorkspaceTerminalsClosed(
    listener: (event: WorkspaceTerminalsClosedEvent) => void,
  ): TerminalHostDisposable {
    this.workspaceCloseListeners.add(listener);
    return {
      dispose: () => {
        this.workspaceCloseListeners.delete(listener);
      },
    };
  }

  private handleHostStdout(chunk: TerminalStdoutChunk): void {
    const record = this.recordsByTabId.get(chunk.tabId);
    if (!record) {
      return;
    }

    const droppedBytes = record.mainBuffer.append(textEncoder.encode(chunk.data));
    const enrichedChunk: TerminalStdoutChunk =
      droppedBytes > 0 ? { ...chunk, mainBufferDroppedBytes: droppedBytes } : chunk;

    for (const listener of this.stdoutListeners) {
      listener(enrichedChunk);
    }
  }

  private handleHostExit(event: TerminalExitedEvent): void {
    const record = this.recordsByTabId.get(event.tabId);
    if (record) {
      this.unregisterRecord(record);
    }

    for (const listener of this.exitListeners) {
      listener(event);
    }
  }

  private unregisterRecord(record: TerminalRecord): void {
    this.recordsByTabId.delete(record.host.tabId);
    removeTabIdFromWorkspaceOrder(
      this.tabOrderByWorkspaceId,
      record.host.workspaceId,
      record.host.tabId,
    );

    while (record.subscriptions.length > 0) {
      const subscription = record.subscriptions.pop();
      subscription?.dispose();
    }
  }

  private appendTabIdToWorkspace(workspaceId: WorkspaceId, tabId: TerminalTabId): void {
    const existing = this.tabOrderByWorkspaceId.get(workspaceId);
    if (existing) {
      existing.push(tabId);
      return;
    }

    this.tabOrderByWorkspaceId.set(workspaceId, [tabId]);
  }
}

class ByteRingBuffer {
  private readonly storage: Uint8Array;
  private writeOffset = 0;
  private readOffset = 0;
  private storedBytes = 0;
  private droppedBytesTotal = 0;

  public constructor(private readonly byteLimit: number) {
    this.storage = new Uint8Array(byteLimit);
  }

  public append(input: Uint8Array): number {
    if (input.length === 0) {
      return 0;
    }

    if (this.byteLimit === 0) {
      this.droppedBytesTotal += input.length;
      return input.length;
    }

    let source = input;
    let droppedBytes = 0;

    if (source.length >= this.byteLimit) {
      droppedBytes += this.dropOldest(this.storedBytes);

      const overflow = source.length - this.byteLimit;
      if (overflow > 0) {
        droppedBytes += overflow;
        this.droppedBytesTotal += overflow;
        source = source.subarray(overflow);
      }
    }

    const requiredDrop = this.storedBytes + source.length - this.byteLimit;
    if (requiredDrop > 0) {
      droppedBytes += this.dropOldest(requiredDrop);
    }

    this.write(source);
    return droppedBytes;
  }

  public getStoredBytes(): number {
    return this.storedBytes;
  }

  public getDroppedBytesTotal(): number {
    return this.droppedBytesTotal;
  }

  private dropOldest(byteCount: number): number {
    if (byteCount <= 0 || this.storedBytes === 0) {
      return 0;
    }

    const clampedByteCount = Math.min(byteCount, this.storedBytes);
    this.readOffset = (this.readOffset + clampedByteCount) % this.byteLimit;
    this.storedBytes -= clampedByteCount;
    this.droppedBytesTotal += clampedByteCount;
    return clampedByteCount;
  }

  private write(data: Uint8Array): void {
    if (data.length === 0) {
      return;
    }

    const firstWriteLength = Math.min(data.length, this.byteLimit - this.writeOffset);
    this.storage.set(data.subarray(0, firstWriteLength), this.writeOffset);

    const remainingLength = data.length - firstWriteLength;
    if (remainingLength > 0) {
      this.storage.set(data.subarray(firstWriteLength), 0);
    }

    this.writeOffset = (this.writeOffset + data.length) % this.byteLimit;
    this.storedBytes += data.length;
  }
}

function removeTabIdFromWorkspaceOrder(
  workspaceTabs: Map<WorkspaceId, TerminalTabId[]>,
  workspaceId: WorkspaceId,
  tabId: TerminalTabId,
): void {
  const tabOrder = workspaceTabs.get(workspaceId);
  if (!tabOrder) {
    return;
  }

  const nextTabOrder = tabOrder.filter((existingTabId) => existingTabId !== tabId);
  if (nextTabOrder.length === 0) {
    workspaceTabs.delete(workspaceId);
    return;
  }

  workspaceTabs.set(workspaceId, nextTabOrder);
}

function normalizePositiveInteger(candidate: number | undefined, fallback: number): number {
  if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate <= 0) {
    return fallback;
  }

  return candidate;
}
