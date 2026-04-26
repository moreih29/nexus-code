import type { WorkspaceId } from "../../../contracts/workspace";
import type { ObserverEvent, TabBadgeEvent, ToolCallEvent, ToolCallStatus } from "../../HarnessAdapter";
import {
  asRecord,
  cleanText,
  coerceTimestamp,
  createSessionHistoryEvent,
  createTabBadgeEvent,
  createToolCallEvent,
  eventNameFromInput,
  firstRecord,
  firstString,
  firstValue,
  normalizeEventName,
  normalizedObserverEventFromInput,
  payloadRecord,
  summarizeValue,
  type EventIdentityOptions,
  type NormalizedIdentity,
} from "../_shared/event-utils";

export const OPENCODE_ADAPTER_NAME = "opencode";
export const OPENCODE_ADAPTER_VERSION = "0.1.0";

export interface OpenCodeMapOptions {
  readonly workspaceId: WorkspaceId;
  readonly adapterName?: string;
  readonly now?: () => Date;
}

export function mapOpenCodeInputToObserverEvents(
  input: unknown,
  options: OpenCodeMapOptions,
): ObserverEvent[] {
  const adapterName = options.adapterName ?? OPENCODE_ADAPTER_NAME;
  const identityOptions: EventIdentityOptions = {
    workspaceId: options.workspaceId,
    adapterName,
    now: options.now,
  };

  const normalized = normalizedObserverEventFromInput(input, identityOptions);
  if (normalized) {
    return [normalized];
  }

  const identity = normalizeOpenCodeIdentity(input, identityOptions);
  if (!identity) {
    return [];
  }

  const events: ObserverEvent[] = [];
  const tabBadgeEvent = mapOpenCodeTabBadgeEvent(input, identity);
  if (tabBadgeEvent) {
    events.push(tabBadgeEvent);
  }

  const toolCallEvent = mapOpenCodeToolCallEvent(input, identity);
  if (toolCallEvent) {
    events.push(toolCallEvent);
  }

  const transcriptPath = openCodeString(input, ["transcriptPath", "transcript_path", "path", "sessionPath"]);
  const sessionHistoryEvent = transcriptPath ? createSessionHistoryEvent(identity, transcriptPath) : undefined;
  if (sessionHistoryEvent) {
    events.push(sessionHistoryEvent);
  }

  return events;
}

export function mapOpenCodeTabBadgeEvent(input: unknown, identity: NormalizedIdentity): TabBadgeEvent | undefined {
  const eventName = normalizeEventName(eventNameFromInput(input));
  if (eventName === "sessionerror" || eventName.includes("error")) {
    return createTabBadgeEvent("error", identity);
  }
  if (eventName === "permissionupdated" || eventName === "permissionrequested") {
    return createTabBadgeEvent("awaiting-approval", identity);
  }
  if (eventName === "sessionidle") {
    return createTabBadgeEvent("completed", identity);
  }

  if (eventName === "sessionstatus" || eventName === "sessionupdated" || eventName === "sessioncreated") {
    const status = normalizeEventName(openCodeString(input, ["status", "state", "phase"]));
    switch (status) {
      case "busy":
      case "running":
      case "working":
      case "processing":
        return createTabBadgeEvent("running", identity);
      case "idle":
      case "completed":
      case "complete":
      case "done":
        return createTabBadgeEvent("completed", identity);
      case "error":
      case "errored":
      case "failed":
      case "failure":
        return createTabBadgeEvent("error", identity);
      default:
        return undefined;
    }
  }

  const toolStatus = openCodeToolStatus(input);
  if (toolStatus === "error") {
    return createTabBadgeEvent("error", identity);
  }
  if (toolStatus === "started") {
    return createTabBadgeEvent("running", identity);
  }
  return undefined;
}

export function mapOpenCodeToolCallEvent(input: unknown, identity: NormalizedIdentity): ToolCallEvent | undefined {
  const eventName = normalizeEventName(eventNameFromInput(input));
  if (eventName === "permissionupdated" || eventName === "permissionrequested") {
    return createToolCallEvent("awaiting-approval", identity, {
      toolName: openCodeToolName(input) ?? "Permission",
      toolCallId: openCodeToolCallId(input),
      inputSummary: openCodeInputSummary(input),
      message: openCodeString(input, ["message", "reason", "title"]),
    });
  }

  const status = openCodeToolStatus(input);
  if (!status) {
    return undefined;
  }

  return createToolCallEvent(status, identity, {
    toolName: openCodeToolName(input),
    toolCallId: openCodeToolCallId(input),
    inputSummary: openCodeInputSummary(input),
    resultSummary: openCodeResultSummary(input),
    message: openCodeString(input, ["message", "error", "text"]),
  });
}

function normalizeOpenCodeIdentity(
  input: unknown,
  options: EventIdentityOptions,
): NormalizedIdentity | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  const payload = payloadRecord(record.payload);
  const data = payloadRecord(record.data) ?? asRecord(record.data);
  const detail = asRecord(record.detail);
  const properties = asRecord(record.properties);
  const session = firstRecord([record, payload, data, detail, properties], ["session"]);
  const part = firstRecord([record, payload, data, detail, properties], ["part"]);
  const records = [record, payload, data, detail, properties, session, part];

  const inputWorkspaceId = firstString(records, ["workspaceId", "workspace_id", "projectId", "project_id"]);
  if (inputWorkspaceId && inputWorkspaceId !== options.workspaceId) {
    return undefined;
  }

  const adapterName = firstString(records, ["adapterName", "adapter_name", "adapter"]) ?? options.adapterName;
  if (adapterName !== options.adapterName) {
    return undefined;
  }

  const sessionId = firstString(records, [
    "sessionId",
    "sessionID",
    "session_id",
    "session",
    "session_id",
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
      firstValue(records, ["timestamp", "time", "created", "createdAt", "created_at", "updated", "updatedAt", "updated_at"]),
      options.now,
    ),
  };
}

function openCodeToolStatus(input: unknown): ToolCallStatus | undefined {
  const eventName = normalizeEventName(eventNameFromInput(input));
  if (eventName !== "messagepartupdated" && !eventName.includes("tool")) {
    return undefined;
  }

  const part = openCodePart(input);
  if (part) {
    const partType = normalizeEventName(firstString([part], ["type", "kind"]));
    if (partType && !partType.includes("tool")) {
      return undefined;
    }
  }

  const status = normalizeEventName(openCodeString(input, ["status", "state", "phase"]));
  switch (status) {
    case "pending":
    case "running":
    case "started":
    case "loading":
      return "started";
    case "complete":
    case "completed":
    case "done":
    case "success":
      return "completed";
    case "error":
    case "errored":
    case "failed":
    case "failure":
      return "error";
    default:
      return undefined;
  }
}

function openCodePart(input: unknown): Record<string, unknown> | undefined {
  const record = asRecord(input);
  const payload = payloadRecord(record?.payload);
  const data = payloadRecord(record?.data) ?? asRecord(record?.data);
  const detail = asRecord(record?.detail);
  const properties = asRecord(record?.properties);
  return firstRecord([record, payload, data, detail, properties], ["part", "messagePart", "message_part", "tool"]);
}

function openCodeToolName(input: unknown): string | undefined {
  return openCodeString(input, ["toolName", "tool_name", "tool", "name", "title"]);
}

function openCodeToolCallId(input: unknown): string | undefined {
  return openCodeString(input, ["toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "callId", "call_id", "id"]);
}

function openCodeInputSummary(input: unknown): string | undefined {
  return summarizeValue(openCodeValue(input, ["input", "args", "arguments", "params", "tool_input", "toolInput"]));
}

function openCodeResultSummary(input: unknown): string | undefined {
  return summarizeValue(openCodeValue(input, ["result", "output", "response", "tool_response", "toolResponse"]));
}

function openCodeString(input: unknown, keys: readonly string[]): string | undefined {
  const record = asRecord(input);
  const payload = payloadRecord(record?.payload);
  const data = payloadRecord(record?.data) ?? asRecord(record?.data);
  const detail = asRecord(record?.detail);
  const properties = asRecord(record?.properties);
  const session = firstRecord([record, payload, data, detail, properties], ["session"]);
  const part = openCodePart(input);
  const state = firstRecord([record, payload, data, detail, properties, part], ["state"]);
  return firstString([record, payload, data, detail, properties, part, state, session], keys);
}

function openCodeValue(input: unknown, keys: readonly string[]): unknown {
  const record = asRecord(input);
  const payload = payloadRecord(record?.payload);
  const data = payloadRecord(record?.data) ?? asRecord(record?.data);
  const detail = asRecord(record?.detail);
  const properties = asRecord(record?.properties);
  const part = openCodePart(input);
  const state = firstRecord([record, payload, data, detail, properties, part], ["state"]);
  return firstValue([record, payload, data, detail, properties, part, state], keys);
}
