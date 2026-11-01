/**
 * services/lsp/ — Editor-independent LSP consumers.
 *
 * Code in this folder operates on LSP server events at the workspace/UX
 * level: routing window/showMessage and $/progress notifications to the
 * notification surface, maintaining the workspace-symbol registry, etc.
 *
 * Monaco-bound LSP code (providers, document sync, range converters) lives
 * in `services/editor/lsp/`. If a new file plugs into Monaco's editor
 * lifecycle, put it there. If it consumes LSP server events without touching
 * Monaco, put it here.
 */

import i18next from "i18next";
import { createLogger } from "../../../shared/log/renderer";
import {
  type LspServerEvent,
  type MessageType,
  ProgressParamsSchema,
  type ProgressToken,
  ShowMessageParamsSchema,
  ShowMessageRequestParamsSchema,
  WorkDoneProgressCreateParamsSchema,
  WorkDoneProgressValueSchema,
} from "../../../shared/lsp";
import { showToast } from "../../components/ui/toast";
import { ipcListen } from "../../ipc/client";
import { useLspStatusStore } from "../../state/stores/lsp-status";
import { registerWorkspaceCleanup } from "../../state/workspace-cleanup";

const log = createLogger("lsp-server-ux");

export type WorkDoneProgressPhase = "create" | "begin" | "report" | "end";

export interface WorkDoneProgressState {
  workspaceId: string;
  languageId: string;
  token: ProgressToken;
  phase: WorkDoneProgressPhase;
  done: boolean;
  title?: string;
  message?: string;
  percentage?: number;
  cancellable?: boolean;
}

const workDoneProgressByKey = new Map<string, WorkDoneProgressState>();
/** When each server message was last toasted, so a repeated one is not. */
const toastedMessages = new Map<string, number>();
const MESSAGE_TOAST_REPEAT_MS = 60_000;
let serverEventUnlisten: (() => void) | null = null;
let workspaceCleanupUnregister: (() => void) | null = null;

function sourcePrefix(event: LspServerEvent): string {
  return `[lsp:${event.languageId}:${event.workspaceId}]`;
}

function logBySeverity(type: MessageType, msg: string): void {
  if (type === 1) {
    log.error(msg);
    return;
  }
  if (type === 2) {
    log.warn(msg);
    return;
  }
  if (type === 3) {
    log.info(msg);
    return;
  }
  log.debug(msg);
}

function writeMessage(event: LspServerEvent, prefix: string): void {
  const parsed = ShowMessageParamsSchema.safeParse(event.params);
  if (!parsed.success) return;

  logBySeverity(parsed.data.type, `${prefix} ${parsed.data.message}`);
  // Errors and warnings are meant for the user; info is mostly a server
  // narrating its own startup, which the status bar shows already.
  if (parsed.data.type === 1 || parsed.data.type === 2) {
    toastMessage(event, parsed.data.type === 1 ? "error" : "warning", parsed.data.message);
  }
}

function toastMessage(event: LspServerEvent, kind: "error" | "warning", message: string): void {
  const key = JSON.stringify([event.workspaceId, event.languageId, message]);
  const now = Date.now();
  const last = toastedMessages.get(key);
  if (last !== undefined && now - last < MESSAGE_TOAST_REPEAT_MS) return;
  toastedMessages.set(key, now);
  const language = i18next.t(`lsp.language.${event.languageId}`, {
    defaultValue: event.languageId,
  });
  showToast({ kind, message: i18next.t("lsp.serverMessage", { language, message }) });
}

function writeMessageRequestStub(params: unknown, prefix: string): void {
  const parsed = ShowMessageRequestParamsSchema.safeParse(params);
  if (!parsed.success) return;

  logBySeverity(parsed.data.type, `${prefix} ${parsed.data.message}`);
}

function progressKey(workspaceId: string, languageId: string, token: ProgressToken): string {
  return JSON.stringify([workspaceId, languageId, token]);
}

function setProgressState(state: WorkDoneProgressState): void {
  workDoneProgressByKey.set(progressKey(state.workspaceId, state.languageId, state.token), state);
}

/** Has the status store show the work the server began last, or none. */
function publishProgress(workspaceId: string, languageId: string): void {
  let latest: WorkDoneProgressState | undefined;
  for (const state of workDoneProgressByKey.values()) {
    if (state.workspaceId !== workspaceId || state.languageId !== languageId) continue;
    if (state.phase === "begin" || state.phase === "report") latest = state;
  }
  useLspStatusStore
    .getState()
    .setProgress(
      workspaceId,
      languageId,
      latest
        ? { title: latest.title, message: latest.message, percentage: latest.percentage }
        : null,
    );
}

function registerWorkDoneProgressToken(event: LspServerEvent): void {
  const parsed = WorkDoneProgressCreateParamsSchema.safeParse(event.params);
  if (!parsed.success) return;

  setProgressState({
    workspaceId: event.workspaceId,
    languageId: event.languageId,
    token: parsed.data.token,
    phase: "create",
    done: false,
  });
}

function updateWorkDoneProgress(event: LspServerEvent): void {
  const progress = ProgressParamsSchema.safeParse(event.params);
  if (!progress.success) return;

  const value = WorkDoneProgressValueSchema.safeParse(progress.data.value);
  if (!value.success) return;

  const key = progressKey(event.workspaceId, event.languageId, progress.data.token);
  const existing = workDoneProgressByKey.get(key);
  const base = {
    workspaceId: event.workspaceId,
    languageId: event.languageId,
    token: progress.data.token,
  };

  if (value.data.kind === "begin") {
    setProgressState({
      ...base,
      phase: "begin",
      done: false,
      title: value.data.title,
      message: value.data.message,
      percentage: value.data.percentage,
      cancellable: value.data.cancellable,
    });
  } else if (value.data.kind === "report") {
    // A report for work that never began, or ended, is stale.
    if (!existing) return;
    setProgressState({
      ...base,
      phase: "report",
      done: false,
      title: existing.title,
      message: value.data.message ?? existing.message,
      percentage: value.data.percentage ?? existing.percentage,
      cancellable: value.data.cancellable ?? existing.cancellable,
    });
  } else {
    // The token is finished; servers mint a new one per operation, so
    // keeping ended entries would grow the map for the whole session.
    workDoneProgressByKey.delete(key);
  }
  publishProgress(event.workspaceId, event.languageId);
}

/** Drops the work a server reported: it stopped. */
export function clearProgressFor(workspaceId: string, languageId: string): void {
  for (const [key, state] of workDoneProgressByKey) {
    if (state.workspaceId === workspaceId && state.languageId === languageId) {
      workDoneProgressByKey.delete(key);
    }
  }
}

export function routeLspServerEvent(event: LspServerEvent): void {
  const prefix = sourcePrefix(event);

  // LSP spec separates the two channels:
  //   - `window/logMessage`: debug log channel, not meant for user surfaces.
  //     Major servers (tsserver, rust-analyzer, …) emit info/log entries on
  //     every analysis cycle, which floods devtools when piped to console.
  //     Drop it here; surface it through a dedicated LSP Output panel if/when
  //     one exists.
  //   - `window/showMessage`: user-facing notification. Still routed to
  //     console for visibility until an in-app notification surface lands.
  if (event.method === "window/logMessage") {
    return;
  }

  if (event.method === "window/showMessage") {
    writeMessage(event, prefix);
    return;
  }

  if (event.method === "window/showMessageRequest") {
    writeMessageRequestStub(event.params, prefix);
    return;
  }

  if (event.method === "window/workDoneProgress/create") {
    registerWorkDoneProgressToken(event);
    return;
  }

  if (event.method === "$/progress") {
    updateWorkDoneProgress(event);
  }
}

/**
 * Drop all in-flight work-done progress entries owned by a workspace.
 * Called when a workspace is removed so its lingering LSP progress state
 * (begin/report frames that never received an "end") doesn't accumulate.
 */
function clearProgressForWorkspace(workspaceId: string): void {
  for (const [key, state] of workDoneProgressByKey) {
    if (state.workspaceId === workspaceId) {
      workDoneProgressByKey.delete(key);
    }
  }
}

export function initializeLspServerUxRouter(): void {
  if (serverEventUnlisten) return;
  serverEventUnlisten = ipcListen("lsp", "serverEvent", routeLspServerEvent);
  // Drop workspace-keyed progress entries when the workspace is removed.
  // The central registry owns the IPC listener; we just register intent.
  workspaceCleanupUnregister = registerWorkspaceCleanup(clearProgressForWorkspace);
}

export function disposeLspServerUxRouter(): void {
  serverEventUnlisten?.();
  serverEventUnlisten = null;
  workspaceCleanupUnregister?.();
  workspaceCleanupUnregister = null;
  workDoneProgressByKey.clear();
}

export function getWorkDoneProgressState(
  workspaceId: string,
  languageId: string,
  token: ProgressToken,
): WorkDoneProgressState | undefined {
  const state = workDoneProgressByKey.get(progressKey(workspaceId, languageId, token));
  return state ? { ...state } : undefined;
}
