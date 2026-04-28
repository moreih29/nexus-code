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
import {
  isLspLifecycleReply,
  isLspServerPayloadMessage,
  isLspServerStoppedEvent,
  type LspClientPayloadMessage,
  type LspHealthCheckCommand,
  type LspLifecycleReply,
  type LspRestartServerCommand,
  type LspServerHealthReply,
  type LspServerPayloadMessage,
  type LspServerStartedReply,
  type LspServerStartFailedReply,
  type LspServerStoppedEvent,
  type LspServerStopReason,
  type LspStartServerCommand,
  type LspStopAllServersCommand,
  type LspStopAllServersReply,
  type LspStopServerCommand,
} from "../../../../shared/src/contracts/lsp/lsp-sidecar";
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

interface PendingLspRequest {
  workspaceId: WorkspaceId;
  resolve(reply: LspLifecycleReply): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const UNAVAILABLE_SIDECAR_PID = -1;
const OBSERVER_EVENT_NAME = "observer-event";
const LSP_SERVER_PAYLOAD_EVENT_NAME = "lsp-server-payload";
const LSP_SERVER_STOPPED_EVENT_NAME = "lsp-server-stopped";
type ExpectedCloseCodes = [number, ...number[]];

export const DEFAULT_EXPECTED_CLOSE_CODES: ExpectedCloseCodes = [1000, 1001];

export interface SidecarObserverEventSubscription {
  dispose(): void;
}

export type SidecarObserverEventListener = (event: HarnessObserverEvent) => void;
export type LspServerPayloadListener = (message: LspServerPayloadMessage) => void;
export type LspServerStoppedListener = (event: LspServerStoppedEvent) => void;

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
  lspRequestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  stopAckTimeoutMs?: number;
  stopSigkillTimeoutMs?: number;
  reconcileWindowMs?: number;
  expectedCloseCodes?: readonly number[];
}

export class SidecarBridge implements SidecarRuntime {
  private readonly spawnProcess: typeof spawn;
  private readonly now: () => Date;
  private readonly existsSyncFn: (candidatePath: string) => boolean;
  private readonly options: SidecarBridgeOptions;
  private readonly recordsByWorkspaceId = new Map<WorkspaceId, BridgeRecord>();
  private readonly observerEventEmitter = new EventEmitter();
  private readonly lspEventEmitter = new EventEmitter();
  private readonly pendingLspRequests = new Map<string, PendingLspRequest>();
  private readonly expectedCloseCodes: ExpectedCloseCodes;
  private nextStopAllRequestId = 1;

  public constructor(options: SidecarBridgeOptions = {}) {
    this.options = options;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? (() => new Date());
    this.existsSyncFn = options.existsSyncFn ?? existsSync;
    this.expectedCloseCodes = normalizeExpectedCloseCodes(options.expectedCloseCodes);
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

  public startServer(
    command: LspStartServerCommand,
  ): Promise<LspServerStartedReply | LspServerStartFailedReply> {
    return this.sendLspLifecycleRequest(command.workspaceId, command, (reply) =>
      reply.action === "server_started" || reply.action === "server_start_failed",
    );
  }

  public stopServer(command: LspStopServerCommand): Promise<LspServerStoppedEvent> {
    return this.sendLspLifecycleRequest(command.workspaceId, command, (reply) =>
      reply.action === "server_stopped",
    );
  }

  public restartServer(
    command: LspRestartServerCommand,
  ): Promise<LspServerStartedReply | LspServerStartFailedReply> {
    return this.sendLspLifecycleRequest(command.workspaceId, command, (reply) =>
      reply.action === "server_started" || reply.action === "server_start_failed",
    );
  }

  public healthCheck(command: LspHealthCheckCommand): Promise<LspServerHealthReply> {
    return this.sendLspLifecycleRequest(command.workspaceId, command, (reply) =>
      reply.action === "server_health",
    );
  }

  public stopAllServers(command: LspStopAllServersCommand): Promise<LspStopAllServersReply> {
    const workspaceId = command.workspaceId;
    if (!workspaceId) {
      return Promise.reject(
        new Error("workspaceId is required for a single sidecar stop_all request."),
      );
    }

    return this.sendLspLifecycleRequest(workspaceId, command, (reply) =>
      reply.action === "stop_all_stopped",
    );
  }

  public async stopAllLspServers(reason: LspServerStopReason = "app-shutdown"): Promise<void> {
    const workspaceIds = this.listRunningWorkspaceIds();
    await Promise.all(
      workspaceIds.map((workspaceId) =>
        this.stopAllServers({
          type: "lsp/lifecycle",
          action: "stop_all",
          requestId: `lsp-stop-all-${this.nextStopAllRequestId++}`,
          workspaceId,
          reason,
          expectedCloseCodes: [...this.expectedCloseCodes] as ExpectedCloseCodes,
        }).then(() => undefined),
      ),
    );
  }

  public sendClientPayload(message: LspClientPayloadMessage): void {
    const record = this.recordsByWorkspaceId.get(message.workspaceId);
    if (!record || record.ws.readyState !== record.ws.OPEN) {
      throw new Error(`Sidecar WebSocket is not open for workspace "${message.workspaceId}".`);
    }

    record.ws.send(JSON.stringify(message));
  }

  public onServerPayload(listener: LspServerPayloadListener): SidecarObserverEventSubscription {
    this.lspEventEmitter.on(LSP_SERVER_PAYLOAD_EVENT_NAME, listener);

    return {
      dispose: () => {
        this.lspEventEmitter.off(LSP_SERVER_PAYLOAD_EVENT_NAME, listener);
      },
    };
  }

  public onServerStopped(listener: LspServerStoppedListener): SidecarObserverEventSubscription {
    this.lspEventEmitter.on(LSP_SERVER_STOPPED_EVENT_NAME, listener);

    return {
      dispose: () => {
        this.lspEventEmitter.off(LSP_SERVER_STOPPED_EVENT_NAME, listener);
      },
    };
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
      lifecycleEmitter.recordWsClose(code, this.expectedCloseCodes.includes(code));
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

    if (isLspServerPayloadMessage(parsed)) {
      this.lspEventEmitter.emit(LSP_SERVER_PAYLOAD_EVENT_NAME, parsed);
      return;
    }

    if (isLspServerStoppedEvent(parsed)) {
      if (isLspLifecycleReply(parsed)) {
        this.resolvePendingLspRequest(parsed);
      }
      this.lspEventEmitter.emit(LSP_SERVER_STOPPED_EVENT_NAME, parsed);
      return;
    }

    if (isLspLifecycleReply(parsed)) {
      this.resolvePendingLspRequest(parsed);
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

  private sendLspLifecycleRequest<TReply extends LspLifecycleReply>(
    workspaceId: WorkspaceId,
    command: { requestId: string },
    isExpectedReply: (reply: LspLifecycleReply) => boolean,
  ): Promise<TReply> {
    const record = this.recordsByWorkspaceId.get(workspaceId);
    if (!record || record.ws.readyState !== record.ws.OPEN) {
      return Promise.reject(
        new Error(`Sidecar WebSocket is not open for workspace "${workspaceId}".`),
      );
    }

    return new Promise<TReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingLspRequests.delete(command.requestId);
        reject(new Error(`LSP lifecycle request "${command.requestId}" timed out.`));
      }, this.options.lspRequestTimeoutMs ?? 8_000);

      this.pendingLspRequests.set(command.requestId, {
        workspaceId,
        timer,
        resolve: (reply) => {
          if (!isExpectedReply(reply)) {
            reject(
              new Error(
                `Unexpected LSP lifecycle reply "${reply.action}" for request "${command.requestId}".`,
              ),
            );
            return;
          }
          resolve(reply as TReply);
        },
        reject,
      });

      try {
        record.ws.send(JSON.stringify(command));
      } catch (error) {
        clearTimeout(timer);
        this.pendingLspRequests.delete(command.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private resolvePendingLspRequest(reply: LspLifecycleReply): void {
    const pending = this.pendingLspRequests.get(reply.requestId);
    if (!pending) {
      return;
    }

    this.pendingLspRequests.delete(reply.requestId);
    clearTimeout(pending.timer);
    pending.resolve(reply);
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
    for (const [requestId, pending] of this.pendingLspRequests.entries()) {
      if (pending.workspaceId === workspaceId) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(`Sidecar for workspace "${workspaceId}" stopped before LSP reply.`),
        );
        this.pendingLspRequests.delete(requestId);
      }
    }
    if (this.recordsByWorkspaceId.get(workspaceId) === record) {
      this.recordsByWorkspaceId.delete(workspaceId);
    }
  }
}

function normalizeExpectedCloseCodes(
  candidate?: readonly number[],
): ExpectedCloseCodes {
  const source = candidate && candidate.length > 0 ? candidate : DEFAULT_EXPECTED_CLOSE_CODES;
  const normalized = Array.from(
    new Set(source.filter((code) => Number.isInteger(code) && code >= 1000 && code <= 4999)),
  );
  if (normalized.length === 0) {
    return [...DEFAULT_EXPECTED_CLOSE_CODES];
  }
  return normalized as ExpectedCloseCodes;
}

export { SidecarBridgeError } from "./handshake";
export { SidecarLifecycleEmitter } from "./lifecycle-emitter";
