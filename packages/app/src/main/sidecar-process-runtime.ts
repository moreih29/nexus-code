import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  SidecarStartCommand,
  SidecarStartedEvent,
  SidecarStopCommand,
  SidecarStoppedEvent,
} from "../../../shared/src/contracts/sidecar";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import type { SidecarRuntime } from "./sidecar-runtime";

const SIDECAR_BINARY_NAME =
  process.platform === "win32" ? "nexus-sidecar.exe" : "nexus-sidecar";
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const UNAVAILABLE_SIDECAR_PID = -1;
const MAIN_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface SidecarBinaryResolutionOptions {
  appPath: string;
  cwd: string;
  resourcesPath: string;
  isPackaged: boolean;
  existsSyncFn?: (candidatePath: string) => boolean;
}

export interface SidecarProcessRuntimeLogger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
}

export interface SidecarProcessRuntimeOptions {
  appPath?: string;
  cwd?: string;
  resourcesPath?: string;
  isPackaged?: boolean;
  now?: () => Date;
  stopTimeoutMs?: number;
  logger?: SidecarProcessRuntimeLogger;
  spawnProcess?: typeof spawn;
  existsSyncFn?: (candidatePath: string) => boolean;
}

interface SidecarProcessRecord {
  readonly childProcess: ChildProcess;
  readonly startedEvent: SidecarStartedEvent;
  readonly exitPromise: Promise<SidecarProcessExitOutcome>;
}

interface SidecarProcessExitOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

const DEFAULT_LOGGER: SidecarProcessRuntimeLogger = {
  info: (message) => {
    console.log(message);
  },
  warn: (message, error) => {
    if (error === undefined) {
      console.warn(message);
      return;
    }

    console.warn(message, error);
  },
};

export function resolveSidecarBinaryPath(
  options: SidecarBinaryResolutionOptions,
): string | null {
  const existsSyncFn = options.existsSyncFn ?? existsSync;
  const packagedCandidate = path.resolve(
    options.resourcesPath,
    "sidecar",
    SIDECAR_BINARY_NAME,
  );
  const devCandidate = findDevSidecarBinaryPath(
    [options.appPath, options.cwd, MAIN_MODULE_DIR],
    existsSyncFn,
  );

  if (options.isPackaged) {
    return existsSyncFn(packagedCandidate) ? packagedCandidate : null;
  }

  if (devCandidate) {
    return devCandidate;
  }

  return existsSyncFn(packagedCandidate) ? packagedCandidate : null;
}

export class SidecarProcessRuntime implements SidecarRuntime {
  private readonly appPath: string;
  private readonly cwd: string;
  private readonly resourcesPath: string;
  private readonly isPackaged: boolean;

  private readonly now: () => Date;
  private readonly stopTimeoutMs: number;
  private readonly logger: SidecarProcessRuntimeLogger;
  private readonly spawnProcess: typeof spawn;
  private readonly existsSyncFn: (candidatePath: string) => boolean;

  private readonly recordsByWorkspaceId = new Map<WorkspaceId, SidecarProcessRecord>();
  private readonly stopPromisesByWorkspaceId = new Map<
    WorkspaceId,
    Promise<SidecarStoppedEvent | null>
  >();

  private cachedBinaryPath: string | null = null;
  private warnedMissingBinary = false;

  public constructor(options: SidecarProcessRuntimeOptions = {}) {
    this.appPath = options.appPath ?? process.cwd();
    this.cwd = options.cwd ?? process.cwd();
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath;
    this.isPackaged = options.isPackaged ?? false;

    this.now = options.now ?? (() => new Date());
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.existsSyncFn = options.existsSyncFn ?? existsSync;
  }

  public async start(command: SidecarStartCommand): Promise<SidecarStartedEvent> {
    const existing = this.recordsByWorkspaceId.get(command.workspaceId);
    if (existing) {
      return existing.startedEvent;
    }

    const binaryPath = this.resolveBinaryPath();
    if (!binaryPath) {
      this.warnMissingBinary();
      return this.createUnavailableStartedEvent(command.workspaceId);
    }

    const record = await this.spawnSidecarProcess(binaryPath, command);
    if (!record) {
      return this.createUnavailableStartedEvent(command.workspaceId);
    }

    this.recordsByWorkspaceId.set(command.workspaceId, record);
    return record.startedEvent;
  }

  public async stop(command: SidecarStopCommand): Promise<SidecarStoppedEvent | null> {
    const existingStop = this.stopPromisesByWorkspaceId.get(command.workspaceId);
    if (existingStop) {
      return existingStop;
    }

    const record = this.recordsByWorkspaceId.get(command.workspaceId);
    if (!record) {
      return null;
    }

    const stopPromise = this.stopManagedSidecar(command.workspaceId, record).finally(() => {
      this.stopPromisesByWorkspaceId.delete(command.workspaceId);
    });

    this.stopPromisesByWorkspaceId.set(command.workspaceId, stopPromise);
    return stopPromise;
  }

  public listRunningWorkspaceIds(): WorkspaceId[] {
    return Array.from(this.recordsByWorkspaceId.keys());
  }

  private resolveBinaryPath(): string | null {
    if (this.cachedBinaryPath && this.existsSyncFn(this.cachedBinaryPath)) {
      return this.cachedBinaryPath;
    }

    const resolved = resolveSidecarBinaryPath({
      appPath: this.appPath,
      cwd: this.cwd,
      resourcesPath: this.resourcesPath,
      isPackaged: this.isPackaged,
      existsSyncFn: this.existsSyncFn,
    });

    this.cachedBinaryPath = resolved;
    return resolved;
  }

  private warnMissingBinary(): void {
    if (this.warnedMissingBinary) {
      return;
    }

    this.warnedMissingBinary = true;
    this.logger.warn(
      [
        "SidecarProcessRuntime: sidecar binary not found.",
        `Expected dev path under <repo>/sidecar/bin/${SIDECAR_BINARY_NAME} or packaged path ${path.resolve(
          this.resourcesPath,
          "sidecar",
          SIDECAR_BINARY_NAME,
        )}.`,
        "Continuing without sidecar process startup.",
      ].join(" "),
    );
  }

  private createUnavailableStartedEvent(workspaceId: WorkspaceId): SidecarStartedEvent {
    return {
      type: "sidecar/started",
      workspaceId,
      pid: UNAVAILABLE_SIDECAR_PID,
      startedAt: this.now().toISOString(),
    };
  }

  private async spawnSidecarProcess(
    binaryPath: string,
    command: SidecarStartCommand,
  ): Promise<SidecarProcessRecord | null> {
    return new Promise((resolve) => {
      let settled = false;

      const childProcess = this.spawnProcess(binaryPath, createSidecarProcessArgs(command), {
        cwd: command.workspacePath,
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
      });

      forwardSidecarStderr(command.workspaceId, childProcess, this.logger);

      const onErrorBeforeSpawn = (error: unknown): void => {
        if (settled) {
          this.logger.warn(
            `SidecarProcessRuntime: sidecar process error for workspace "${command.workspaceId}".`,
            error,
          );
          return;
        }

        settled = true;
        this.logger.warn(
          `SidecarProcessRuntime: failed to spawn sidecar for workspace "${command.workspaceId}" from "${binaryPath}".`,
          error,
        );
        resolve(null);
      };

      childProcess.once("error", onErrorBeforeSpawn);
      childProcess.once("spawn", () => {
        if (settled) {
          return;
        }

        settled = true;
        childProcess.off("error", onErrorBeforeSpawn);
        childProcess.on("error", (error) => {
          this.logger.warn(
            `SidecarProcessRuntime: sidecar process error for workspace "${command.workspaceId}".`,
            error,
          );
        });

        const startedEvent: SidecarStartedEvent = {
          type: "sidecar/started",
          workspaceId: command.workspaceId,
          pid: childProcess.pid ?? UNAVAILABLE_SIDECAR_PID,
          startedAt: this.now().toISOString(),
        };

        const exitPromise = waitForChildProcessExit(childProcess);
        const record: SidecarProcessRecord = {
          childProcess,
          startedEvent,
          exitPromise,
        };

        void exitPromise.then((exitOutcome) => {
          this.handleChildProcessExit(command.workspaceId, childProcess, exitOutcome);
        });

        resolve(record);
      });
    });
  }

  private async stopManagedSidecar(
    workspaceId: WorkspaceId,
    record: SidecarProcessRecord,
  ): Promise<SidecarStoppedEvent> {
    this.recordsByWorkspaceId.delete(workspaceId);

    this.sendSignal(workspaceId, record.childProcess, "SIGTERM");
    let exitOutcome = await waitForExitWithTimeout(record.exitPromise, this.stopTimeoutMs);

    if (!exitOutcome) {
      this.logger.warn(
        `SidecarProcessRuntime: sidecar for workspace "${workspaceId}" did not exit within ${this.stopTimeoutMs}ms; sending SIGKILL.`,
      );
      this.sendSignal(workspaceId, record.childProcess, "SIGKILL");
      exitOutcome = await record.exitPromise;
    }

    return {
      type: "sidecar/stopped",
      workspaceId,
      reason: "requested",
      stoppedAt: this.now().toISOString(),
      exitCode: exitOutcome.exitCode,
    };
  }

  private sendSignal(
    workspaceId: WorkspaceId,
    childProcess: ChildProcess,
    signal: NodeJS.Signals,
  ): void {
    try {
      childProcess.kill(signal);
    } catch (error) {
      this.logger.warn(
        `SidecarProcessRuntime: failed to send ${signal} to sidecar for workspace "${workspaceId}".`,
        error,
      );
    }
  }

  private handleChildProcessExit(
    workspaceId: WorkspaceId,
    childProcess: ChildProcess,
    outcome: SidecarProcessExitOutcome,
  ): void {
    const record = this.recordsByWorkspaceId.get(workspaceId);
    if (!record || record.childProcess !== childProcess) {
      return;
    }

    this.recordsByWorkspaceId.delete(workspaceId);

    const codePart = outcome.exitCode === null ? "exitCode=null" : `exitCode=${outcome.exitCode}`;
    const signalPart = outcome.signal ? ` signal=${outcome.signal}` : "";
    this.logger.info(
      `SidecarProcessRuntime: sidecar for workspace "${workspaceId}" exited (${codePart}${signalPart}).`,
    );
  }
}

function findDevSidecarBinaryPath(
  searchRoots: string[],
  existsSyncFn: (candidatePath: string) => boolean,
): string | null {
  const visitedRoots = new Set<string>();

  for (const root of searchRoots) {
    if (!root || root.trim().length === 0) {
      continue;
    }

    let cursor = path.resolve(root);
    while (true) {
      if (visitedRoots.has(cursor)) {
        break;
      }

      visitedRoots.add(cursor);
      const candidatePath = path.join(cursor, "sidecar", "bin", SIDECAR_BINARY_NAME);
      if (existsSyncFn(candidatePath)) {
        return candidatePath;
      }

      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }

      cursor = parent;
    }
  }

  return null;
}

function createSidecarProcessArgs(command: SidecarStartCommand): string[] {
  return [
    "--workspace-id",
    command.workspaceId,
    "--workspace-path",
    command.workspacePath,
    "--start-reason",
    command.reason,
  ];
}

function forwardSidecarStderr(
  workspaceId: WorkspaceId,
  childProcess: ChildProcess,
  logger: SidecarProcessRuntimeLogger,
): void {
  childProcess.stderr?.setEncoding("utf8");
  childProcess.stderr?.on("data", (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of text.split(/\r?\n/u)) {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0) {
        continue;
      }

      logger.info(`[sidecar:${workspaceId}] ${trimmedLine}`);
    }
  });
}

function waitForChildProcessExit(
  childProcess: ChildProcess,
): Promise<SidecarProcessExitOutcome> {
  return new Promise((resolve) => {
    childProcess.once("exit", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
      });
    });
  });
}

function waitForExitWithTimeout(
  exitPromise: Promise<SidecarProcessExitOutcome>,
  timeoutMs: number,
): Promise<SidecarProcessExitOutcome | null> {
  return new Promise((resolve) => {
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(null);
    }, timeoutMs);
    timeoutHandle.unref?.();

    exitPromise.then((exitOutcome) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve(exitOutcome);
    });
  });
}
