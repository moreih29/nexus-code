import type { WorkspaceId } from "../../../contracts/workspace/workspace";
import type { TabBadgeEvent, TabBadgeState } from "../../HarnessAdapter";

export const CLAUDE_CODE_ADAPTER_NAME = "claude-code";
export const CLAUDE_CODE_ADAPTER_VERSION = "0.1.0";

export interface ClaudeCodeHookLikeEvent {
  readonly type?: string;
  readonly workspaceId?: WorkspaceId | string;
  readonly workspace_id?: string;
  readonly event?: string;
  readonly eventName?: string;
  readonly hookName?: string;
  readonly hook_event_name?: string;
  readonly hookEventName?: string;
  readonly name?: string;
  readonly payload?: unknown;
  readonly sessionId?: string;
  readonly session_id?: string;
  readonly adapterName?: string;
  readonly adapter_name?: string;
  readonly adapter?: string;
  readonly timestamp?: string | number | Date;
  readonly notification_type?: string;
  readonly notificationType?: string;
  readonly hasError?: boolean;
  readonly has_error?: boolean;
  readonly errorMessage?: string;
  readonly error_message?: string;
  readonly error?: unknown;
}

export interface NormalizedClaudeCodeHookEvent {
  readonly eventName: string;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: string;
  readonly adapterName: string;
  readonly timestamp: string;
  readonly notificationType?: string;
  readonly hasError: boolean;
  readonly errorMessage?: string;
  readonly raw: unknown;
}

export interface ClaudeCodeMapOptions {
  readonly workspaceId: WorkspaceId;
  readonly adapterName?: string;
  readonly now?: () => Date;
}

export function mapClaudeCodeHookEventToTabBadgeEvent(
  input: unknown,
  options: ClaudeCodeMapOptions,
): TabBadgeEvent | undefined {
  const normalized = normalizeClaudeCodeHookEvent(input, options);
  if (!normalized) {
    return undefined;
  }
  return mapNormalizedClaudeCodeHookEventToTabBadgeEvent(normalized);
}

export function mapNormalizedClaudeCodeHookEventToTabBadgeEvent(
  event: NormalizedClaudeCodeHookEvent,
): TabBadgeEvent | undefined {
  const state = tabBadgeStateForClaudeCodeHook(event);
  if (!state) {
    return undefined;
  }

  return {
    type: "harness/tab-badge",
    state,
    sessionId: event.sessionId,
    adapterName: event.adapterName,
    workspaceId: event.workspaceId,
    timestamp: event.timestamp,
  };
}

export function normalizeClaudeCodeHookEvent(
  input: unknown,
  options: ClaudeCodeMapOptions,
): NormalizedClaudeCodeHookEvent | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }

  const payload = payloadRecord(record.payload);
  const inputWorkspaceId = firstString([record, payload], ["workspaceId", "workspace_id"]);
  if (inputWorkspaceId && inputWorkspaceId !== options.workspaceId) {
    return undefined;
  }

  const eventName = firstString([record, payload], [
    "event",
    "eventName",
    "hookName",
    "hook_event_name",
    "hookEventName",
    "name",
  ]);
  const sessionId = firstString([record, payload], ["sessionId", "session_id"]);
  if (!eventName || !sessionId) {
    return undefined;
  }

  const adapterName =
    firstString([record, payload], ["adapterName", "adapter_name", "adapter"]) ??
    options.adapterName ??
    CLAUDE_CODE_ADAPTER_NAME;
  const notificationType = firstString([record, payload], ["notification_type", "notificationType"]);
  const errorMessage = firstString([record, payload], ["errorMessage", "error_message"]);

  return {
    eventName,
    workspaceId: options.workspaceId,
    sessionId,
    adapterName,
    timestamp: coerceTimestamp(firstValue([record, payload], ["timestamp"]), options.now),
    notificationType,
    hasError:
      firstBoolean([record, payload], ["hasError", "has_error"]) === true ||
      Boolean(errorMessage) ||
      hasTruthyError(firstValue([record, payload], ["error"])),
    errorMessage,
    raw: input,
  };
}

export function tabBadgeStateForClaudeCodeHook(
  event: Pick<NormalizedClaudeCodeHookEvent, "eventName" | "notificationType" | "hasError" | "errorMessage">,
): TabBadgeState | undefined {
  if (event.hasError || hasText(event.errorMessage)) {
    return "error";
  }

  switch (normalizedHookName(event.eventName)) {
    case "pretooluse":
      return "running";
    case "posttooluse":
      return undefined;
    case "notification":
      return event.notificationType?.trim() === "permission_prompt" ? "awaiting-approval" : undefined;
    case "stop":
      return "completed";
    case "stopfailure":
    case "error":
    case "errored":
    case "failure":
    case "failed":
    case "exception":
    case "hookerror":
    case "toolerror":
      return "error";
    default: {
      const hookName = normalizedHookName(event.eventName);
      if (hookName.includes("error") || hookName.includes("fail")) {
        return "error";
      }
      return undefined;
    }
  }
}

export function normalizedHookName(name: string): string {
  return name.toLowerCase().trim().replaceAll(/[_\-\s./]/g, "");
}

function coerceTimestamp(value: unknown, now: (() => Date) | undefined): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && !Number.isNaN(Date.parse(trimmed))) {
      return trimmed;
    }
  }
  return (now?.() ?? new Date()).toISOString();
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload === "string") {
    try {
      return asRecord(JSON.parse(payload));
    } catch {
      return undefined;
    }
  }
  return asRecord(payload);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function firstString(records: Array<Record<string, unknown> | undefined>, keys: string[]): string | undefined {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed !== "") {
        return trimmed;
      }
    }
  }
  return undefined;
}

function firstBoolean(records: Array<Record<string, unknown> | undefined>, keys: string[]): boolean | undefined {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "boolean") {
        return value;
      }
    }
  }
  return undefined;
}

function firstValue(records: Array<Record<string, unknown> | undefined>, keys: string[]): unknown {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of keys) {
      if (key in record) {
        return record[key];
      }
    }
  }
  return undefined;
}

function hasTruthyError(value: unknown): boolean {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  return true;
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}
