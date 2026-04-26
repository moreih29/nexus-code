import type { WorkspaceId } from "../../../contracts/workspace";
import type {
  ObserverEvent,
  SessionHistoryEvent,
  TabBadgeEvent,
  TabBadgeState,
  ToolCallEvent,
  ToolCallStatus,
} from "../../HarnessAdapter";

export type EventStreamFactory = (
  workspaceId: WorkspaceId,
  signal: AbortSignal,
) => AsyncIterable<unknown>;

export type EventStreamSource = AsyncIterable<unknown> | EventStreamFactory;

export interface EventIdentityOptions {
  readonly workspaceId: WorkspaceId;
  readonly adapterName: string;
  readonly now?: () => Date;
}

export function resolveEventStream(
  eventStream: EventStreamSource,
  workspaceId: WorkspaceId,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  if (typeof eventStream === "function") {
    return eventStream(workspaceId, signal);
  }
  return eventStream;
}

export function normalizedObserverEventFromInput(
  input: unknown,
  options: Pick<EventIdentityOptions, "workspaceId" | "adapterName">,
): ObserverEvent | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }

  switch (record.type) {
    case "harness/tab-badge":
      return tabBadgeEventFromRecord(record, options);
    case "harness/tool-call":
      return toolCallEventFromRecord(record, options);
    case "harness/session-history":
      return sessionHistoryEventFromRecord(record, options);
    default:
      return undefined;
  }
}

export function createTabBadgeEvent(
  state: TabBadgeState,
  identity: NormalizedIdentity,
): TabBadgeEvent {
  return {
    type: "harness/tab-badge",
    state,
    sessionId: identity.sessionId,
    adapterName: identity.adapterName,
    workspaceId: identity.workspaceId,
    timestamp: identity.timestamp,
  };
}

export function createToolCallEvent(
  status: ToolCallStatus,
  identity: NormalizedIdentity,
  options: {
    readonly toolName?: string;
    readonly toolCallId?: string;
    readonly inputSummary?: string;
    readonly resultSummary?: string;
    readonly message?: string;
  } = {},
): ToolCallEvent {
  const event: ToolCallEvent = {
    type: "harness/tool-call",
    status,
    toolName: cleanText(options.toolName) ?? fallbackToolName(status),
    sessionId: identity.sessionId,
    adapterName: identity.adapterName,
    workspaceId: identity.workspaceId,
    timestamp: identity.timestamp,
  };
  const toolCallId = cleanText(options.toolCallId);
  const inputSummary = cleanText(options.inputSummary);
  const resultSummary = cleanText(options.resultSummary);
  const message = cleanText(options.message);
  if (toolCallId) {
    event.toolCallId = toolCallId;
  }
  if (inputSummary) {
    event.inputSummary = inputSummary;
  }
  if (resultSummary) {
    event.resultSummary = resultSummary;
  }
  if (message) {
    event.message = message;
  }
  return event;
}

export function createSessionHistoryEvent(
  identity: NormalizedIdentity,
  transcriptPath: string,
): SessionHistoryEvent | undefined {
  const cleanedTranscriptPath = cleanText(transcriptPath);
  if (!cleanedTranscriptPath) {
    return undefined;
  }

  return {
    type: "harness/session-history",
    sessionId: identity.sessionId,
    adapterName: identity.adapterName,
    workspaceId: identity.workspaceId,
    timestamp: identity.timestamp,
    transcriptPath: cleanedTranscriptPath,
  };
}

export interface NormalizedIdentity {
  readonly workspaceId: WorkspaceId;
  readonly adapterName: string;
  readonly sessionId: string;
  readonly timestamp: string;
}

export function normalizeIdentity(
  input: unknown,
  options: EventIdentityOptions & {
    readonly sessionKeys?: readonly string[];
    readonly timestampKeys?: readonly string[];
  },
): NormalizedIdentity | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  const payload = payloadRecord(record.payload);
  const detail = asRecord(record.detail);
  const properties = asRecord(record.properties);
  const records = [record, payload, detail, properties];

  const inputWorkspaceId = firstString(records, ["workspaceId", "workspace_id"]);
  if (inputWorkspaceId && inputWorkspaceId !== options.workspaceId) {
    return undefined;
  }

  const adapterName =
    firstString(records, ["adapterName", "adapter_name", "adapter"]) ?? options.adapterName;
  if (adapterName !== options.adapterName) {
    return undefined;
  }

  const sessionId = firstString(records, [
    ...(options.sessionKeys ?? []),
    "sessionId",
    "session_id",
    "sessionID",
    "session",
    "turnId",
    "turn_id",
    "id",
  ]);
  if (!sessionId) {
    return undefined;
  }

  return {
    workspaceId: options.workspaceId,
    adapterName,
    sessionId,
    timestamp: coerceTimestamp(
      firstValue(records, [
        ...(options.timestampKeys ?? []),
        "timestamp",
        "time",
        "createdAt",
        "created_at",
        "updatedAt",
        "updated_at",
      ]),
      options.now,
    ),
  };
}

export function eventNameFromInput(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  const payload = payloadRecord(record.payload);
  const detail = asRecord(record.detail);
  const properties = asRecord(record.properties);
  return firstString([record, payload, detail, properties], [
    "event",
    "eventName",
    "hookName",
    "hook_event_name",
    "hookEventName",
    "name",
    "type",
  ]);
}

export function nestedRecord(input: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  const payload = payloadRecord(record.payload);
  const detail = asRecord(record.detail);
  const properties = asRecord(record.properties);
  return firstRecord([record, payload, detail, properties], keys);
}

export function firstString(
  records: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): string | undefined {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed !== "") {
          return trimmed;
        }
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
    }
  }
  return undefined;
}

export function firstBoolean(
  records: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): boolean | undefined {
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

export function firstValue(
  records: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): unknown {
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

export function firstRecord(
  records: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  const value = firstValue(records, keys);
  return asRecord(value);
}

export function firstArray(
  records: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): unknown[] | undefined {
  const value = firstValue(records, keys);
  return Array.isArray(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload === "string") {
    try {
      return asRecord(JSON.parse(payload));
    } catch {
      return undefined;
    }
  }
  return asRecord(payload);
}

export function normalizeEventName(name: string | undefined): string {
  return (name ?? "").toLowerCase().trim().replaceAll(/[_\-\s./:]/g, "");
}

export function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function summarizeValue(value: unknown, maxRunes = 160): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return truncateRunes(value.trim(), maxRunes);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.length} items]`;
  }
  const record = asRecord(value);
  if (record) {
    const preferredKeys = [
      "file_path",
      "path",
      "command",
      "description",
      "pattern",
      "query",
      "url",
      "old_string",
      "new_string",
      "state",
      "status",
      "text",
    ];
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const key of preferredKeys) {
      if (!(key in record)) {
        continue;
      }
      parts.push(`${key}: ${summarizeScalar(key, record[key])}`);
      seen.add(key);
      if (parts.length >= 4) {
        return truncateRunes(parts.join(", "), maxRunes);
      }
    }
    for (const key of Object.keys(record).sort()) {
      if (seen.has(key)) {
        continue;
      }
      parts.push(`${key}: ${summarizeScalar(key, record[key])}`);
      if (parts.length >= 4) {
        break;
      }
    }
    return truncateRunes(parts.join(", "), maxRunes);
  }

  try {
    return truncateRunes(JSON.stringify(value), maxRunes);
  } catch {
    return truncateRunes(String(value), maxRunes);
  }
}

export function coerceTimestamp(value: unknown, now?: () => Date): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const epochMs = value > 0 && value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(epochMs);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "") {
      if (!Number.isNaN(Date.parse(trimmed))) {
        return trimmed;
      }
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        return coerceTimestamp(numeric, now);
      }
    }
  }
  return (now?.() ?? new Date()).toISOString();
}

function tabBadgeEventFromRecord(
  record: Record<string, unknown>,
  options: Pick<EventIdentityOptions, "workspaceId" | "adapterName">,
): TabBadgeEvent | undefined {
  if (
    record.workspaceId !== options.workspaceId ||
    record.adapterName !== options.adapterName ||
    !isTabBadgeState(record.state) ||
    typeof record.sessionId !== "string" ||
    record.sessionId.trim() === "" ||
    typeof record.timestamp !== "string" ||
    record.timestamp.trim() === ""
  ) {
    return undefined;
  }

  return {
    type: "harness/tab-badge",
    state: record.state,
    sessionId: record.sessionId.trim(),
    adapterName: options.adapterName,
    workspaceId: options.workspaceId,
    timestamp: record.timestamp.trim(),
  };
}

function toolCallEventFromRecord(
  record: Record<string, unknown>,
  options: Pick<EventIdentityOptions, "workspaceId" | "adapterName">,
): ToolCallEvent | undefined {
  if (
    record.workspaceId !== options.workspaceId ||
    record.adapterName !== options.adapterName ||
    !isToolCallStatus(record.status) ||
    typeof record.sessionId !== "string" ||
    record.sessionId.trim() === "" ||
    typeof record.toolName !== "string" ||
    record.toolName.trim() === "" ||
    typeof record.timestamp !== "string" ||
    record.timestamp.trim() === ""
  ) {
    return undefined;
  }

  const event: ToolCallEvent = {
    type: "harness/tool-call",
    status: record.status,
    toolName: record.toolName.trim(),
    sessionId: record.sessionId.trim(),
    adapterName: options.adapterName,
    workspaceId: options.workspaceId,
    timestamp: record.timestamp.trim(),
  };
  const toolCallId = cleanText(record.toolCallId);
  const inputSummary = cleanText(record.inputSummary);
  const resultSummary = cleanText(record.resultSummary);
  const message = cleanText(record.message);
  if (toolCallId) {
    event.toolCallId = toolCallId;
  }
  if (inputSummary) {
    event.inputSummary = inputSummary;
  }
  if (resultSummary) {
    event.resultSummary = resultSummary;
  }
  if (message) {
    event.message = message;
  }
  return event;
}

function sessionHistoryEventFromRecord(
  record: Record<string, unknown>,
  options: Pick<EventIdentityOptions, "workspaceId" | "adapterName">,
): SessionHistoryEvent | undefined {
  if (
    record.workspaceId !== options.workspaceId ||
    record.adapterName !== options.adapterName ||
    typeof record.sessionId !== "string" ||
    record.sessionId.trim() === "" ||
    typeof record.timestamp !== "string" ||
    record.timestamp.trim() === "" ||
    typeof record.transcriptPath !== "string" ||
    record.transcriptPath.trim() === ""
  ) {
    return undefined;
  }

  return {
    type: "harness/session-history",
    sessionId: record.sessionId.trim(),
    adapterName: options.adapterName,
    workspaceId: options.workspaceId,
    timestamp: record.timestamp.trim(),
    transcriptPath: record.transcriptPath.trim(),
  };
}

function isTabBadgeState(value: unknown): value is TabBadgeState {
  return value === "running" || value === "awaiting-approval" || value === "completed" || value === "error";
}

function isToolCallStatus(value: unknown): value is ToolCallStatus {
  return value === "started" || value === "completed" || value === "awaiting-approval" || value === "error";
}

function fallbackToolName(status: ToolCallStatus): string {
  return status === "awaiting-approval" ? "Permission" : "Tool";
}

function summarizeScalar(key: string, value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isLargeTextKey(key) && trimmed !== "") {
      return `<${[...trimmed].length} chars>`;
    }
    return truncateRunes(trimmed, 80);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (asRecord(value)) {
    return "{...}";
  }
  return truncateRunes(String(value), 80);
}

function isLargeTextKey(key: string): boolean {
  switch (normalizeEventName(key)) {
    case "content":
    case "text":
    case "prompt":
    case "oldstring":
    case "newstring":
      return true;
    default:
      return false;
  }
}

function truncateRunes(value: string, maxRunes: number): string {
  const runes = [...value];
  if (runes.length <= maxRunes) {
    return value;
  }
  return `${runes.slice(0, Math.max(0, maxRunes - 1)).join("")}…`;
}
