import type { WorkspaceId } from "../../../contracts/workspace/workspace";
import type { AdapterMetadata, HarnessAdapter, ObserverEvent } from "../../HarnessAdapter";
import {
  resolveEventStream,
  type EventStreamSource,
} from "../_shared/event-utils";
import {
  CODEX_ADAPTER_NAME,
  CODEX_ADAPTER_VERSION,
  mapCodexInputToObserverEvents,
} from "./state-mapper";

export type CodexAdapterInputEvent = unknown;
export type CodexObserverEventStream = AsyncIterable<CodexAdapterInputEvent>;
export type CodexObserverEventStreamFactory = (
  workspaceId: WorkspaceId,
  signal: AbortSignal,
) => CodexObserverEventStream;

export interface CodexAdapterOptions {
  readonly eventStream: EventStreamSource;
  readonly adapterName?: string;
  readonly version?: string;
  readonly now?: () => Date;
}

export class CodexAdapter implements HarnessAdapter {
  private readonly eventStream: EventStreamSource;
  private readonly adapterName: string;
  private readonly version: string;
  private readonly now: () => Date;
  private readonly abortController = new AbortController();
  private disposed = false;

  constructor(options: CodexAdapterOptions) {
    this.eventStream = options.eventStream;
    this.adapterName = options.adapterName ?? CODEX_ADAPTER_NAME;
    this.version = options.version ?? CODEX_ADAPTER_VERSION;
    this.now = options.now ?? (() => new Date());
  }

  describe(): AdapterMetadata {
    return {
      name: this.adapterName,
      version: this.version,
      observationPath: "hooks-api",
    };
  }

  observe(workspaceId: WorkspaceId): AsyncIterable<ObserverEvent> {
    return this.observeEvents(workspaceId);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abortController.abort();
  }

  private async *observeEvents(workspaceId: WorkspaceId): AsyncIterable<ObserverEvent> {
    if (this.disposed) {
      return;
    }

    for await (const input of resolveEventStream(this.eventStream, workspaceId, this.abortController.signal)) {
      if (this.disposed) {
        return;
      }
      for (const event of mapCodexInputToObserverEvents(input, {
        workspaceId,
        adapterName: this.adapterName,
        now: this.now,
      })) {
        yield event;
      }
    }
  }
}
