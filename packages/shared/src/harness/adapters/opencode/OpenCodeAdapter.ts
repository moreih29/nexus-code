import type { WorkspaceId } from "../../../contracts/workspace/workspace";
import type { AdapterMetadata, HarnessAdapter, ObserverEvent } from "../../HarnessAdapter";
import {
  resolveEventStream,
  type EventStreamSource,
} from "../_shared/event-utils";
import {
  OPENCODE_ADAPTER_NAME,
  OPENCODE_ADAPTER_VERSION,
  mapOpenCodeInputToObserverEvents,
} from "./state-mapper";

export type OpenCodeAdapterInputEvent = unknown;
export type OpenCodeObserverEventStream = AsyncIterable<OpenCodeAdapterInputEvent>;
export type OpenCodeObserverEventStreamFactory = (
  workspaceId: WorkspaceId,
  signal: AbortSignal,
) => OpenCodeObserverEventStream;

export interface OpenCodeAdapterOptions {
  readonly eventStream: EventStreamSource;
  readonly adapterName?: string;
  readonly version?: string;
  readonly now?: () => Date;
}

export class OpenCodeAdapter implements HarnessAdapter {
  private readonly eventStream: EventStreamSource;
  private readonly adapterName: string;
  private readonly version: string;
  private readonly now: () => Date;
  private readonly abortController = new AbortController();
  private disposed = false;

  constructor(options: OpenCodeAdapterOptions) {
    this.eventStream = options.eventStream;
    this.adapterName = options.adapterName ?? OPENCODE_ADAPTER_NAME;
    this.version = options.version ?? OPENCODE_ADAPTER_VERSION;
    this.now = options.now ?? (() => new Date());
  }

  describe(): AdapterMetadata {
    return {
      name: this.adapterName,
      version: this.version,
      observationPath: "mixed",
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
      for (const event of mapOpenCodeInputToObserverEvents(input, {
        workspaceId,
        adapterName: this.adapterName,
        now: this.now,
      })) {
        yield event;
      }
    }
  }
}
