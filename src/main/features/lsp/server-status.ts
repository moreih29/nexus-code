// Each language server's status and log, as main knows them: kept per
// (workspace, preset language), so a server's history carries over the
// restarts that give it a new server id.

import type {
  LspLogEntry,
  LspLogLevel,
  LspServerStatus,
  LspStopReason,
} from "../../../shared/lsp/status";
import { LSP_CRASH_LIMIT, LSP_CRASH_WINDOW_MS } from "../../../shared/util/timing-constants";

/** Entries kept per server; older ones are dropped. */
const LOG_LIMIT = 1000;
/** A longer message, such as a stack trace in one logMessage, is cut. */
const LOG_MESSAGE_LIMIT = 8 * 1024;

interface ServerLog {
  nextSeq: number;
  entries: LspLogEntry[];
}

function keyOf(workspaceId: string, languageId: string): string {
  return `${workspaceId}\0${languageId}`;
}

export class LspServerStatusTracker {
  private readonly statuses = new Map<string, LspServerStatus>();
  private readonly failures = new Map<string, number[]>();
  private readonly logs = new Map<string, ServerLog>();

  constructor(
    private readonly onChange: (status: LspServerStatus) => void,
    private readonly now: () => number = Date.now,
  ) {}

  starting(workspaceId: string, languageId: string): void {
    this.set(workspaceId, languageId, { state: "starting" });
  }

  running(
    workspaceId: string,
    languageId: string,
    info?: { name: string; version?: string },
  ): void {
    this.set(workspaceId, languageId, {
      state: "running",
      ...(info ? { serverName: info.name } : {}),
      ...(info?.version ? { serverVersion: info.version } : {}),
    });
    const name = info ? [info.name, info.version].filter(Boolean).join(" ") : "server";
    this.log(workspaceId, languageId, "lifecycle", `Started ${name}`);
  }

  stopped(workspaceId: string, languageId: string, reason: LspStopReason, detail: string): void {
    if (reason !== "crashed") this.failures.delete(keyOf(workspaceId, languageId));
    this.set(workspaceId, languageId, { state: "stopped", stopReason: reason });
    this.log(workspaceId, languageId, "lifecycle", `Stopped: ${detail}`);
  }

  /**
   * Records a crash, a hang or a failed start, and returns whether the
   * server should start again: not once it failed LSP_CRASH_LIMIT times
   * within LSP_CRASH_WINDOW_MS. Then it stays down until `resetFailures`.
   */
  failed(workspaceId: string, languageId: string, error: string): boolean {
    const key = keyOf(workspaceId, languageId);
    const now = this.now();
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < LSP_CRASH_WINDOW_MS);
    recent.push(now);
    this.failures.set(key, recent);
    this.log(workspaceId, languageId, "error", error);
    if (recent.length < LSP_CRASH_LIMIT) {
      this.set(workspaceId, languageId, { state: "stopped", stopReason: "crashed", error });
      return true;
    }
    this.set(workspaceId, languageId, { state: "failed", error, gaveUp: true });
    this.log(workspaceId, languageId, "lifecycle", "Gave up: failed too often");
    return false;
  }

  hasGivenUp(workspaceId: string, languageId: string): boolean {
    return this.statuses.get(keyOf(workspaceId, languageId))?.gaveUp === true;
  }

  /** Lets a server that gave up start again: the user restarts it. */
  resetFailures(workspaceId: string, languageId: string, reason: LspStopReason): void {
    const key = keyOf(workspaceId, languageId);
    this.failures.delete(key);
    if (this.statuses.get(key)?.gaveUp) {
      this.set(workspaceId, languageId, { state: "stopped", stopReason: reason });
    }
  }

  /** The servers that gave up, which have no live server to stop. */
  givenUp(): Array<{ workspaceId: string; languageId: string }> {
    return [...this.statuses.values()]
      .filter((status) => status.gaveUp)
      .map(({ workspaceId, languageId }) => ({ workspaceId, languageId }));
  }

  forgetWorkspace(workspaceId: string): void {
    for (const map of [this.statuses, this.failures, this.logs]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${workspaceId}\0`)) map.delete(key);
      }
    }
  }

  list(): LspServerStatus[] {
    return [...this.statuses.values()];
  }

  log(workspaceId: string, languageId: string, level: LspLogLevel, message: string): void {
    const key = keyOf(workspaceId, languageId);
    let log = this.logs.get(key);
    if (!log) {
      log = { nextSeq: 0, entries: [] };
      this.logs.set(key, log);
    }
    const text =
      message.length > LOG_MESSAGE_LIMIT ? `${message.slice(0, LOG_MESSAGE_LIMIT)}…` : message;
    log.entries.push({ seq: log.nextSeq++, time: this.now(), level, message: text });
    if (log.entries.length > LOG_LIMIT) log.entries.splice(0, log.entries.length - LOG_LIMIT);
  }

  /** The entries after `afterSeq`, or all of them. */
  logEntries(workspaceId: string, languageId: string, afterSeq = -1): LspLogEntry[] {
    const entries = this.logs.get(keyOf(workspaceId, languageId))?.entries ?? [];
    return entries.filter((entry) => entry.seq > afterSeq);
  }

  /** Sets the state, keeping the server's name across it. */
  private set(
    workspaceId: string,
    languageId: string,
    next: Omit<LspServerStatus, "workspaceId" | "languageId">,
  ): void {
    const key = keyOf(workspaceId, languageId);
    const previous = this.statuses.get(key);
    const status: LspServerStatus = {
      workspaceId,
      languageId,
      ...(previous?.serverName ? { serverName: previous.serverName } : {}),
      ...(previous?.serverVersion ? { serverVersion: previous.serverVersion } : {}),
      ...next,
    };
    this.statuses.set(key, status);
    this.onChange(status);
  }
}
