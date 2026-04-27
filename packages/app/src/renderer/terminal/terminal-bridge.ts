import {
  isTerminalIpcCommand,
  isTerminalIpcEvent,
  type TerminalCloseCommand,
  type TerminalExitedEvent,
  type TerminalInputCommand,
  type TerminalIpcCommand,
  type TerminalIpcEvent,
  type TerminalOpenCommand,
  type TerminalOpenedEvent,
  type TerminalResizeCommand,
  type TerminalScrollbackStatsQuery,
  type TerminalScrollbackStatsReply,
  type TerminalStdoutChunk,
} from "../../../../shared/src/contracts/terminal/terminal-ipc";

export interface TerminalBridgeDisposable {
  dispose(): void;
}

export interface TerminalBridgeTransport {
  invoke(command: unknown): Promise<unknown>;
  onEvent(listener: (eventPayload: unknown) => void): TerminalBridgeDisposable;
}

export class TerminalBridge {
  private readonly allEventListeners = new Set<(event: TerminalIpcEvent) => void>();
  private readonly openedListeners = new Set<(event: TerminalOpenedEvent) => void>();
  private readonly stdoutListeners = new Set<(event: TerminalStdoutChunk) => void>();
  private readonly exitedListeners = new Set<(event: TerminalExitedEvent) => void>();

  private readonly transportSubscription: TerminalBridgeDisposable;
  private disposed = false;

  public constructor(private readonly transport: TerminalBridgeTransport) {
    this.transportSubscription = this.transport.onEvent((eventPayload) => {
      this.handleIncomingEvent(eventPayload);
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    this.transportSubscription.dispose();
    this.allEventListeners.clear();
    this.openedListeners.clear();
    this.stdoutListeners.clear();
    this.exitedListeners.clear();
  }

  public async open(command: TerminalOpenCommand): Promise<TerminalOpenedEvent> {
    const response = await this.invokeCommand(command, "terminal/open");
    return this.expectEventResponse(response, "terminal/opened");
  }

  public async input(command: TerminalInputCommand): Promise<void> {
    await this.invokeCommand(command, "terminal/input");
  }

  public async resize(command: TerminalResizeCommand): Promise<void> {
    await this.invokeCommand(command, "terminal/resize");
  }

  public async close(command: TerminalCloseCommand): Promise<TerminalExitedEvent | null> {
    const response = await this.invokeCommand(command, "terminal/close");
    if (response === null || response === undefined) {
      return null;
    }

    return this.expectEventResponse(response, "terminal/exited");
  }

  public async queryScrollbackStats(
    query: TerminalScrollbackStatsQuery,
  ): Promise<TerminalScrollbackStatsReply> {
    const response = await this.invokeCommand(query, "terminal/scrollback-stats/query");
    return this.expectEventResponse(response, "terminal/scrollback-stats/reply");
  }

  public onEvent(listener: (event: TerminalIpcEvent) => void): TerminalBridgeDisposable {
    this.allEventListeners.add(listener);
    return {
      dispose: () => {
        this.allEventListeners.delete(listener);
      },
    };
  }

  public onOpened(listener: (event: TerminalOpenedEvent) => void): TerminalBridgeDisposable {
    this.openedListeners.add(listener);
    return {
      dispose: () => {
        this.openedListeners.delete(listener);
      },
    };
  }

  public onStdout(listener: (event: TerminalStdoutChunk) => void): TerminalBridgeDisposable {
    this.stdoutListeners.add(listener);
    return {
      dispose: () => {
        this.stdoutListeners.delete(listener);
      },
    };
  }

  public onExited(listener: (event: TerminalExitedEvent) => void): TerminalBridgeDisposable {
    this.exitedListeners.add(listener);
    return {
      dispose: () => {
        this.exitedListeners.delete(listener);
      },
    };
  }

  private async invokeCommand<TType extends TerminalIpcCommand["type"]>(
    payload: unknown,
    expectedType: TType,
  ): Promise<unknown> {
    if (this.disposed) {
      throw new Error("TerminalBridge is disposed.");
    }
    if (!isTerminalIpcCommand(payload) || payload.type !== expectedType) {
      throw new Error(`Invalid terminal IPC command payload for ${expectedType}.`);
    }

    return this.transport.invoke(payload);
  }

  private expectEventResponse<TType extends TerminalIpcEvent["type"]>(
    payload: unknown,
    expectedType: TType,
  ): Extract<TerminalIpcEvent, { type: TType }> {
    if (!isTerminalIpcEvent(payload) || payload.type !== expectedType) {
      throw new Error(`Invalid terminal IPC response payload for ${expectedType}.`);
    }

    return payload;
  }

  private handleIncomingEvent(eventPayload: unknown): void {
    if (this.disposed) {
      return;
    }
    if (!isTerminalIpcEvent(eventPayload)) {
      throw new Error("Invalid terminal IPC event payload.");
    }

    for (const listener of this.allEventListeners) {
      listener(eventPayload);
    }

    switch (eventPayload.type) {
      case "terminal/opened":
        for (const listener of this.openedListeners) {
          listener(eventPayload);
        }
        return;
      case "terminal/stdout":
        for (const listener of this.stdoutListeners) {
          listener(eventPayload);
        }
        return;
      case "terminal/exited":
        for (const listener of this.exitedListeners) {
          listener(eventPayload);
        }
        return;
      case "terminal/scrollback-stats/reply":
        return;
      default:
        assertNever(eventPayload);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled terminal IPC event type: ${JSON.stringify(value)}`);
}
