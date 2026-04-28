import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv/dist/types";
import addFormats from "ajv-formats";
import lspLifecycleSchema from "../../../../../schema/lsp-lifecycle.schema.json" with { type: "json" };
import lspRelaySchema from "../../../../../schema/lsp-relay.schema.json" with { type: "json" };

export type {
  ExpectedCloseCodes,
  LspHealthCheckCommand,
  LspLifecycleMessage,
  LspRestartServerCommand,
  LspServerHealthReply,
  LspServerStartedReply,
  LspServerStartFailedReply,
  LspServerState,
  LspServerStoppedEvent,
  LspServerStopReason,
  LspStartServerCommand,
  LspStopAllServersCommand,
  LspStopAllServersReply,
  LspStopServerCommand,
  WebSocketCloseCode,
} from "../generated/lsp-lifecycle";
export type {
  LspClientPayloadMessage,
  LspRelayMessage,
  LspServerPayloadMessage,
} from "../generated/lsp-relay";
import type {
  LspLifecycleMessage,
  LspServerHealthReply,
  LspServerStartedReply,
  LspServerStartFailedReply,
  LspServerStoppedEvent,
  LspStopAllServersReply,
} from "../generated/lsp-lifecycle";
import type {
  LspRelayMessage,
  LspServerPayloadMessage,
} from "../generated/lsp-relay";

const ajv = new Ajv2020({ allErrors: false });
addFormats(ajv);
const validateLspLifecycleMessage: ValidateFunction<LspLifecycleMessage> =
  ajv.compile<LspLifecycleMessage>(lspLifecycleSchema);
const validateLspRelayMessage: ValidateFunction<LspRelayMessage> =
  ajv.compile<LspRelayMessage>(lspRelaySchema);

export type LspLifecycleReply =
  | LspServerStartedReply
  | LspServerStartFailedReply
  | LspServerStoppedEvent
  | LspServerHealthReply
  | LspStopAllServersReply;

const LSP_LIFECYCLE_REPLY_ACTIONS = new Set([
  "server_started",
  "server_start_failed",
  "server_stopped",
  "server_health",
  "stop_all_stopped",
]);

export function isLspLifecycleMessage(value: unknown): value is LspLifecycleMessage {
  return validateLspLifecycleMessage(value);
}

export function isLspLifecycleReply(value: unknown): value is LspLifecycleReply {
  return (
    isLspLifecycleMessage(value) &&
    LSP_LIFECYCLE_REPLY_ACTIONS.has(value.action) &&
    "requestId" in value &&
    typeof value.requestId === "string"
  );
}

export function isLspServerStoppedEvent(value: unknown): value is LspServerStoppedEvent {
  return isLspLifecycleMessage(value) && value.action === "server_stopped";
}

export function isLspRelayMessage(value: unknown): value is LspRelayMessage {
  return validateLspRelayMessage(value);
}

export function isLspServerPayloadMessage(value: unknown): value is LspServerPayloadMessage {
  return isLspRelayMessage(value) && value.direction === "server_to_client";
}
