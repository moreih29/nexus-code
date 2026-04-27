import type { WorkspaceId } from "../../../contracts/workspace/workspace";
import type { ObserverEvent, TabBadgeEvent, ToolCallEvent } from "../../HarnessAdapter";
import {
  asRecord,
  cleanText,
  createSessionHistoryEvent,
  createTabBadgeEvent,
  createToolCallEvent,
  eventNameFromInput,
  firstBoolean,
  firstString,
  firstValue,
  nestedRecord,
  normalizeEventName,
  normalizeIdentity,
  normalizedObserverEventFromInput,
  payloadRecord,
  summarizeValue,
  type EventIdentityOptions,
  type NormalizedIdentity,
} from "../_shared/event-utils";

export const CODEX_ADAPTER_NAME = "codex";
export const CODEX_ADAPTER_VERSION = "0.1.0";

export interface CodexMapOptions {
  readonly workspaceId: WorkspaceId;
  readonly adapterName?: string;
  readonly now?: () => Date;
}

export function mapCodexInputToObserverEvents(
  input: unknown,
  options: CodexMapOptions,
): ObserverEvent[] {
  const adapterName = options.adapterName ?? CODEX_ADAPTER_NAME;
  const identityOptions: EventIdentityOptions = {
    workspaceId: options.workspaceId,
    adapterName,
    now: options.now,
  };

  const normalized = normalizedObserverEventFromInput(input, identityOptions);
  if (normalized) {
    return [normalized];
  }

  const identity = normalizeIdentity(input, {
    ...identityOptions,
    sessionKeys: ["session_id", "sessionId", "turn_id", "turnId", "conversation_id", "conversationId"],
  });
  if (!identity) {
    return [];
  }

  const events: ObserverEvent[] = [];
  const tabBadgeEvent = mapCodexTabBadgeEvent(input, identity);
  if (tabBadgeEvent) {
    events.push(tabBadgeEvent);
  }

  const toolCallEvent = mapCodexToolCallEvent(input, identity);
  if (toolCallEvent) {
    events.push(toolCallEvent);
  }

  const transcriptPath = codexString(input, ["transcript_path", "transcriptPath", "session_file", "sessionFile"]);
  const sessionHistoryEvent = transcriptPath ? createSessionHistoryEvent(identity, transcriptPath) : undefined;
  if (sessionHistoryEvent) {
    events.push(sessionHistoryEvent);
  }

  return events;
}

export function mapCodexTabBadgeEvent(input: unknown, identity: NormalizedIdentity): TabBadgeEvent | undefined {
  if (hasCodexError(input)) {
    return createTabBadgeEvent("error", identity);
  }

  switch (normalizeEventName(eventNameFromInput(input))) {
    case "sessionstart":
    case "userpromptsubmit":
    case "pretooluse":
      return createTabBadgeEvent("running", identity);
    case "permissionrequest":
      return createTabBadgeEvent("awaiting-approval", identity);
    case "stop":
      return createTabBadgeEvent("completed", identity);
    case "stopfailure":
    case "error":
    case "errored":
    case "failure":
    case "failed":
      return createTabBadgeEvent("error", identity);
    default: {
      const name = normalizeEventName(eventNameFromInput(input));
      if (name.includes("error") || name.includes("fail")) {
        return createTabBadgeEvent("error", identity);
      }
      return undefined;
    }
  }
}

export function mapCodexToolCallEvent(input: unknown, identity: NormalizedIdentity): ToolCallEvent | undefined {
  const errorMessage = codexErrorMessage(input);
  if (errorMessage) {
    return createToolCallEvent("error", identity, {
      toolName: codexToolName(input),
      toolCallId: codexToolCallId(input),
      inputSummary: codexInputSummary(input),
      resultSummary: codexResultSummary(input),
      message: errorMessage,
    });
  }

  switch (normalizeEventName(eventNameFromInput(input))) {
    case "pretooluse":
      return createToolCallEvent("started", identity, {
        toolName: codexToolName(input),
        toolCallId: codexToolCallId(input),
        inputSummary: codexInputSummary(input),
      });
    case "permissionrequest":
      return createToolCallEvent("awaiting-approval", identity, {
        toolName: codexToolName(input) ?? "Permission",
        toolCallId: codexToolCallId(input),
        inputSummary: codexInputSummary(input),
        message: codexString(input, ["message", "reason", "prompt"]),
      });
    case "posttooluse":
      return createToolCallEvent("completed", identity, {
        toolName: codexToolName(input),
        toolCallId: codexToolCallId(input),
        inputSummary: codexInputSummary(input),
        resultSummary: codexResultSummary(input),
      });
    default:
      return undefined;
  }
}

function codexToolName(input: unknown): string | undefined {
  return codexString(input, ["tool_name", "toolName", "tool", "name"]);
}

function codexToolCallId(input: unknown): string | undefined {
  return codexString(input, ["tool_use_id", "toolUseId", "tool_call_id", "toolCallId", "tool_id", "toolId", "call_id", "callId"]);
}

function codexInputSummary(input: unknown): string | undefined {
  return summarizeValue(codexValue(input, ["tool_input", "toolInput", "input", "arguments", "args"]));
}

function codexResultSummary(input: unknown): string | undefined {
  return summarizeValue(codexValue(input, ["tool_response", "toolResponse", "response", "result", "output"]));
}

function hasCodexError(input: unknown): boolean {
  return Boolean(codexErrorMessage(input));
}

function codexErrorMessage(input: unknown): string | undefined {
  const record = asRecord(input);
  const payload = payloadRecord(record?.payload);
  const toolResponse = nestedRecord(input, ["tool_response", "toolResponse", "response", "result"]);
  const records = [record, payload, toolResponse];
  const explicitMessage = firstString(records, ["errorMessage", "error_message", "message"]);
  if (firstBoolean(records, ["hasError", "has_error", "error"]) === true) {
    return explicitMessage ?? "Codex hook reported an error.";
  }

  const errorValue = firstValue(records, ["error"]);
  if (typeof errorValue === "string") {
    return cleanText(errorValue);
  }
  const errorRecord = asRecord(errorValue);
  if (errorRecord) {
    return firstString([errorRecord], ["message", "errorMessage", "error_message"]) ?? "Codex hook reported an error.";
  }

  const status = codexString(input, ["status", "state"]);
  if (status && ["error", "errored", "failed", "failure"].includes(normalizeEventName(status))) {
    return explicitMessage ?? "Codex hook reported an error.";
  }
  return undefined;
}

function codexString(input: unknown, keys: readonly string[]): string | undefined {
  const record = asRecord(input);
  const payload = payloadRecord(record?.payload);
  const detail = asRecord(record?.detail);
  const properties = asRecord(record?.properties);
  return firstString([record, payload, detail, properties], keys);
}

function codexValue(input: unknown, keys: readonly string[]): unknown {
  const record = asRecord(input);
  const payload = payloadRecord(record?.payload);
  const detail = asRecord(record?.detail);
  const properties = asRecord(record?.properties);
  return firstValue([record, payload, detail, properties], keys);
}
