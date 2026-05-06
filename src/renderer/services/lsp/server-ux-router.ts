import {
  type LspServerEvent,
  type MessageType,
  ProgressParamsSchema,
  type ProgressToken,
  ShowMessageParamsSchema,
  ShowMessageRequestParamsSchema,
  WorkDoneProgressCreateParamsSchema,
  WorkDoneProgressValueSchema,
} from "../../../shared/lsp-types";
import { ipcListen } from "../../ipc/client";

type ConsoleWriter = (message?: unknown, ...optionalParams: unknown[]) => void;

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
let serverEventUnlisten: (() => void) | null = null;

function sourcePrefix(event: LspServerEvent): string {
  return `[lsp:${event.languageId}:${event.workspaceId}]`;
}

function consoleWriterForSeverity(type: MessageType): ConsoleWriter {
  if (type === 1) return console.error;
  if (type === 2) return console.warn;
  if (type === 3) return console.info;
  return console.log;
}

function writeMessage(params: unknown, prefix: string): void {
  const parsed = ShowMessageParamsSchema.safeParse(params);
  if (!parsed.success) return;

  consoleWriterForSeverity(parsed.data.type)(`${prefix} ${parsed.data.message}`);
}

function writeMessageRequestStub(params: unknown, prefix: string): void {
  const parsed = ShowMessageRequestParamsSchema.safeParse(params);
  if (!parsed.success) return;

  consoleWriterForSeverity(parsed.data.type)(`${prefix} ${parsed.data.message}`);
}

function progressKey(workspaceId: string, languageId: string, token: ProgressToken): string {
  return JSON.stringify([workspaceId, languageId, token]);
}

function setProgressState(state: WorkDoneProgressState): void {
  workDoneProgressByKey.set(progressKey(state.workspaceId, state.languageId, state.token), state);
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
    return;
  }

  if (value.data.kind === "report") {
    setProgressState({
      ...base,
      phase: "report",
      done: false,
      title: existing?.title,
      message: value.data.message ?? existing?.message,
      percentage: value.data.percentage ?? existing?.percentage,
      cancellable: value.data.cancellable ?? existing?.cancellable,
    });
    return;
  }

  setProgressState({
    ...base,
    phase: "end",
    done: true,
    title: existing?.title,
    message: value.data.message ?? existing?.message,
    percentage: existing?.percentage,
    cancellable: existing?.cancellable,
  });
}

export function routeLspServerEvent(event: LspServerEvent): void {
  const prefix = sourcePrefix(event);

  if (event.method === "window/logMessage" || event.method === "window/showMessage") {
    writeMessage(event.params, prefix);
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

export function initializeLspServerUxRouter(): void {
  if (serverEventUnlisten) return;
  serverEventUnlisten = ipcListen("lsp", "serverEvent", routeLspServerEvent);
}

export function disposeLspServerUxRouter(): void {
  serverEventUnlisten?.();
  serverEventUnlisten = null;
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

export function getWorkDoneProgressSnapshot(): WorkDoneProgressState[] {
  return Array.from(workDoneProgressByKey.values(), (state) => ({ ...state }));
}
