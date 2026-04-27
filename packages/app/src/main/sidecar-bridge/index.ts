import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type WebSocket from "ws";

import {
  isHarnessObserverEvent,
  type HarnessObserverEvent,
} from "../../../../shared/src/contracts/harness/harness-observer";
import type {
  SidecarStartCommand,
  SidecarStartedEvent,
  SidecarStopCommand,
  SidecarStoppedEvent,
} from "../../../../shared/src/contracts/sidecar/sidecar";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { resolveSidecarBinaryPath } from "../sidecar/sidecar-bin-resolver";
import type { SidecarRuntime } from "../sidecar/sidecar-runtime";
import {
  connectWebSocketWithRefusedRetry,
  performStartHandshake,
  SidecarBridgeError,
  waitForReadyLine,
} from "./handshake";
import { SidecarLifecycleEmitter } from "./lifecycle-emitter";

interface BridgeRecord {
  childProcess: ChildProcess;
  ws: WebSocket;
  startedEvent: SidecarStartedEvent;
  lifecycleEmitter: SidecarLifecycleEmitter;
  heartbeatTimer: NodeJS.Timeout | null;
}

const UNAVAILABLE_SIDECAR_PID = -1;
const OBSERVER_EVENT_NAME = "observer-event";

export interface SidecarObserverEventSubscription {
  dispose(): void;
}

export type SidecarObserverEventListener = (event: HarnessObserverEvent) => void;

export interface SidecarBridgeOptions {
  sidecarBin?: string;
  dataDir?: string;
  appPath?: string;
  cwd?: string;
  resourcesPath?: string;
  isPackaged?: boolean;
  existsSyncFn?: (candidatePath: string) => boolean;
  spawnProcess?: typeof spawn;
  now?: () => Date;
  readyTimeoutMs?: number;
  wsTimeoutMs?: number;
  startedTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  stopAckTimeoutMs?: number;
  stopSigkillTimeoutMs?: number;
  reconcileWindowMs?: number;
}

export class SidecarBridge implements SidecarRuntime {
  private readonly spawnProcess: typeof spawn;
  private readonly now: () => Date;
  private readonly existsSyncFn: (candidatePath: string) => boolean;
  private readonly options: SidecarBridgeOptions;
  private readonly recordsByWorkspaceId = new Map<WorkspaceId, BridgeRecord>();
  private readonly observerEventEmitter = new EventEmitter();

  public constructor(options: SidecarBridgeOptions = {}) {
    this.options = options;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? (() => new Date());
    this.existsSyncFn = options.existsSyncFn ?? existsSync;
  }

  public async start(command: SidecarStartCommand): Promise<SidecarStartedEvent> {
    const existing = this.recordsByWorkspaceId.get(command.workspaceId);
    if (existing) {
      return existing.startedEvent;
    }

    const sidecarBin = this.resolveBinaryPath();
    if (!sidecarBin) {
      return this.createUnavailableStartedEvent(command.workspaceId);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const record = await this.spawnAndHandshake(sidecarBin, command);
        this.recordsByWorkspaceId.set(command.workspaceId, record);
        return record.startedEvent;
      } catch (error) {
        lastError = error;
        if (!(error instanceof SidecarBridgeError) || error.kind === "fatal" || attempt === 1) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  public async stop(command: SidecarStopCommand): Promise<SidecarStoppedEvent | null> {
    const record = this.recordsByWorkspaceId.get(command.workspaceId);
    if (!record) {
      return null;
    }

    if (record.ws.readyState === record.ws.OPEN) {
      record.ws.send(JSON.stringify(command));
    }

    const stoppedPromise = record.lifecycleEmitter.waitForStopped();
    const sigtermTimer = setTimeout(() => {
      record.lifecycleEmitter.markMainSentSignal("SIGTERM");
      record.childProcess.kill("SIGTERM");
    }, this.options.stopAckTimeoutMs ?? 1_000);
    const sigkillTimer = setTimeout(() => {
      record.lifecycleEmitter.markMainSentSignal("SIGKILL");
      record.childProcess.kill("SIGKILL");
    }, (this.options.stopAckTimeoutMs ?? 1_000) + (this.options.stopSigkillTimeoutMs ?? 3_000));

    try {
      return await stoppedPromise;
    } finally {
      clearTimeout(sigtermTimer);
      clearTimeout(sigkillTimer);
      this.cleanupRecord(command.workspaceId, record);
    }
  }

  public listRunningWorkspaceIds(): WorkspaceId[] {
    return Array.from(this.recordsByWorkspaceId.keys());
  }

  public onObserverEvent(
    listener: SidecarObserverEventListener,
  ): SidecarObserverEventSubscription {
    this.observerEventEmitter.on(OBSERVER_EVENT_NAME, listener);

    return {
      dispose: () => {
        this.observerEventEmitter.off(OBSERVER_EVENT_NAME, listener);
      },
    };
  }

  private resolveBinaryPath(): string | null {
    if (this.options.sidecarBin) {
      return this.existsSyncFn(this.options.sidecarBin) ? this.options.sidecarBin : null;
    }

    const binaryPath = resolveSidecarBinaryPath({
      appPath: this.options.appPath ?? process.cwd(),
      cwd: this.options.cwd ?? process.cwd(),
      resourcesPath: this.options.resourcesPath ?? process.resourcesPath,
      isPackaged: this.options.isPackaged ?? false,
      existsSyncFn: this.existsSyncFn,
    });

    return binaryPath;
  }

  private createUnavailableStartedEvent(workspaceId: WorkspaceId): SidecarStartedEvent {
    return {
      type: "sidecar/started",
      workspaceId,
      pid: UNAVAILABLE_SIDECAR_PID,
      startedAt: this.now().toISOString(),
    };
  }

  private async spawnAndHandshake(
    sidecarBin: string,
    command: SidecarStartCommand,
  ): Promise<BridgeRecord> {
    const token = randomBytes(32).toString("hex");
    const args = [`--workspace-id=${command.workspaceId}`];
    if (this.options.dataDir) {
      args.push(`--data-dir=${this.options.dataDir}`);
    }
    const childProcess = this.spawnProcess(
      sidecarBin,
      args,
      {
        env: { ...process.env, NEXUS_SIDECAR_TOKEN: token },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let ws: WebSocket | null = null;
    try {
      const ready = await waitForReadyLine(childProcess, this.options.readyTimeoutMs ?? 5_000);
      ws = await connectWebSocketWithRefusedRetry(
        ready.port,
        token,
        this.options.wsTimeoutMs ?? 2_000,
      );
      const startedEvent = await performStartHandshake(
        ws,
        command,
        ready.pid,
        this.options.startedTimeoutMs ?? 2_000,
      );
      return this.bindRecord(command.workspaceId, childProcess, ws, startedEvent);
    } catch (error) {
      ws?.terminate();
      childProcess.kill("SIGTERM");
      throw error;
    }
  }

  private bindRecord(
    workspaceId: WorkspaceId,
    childProcess: ChildProcess,
    ws: WebSocket,
    startedEvent: SidecarStartedEvent,
  ): BridgeRecord {
    const lifecycleEmitter = new SidecarLifecycleEmitter({
      workspaceId,
      now: this.now,
      reconcileWindowMs: this.options.reconcileWindowMs,
    });
    const record: BridgeRecord = {
      childProcess,
      ws,
      startedEvent,
      lifecycleEmitter,
      heartbeatTimer: null,
    };

    childProcess.once("exit", (exitCode, signal) => {
      lifecycleEmitter.recordProcessExit(exitCode, signal);
    });
    ws.once("close", (code) => {
      lifecycleEmitter.recordWsClose(code, code === 1000);
    });
    ws.on("message", (data) => {
      this.handleRuntimeMessage(workspaceId, record, data.toString());
    });
    lifecycleEmitter.once("stopped", () => {
      this.cleanupRecord(workspaceId, record);
    });
    this.startHeartbeat(record);
    return record;
  }

  private handleRuntimeMessage(
    workspaceId: WorkspaceId,
    record: BridgeRecord,
    rawMessage: string,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    if (isHarnessObserverEvent(parsed)) {
      this.emitObserverEvent(parsed);
      return;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { type?: unknown }).type === "sidecar/stopped"
    ) {
      // SidecarStoppedEvent 수신은 sidecar의 graceful stop 신호. 실제 WS close code(1000/1001/1006)는
      // sidecar가 송신하는 close frame이 결정한다(handleRuntimeMessage가 hardcode하면 race로
      // close code 상호운용성 검증이 1001 going-away를 잃는다). heartbeatTimer 정리만 수행.
      this.cleanupRecord(workspaceId, record);
    }
  }

  private emitObserverEvent(event: HarnessObserverEvent): void {
    this.observerEventEmitter.emit(OBSERVER_EVENT_NAME, event);
  }

  private startHeartbeat(record: BridgeRecord): void {
    let lastPongAt = Date.now();
    let missedPongs = 0;
    record.ws.on("pong", () => {
      lastPongAt = Date.now();
      missedPongs = 0;
    });
    record.heartbeatTimer = setInterval(() => {
      if (Date.now() - lastPongAt > (this.options.heartbeatTimeoutMs ?? 5_000)) {
        missedPongs += 1;
      }
      if (missedPongs >= 2) {
        record.ws.terminate();
        record.lifecycleEmitter.markMainSentSignal("SIGTERM");
        record.childProcess.kill("SIGTERM");
        return;
      }
      if (record.ws.readyState === record.ws.OPEN) {
        record.ws.ping();
      }
    }, this.options.heartbeatIntervalMs ?? 15_000);
  }

  private cleanupRecord(workspaceId: WorkspaceId, record: BridgeRecord): void {
    if (record.heartbeatTimer) {
      clearInterval(record.heartbeatTimer);
      record.heartbeatTimer = null;
    }
    if (this.recordsByWorkspaceId.get(workspaceId) === record) {
      this.recordsByWorkspaceId.delete(workspaceId);
    }
  }
}

export { SidecarBridgeError } from "./handshake";
export { SidecarLifecycleEmitter } from "./lifecycle-emitter";
