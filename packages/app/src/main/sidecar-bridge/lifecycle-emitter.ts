import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type { SidecarStoppedEvent } from "../../../../shared/src/contracts/sidecar";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";

export type SidecarStopSignal = NodeJS.Signals | "SIGSEGV" | "SIGABRT" | null;

export interface SidecarLifecycleEmitterOptions {
  workspaceId: WorkspaceId;
  now?: () => Date;
  reconcileWindowMs?: number;
}

interface ExitSignal {
  exitCode: number | null;
  signal: SidecarStopSignal;
}

interface WsCloseSignal {
  code: number;
  wasClean: boolean;
}

export class SidecarLifecycleEmitter extends EventEmitter {
  public readonly epoch = randomUUID();
  private readonly workspaceId: WorkspaceId;
  private readonly now: () => Date;
  private readonly reconcileWindowMs: number;

  private exitSignal: ExitSignal | null = null;
  private wsCloseSignal: WsCloseSignal | null = null;
  private mainSentSignal: NodeJS.Signals | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private emitted = false;

  public constructor(options: SidecarLifecycleEmitterOptions) {
    super();
    this.workspaceId = options.workspaceId;
    this.now = options.now ?? (() => new Date());
    this.reconcileWindowMs = options.reconcileWindowMs ?? 1_000;
  }

  public markMainSentSignal(signal: NodeJS.Signals): void {
    this.mainSentSignal = signal;
  }

  public recordWsClose(code: number, wasClean: boolean): void {
    this.wsCloseSignal = { code, wasClean };
    this.scheduleStoppedEmit();
  }

  public recordProcessExit(exitCode: number | null, signal: SidecarStopSignal): void {
    this.exitSignal = { exitCode, signal };
    this.scheduleStoppedEmit();
  }

  public waitForStopped(): Promise<SidecarStoppedEvent> {
    return new Promise((resolve) => {
      this.once("stopped", (event: SidecarStoppedEvent) => resolve(event));
    });
  }

  private scheduleStoppedEmit(): void {
    if (this.emitted || this.emitTimer) {
      return;
    }

    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitStoppedOnce();
    }, this.reconcileWindowMs);
  }

  private emitStoppedOnce(): void {
    if (this.emitted) {
      return;
    }

    this.emitted = true;
    const event: SidecarStoppedEvent = {
      type: "sidecar/stopped",
      workspaceId: this.workspaceId,
      reason: this.synthesizeReason(),
      stoppedAt: this.now().toISOString(),
      exitCode: this.exitSignal?.exitCode ?? null,
    };
    this.emit("stopped", event);
  }

  private synthesizeReason(): SidecarStoppedEvent["reason"] {
    if (this.mainSentSignal === "SIGTERM" || this.mainSentSignal === "SIGKILL") {
      return "requested";
    }

    if (
      this.wsCloseSignal?.wasClean &&
      this.wsCloseSignal.code === 1000 &&
      this.exitSignal?.exitCode === 0
    ) {
      return "requested";
    }

    if (
      this.exitSignal?.signal === "SIGKILL" ||
      this.exitSignal?.signal === "SIGSEGV" ||
      this.exitSignal?.signal === "SIGABRT"
    ) {
      return "process-crash";
    }

    if (this.exitSignal && this.exitSignal.exitCode !== 0 && this.exitSignal.signal === null) {
      return "process-exit";
    }

    return "process-exit";
  }
}
