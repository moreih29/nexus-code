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
  readonly sessionTranscriptPath?: (
    identity: NormalizedIdentity,
    input: unknown,
  ) => string | undefined;
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

  const transcriptPath =
    openCodeString(input, ["transcriptPath", "transcript_path", "path", "sessionPath"]) ??
    (shouldEmitSessionHistoryReference(input) ? options.sessionTranscriptPath?.(identity, input) : undefined);
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
  if (isOpenCodePermissionRequestEvent(eventName)) {
    return createTabBadgeEvent("awaiting-approval", identity);
  }
  if (eventName === "permissionreplied") {
    return createTabBadgeEvent("completed", identity);
  }
  if (eventName === "sessionidle") {
    return createTabBadgeEvent("completed", identity);
  }

  if (eventName === "sessionstatus" || eventName === "sessionupdated" || eventName === "sessioncreated") {
    const status = normalizeEventName(openCodeString(input, ["status", "state", "phase", "type"]));
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
  if (isOpenCodePermissionRequestEvent(eventName)) {
    return createToolCallEvent("awaiting-approval", identity, {
      toolName: openCodeToolName(input) ?? "Permission",
      toolCallId: openCodeToolCallId(input),
      inputSummary: openCodeInputSummary(input),
      message: openCodeString(input, ["message", "reason", "title", "type"]),
    });
  }
  if (eventName === "permissionreplied") {
    return createToolCallEvent("completed", identity, {
      toolName: "Permission",
      toolCallId: openCodeToolCallId(input),
      message: openCodeString(input, ["response", "message", "reason", "title"]),
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
  const records = openCodeRecords(input);

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
    "id",
  ]);
  if (!sessionId) {
    return undefined;
  }

  return {
    workspaceId: options.workspaceId,
    adapterName,
    sessionId,
    timestamp: coerceTimestamp(openCodeTimestampValue(records), options.now),
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
  return firstRecord(openCodeRecords(input, { includePart: false }), ["part", "messagePart", "message_part", "tool"]);
}

function openCodeToolName(input: unknown): string | undefined {
  return openCodeString(input, ["toolName", "tool_name", "tool", "name", "type", "title"]);
}

function openCodeToolCallId(input: unknown): string | undefined {
  return openCodeString(input, ["toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "callId", "callID", "call_id", "permissionID", "permissionId", "id"]);
}

function openCodeInputSummary(input: unknown): string | undefined {
  return summarizeValue(openCodeValue(input, ["input", "args", "arguments", "params", "tool_input", "toolInput", "pattern"]));
}

function openCodeResultSummary(input: unknown): string | undefined {
  return summarizeValue(openCodeValue(input, ["result", "output", "response", "tool_response", "toolResponse"]));
}

function openCodeString(input: unknown, keys: readonly string[]): string | undefined {
  return firstString(openCodeDetailRecords(input), keys);
}

function openCodeValue(input: unknown, keys: readonly string[]): unknown {
  return firstValue(openCodeDetailRecords(input), keys);
}

function openCodeRecords(
  input: unknown,
  options: { includePart?: boolean } = {},
): Array<Record<string, unknown> | undefined> {
  const record = asRecord(input);
  const payload = payloadRecord(record?.payload);
  const data = payloadRecord(record?.data) ?? asRecord(record?.data);
  const detail = asRecord(record?.detail);
  const properties = asRecord(record?.properties);
  const payloadProperties = asRecord(payload?.properties);
  const dataProperties = asRecord(data?.properties);
  const detailProperties = asRecord(detail?.properties);
  const info = firstRecord(
    [record, payload, data, detail, properties, payloadProperties, dataProperties, detailProperties],
    ["info", "session"],
  );
  const part = options.includePart === false
    ? undefined
    : firstRecord(
      [record, payload, data, detail, properties, payloadProperties, dataProperties, detailProperties],
      ["part", "messagePart", "message_part", "tool"],
    );
  const state = firstRecord([part], ["state"]) ??
    firstRecord([record, payload, data, detail, properties, payloadProperties, dataProperties, detailProperties, part], ["status", "state"]);
  const time = firstRecord([record, payload, data, detail, properties, payloadProperties, dataProperties, detailProperties, info, part, state], ["time"]);

  return [
    record,
    payload,
    data,
    detail,
    properties,
    payloadProperties,
    dataProperties,
    detailProperties,
    info,
    part,
    state,
    time,
  ];
}

function openCodeDetailRecords(input: unknown): Array<Record<string, unknown> | undefined> {
  const records = openCodeRecords(input);
  const [record, payload, data, detail, properties, payloadProperties, dataProperties, detailProperties, info, part, state, time] = records;
  return [
    part,
    state,
    properties,
    payloadProperties,
    dataProperties,
    detailProperties,
    payload,
    data,
    detail,
    record,
    info,
    time,
  ];
}

function openCodeTimestampValue(records: Array<Record<string, unknown> | undefined>): unknown {
  const direct = firstValue(records, [
    "timestamp",
    "createdAt",
    "created_at",
    "updatedAt",
    "updated_at",
  ]);
  if (direct !== undefined) {
    return direct;
  }

  const rawTime = firstValue(records, ["time"]);
  if (typeof rawTime === "number" || typeof rawTime === "string" || rawTime instanceof Date) {
    return rawTime;
  }

  const time = asRecord(rawTime);
  return firstValue([time, ...records], ["created", "updated", "start", "end", "completed"]);
}

function isOpenCodePermissionRequestEvent(eventName: string): boolean {
  return eventName === "permissionupdated" || eventName === "permissionrequested" || eventName === "permissionasked";
}

function shouldEmitSessionHistoryReference(input: unknown): boolean {
  const eventName = normalizeEventName(eventNameFromInput(input));
  return eventName === "sessioncreated" ||
    eventName === "sessionupdated" ||
    eventName === "sessionstatus" ||
    eventName === "sessionidle" ||
    eventName === "sessionerror" ||
    eventName === "messageupdated" ||
    eventName === "messagepartupdated" ||
    eventName === "permissionupdated" ||
    eventName === "permissionrequested" ||
    eventName === "permissionasked" ||
    eventName === "permissionreplied";
}
