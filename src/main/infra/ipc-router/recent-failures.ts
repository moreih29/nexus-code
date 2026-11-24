import type { BugReportErrorArea } from "../../../../packages/remote-protocol/src";
import type { IpcErrResult } from "../../../shared/ipc/result";
import { bugReportErrorCode, errorMessageOf, errorNameOf } from "../../../shared/remote/bug-report";
import { appErrors, type RecordError } from "../recent-errors";

const CHANNEL_AREAS: Readonly<Record<string, BugReportErrorArea>> = {
  fs: "files",
  git: "git",
  autofetch: "git",
  notes: "notes",
  voiceMemory: "notes",
  chat: "agent",
  claude: "agent",
  cli: "agent",
  agentProfiles: "agent",
};

const CANCELLED_NAMES: ReadonlySet<string> = new Set(["AbortError", "Canceled", "CancelError"]);

function recordsItself(channel: string, method: string): boolean {
  return channel === "remote" || (channel === "system" && method === "recordError");
}

const MESSAGE_CHANNELS: ReadonlySet<string> = new Set([
  "window",
  "updates",
  "appState",
  "dialog",
  "folderBookmark",
]);

function areaOf(channel: string): BugReportErrorArea {
  return Object.hasOwn(CHANNEL_AREAS, channel) ? CHANNEL_AREAS[channel] : "app";
}

export function noteIpcResult(
  channel: string,
  method: string,
  result: IpcErrResult,
  record: RecordError = appErrors.record,
): void {
  if (recordsItself(channel, method)) return;
  if (result.category !== "failed" && result.category !== "bug") return;
  const code = bugReportErrorCode(method, result.code ?? result.kind);
  if (!code) return;
  record(
    areaOf(channel),
    code,
    undefined,
    MESSAGE_CHANNELS.has(channel) ? result.message : undefined,
  );
}

export function noteIpcThrow(
  channel: string,
  method: string,
  error: unknown,
  record: RecordError = appErrors.record,
): void {
  if (recordsItself(channel, method) || CANCELLED_NAMES.has(errorNameOf(error))) return;
  const code = bugReportErrorCode(method, errorNameOf(error));
  if (!code) return;
  record(
    areaOf(channel),
    code,
    undefined,
    MESSAGE_CHANNELS.has(channel) ? errorMessageOf(error) : undefined,
  );
}
