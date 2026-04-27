import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv/dist/types";
import addFormats from "ajv-formats";
import harnessObserverSchema from "../../../../../schema/harness-observer.schema.json" with { type: "json" };

export type {
  HarnessObserverEvent,
  SessionHistoryEvent,
  TabBadgeEvent,
  TabBadgeState,
  ToolCallEvent,
  ToolCallStatus,
} from "../generated/harness-observer";
import type {
  HarnessObserverEvent,
  SessionHistoryEvent,
  TabBadgeEvent,
  ToolCallEvent,
} from "../generated/harness-observer";

const ajv = new Ajv2020({ allErrors: false });
addFormats(ajv);
const validateHarnessObserverEvent: ValidateFunction<HarnessObserverEvent> =
  ajv.compile<HarnessObserverEvent>(harnessObserverSchema);

export function isHarnessObserverEvent(value: unknown): value is HarnessObserverEvent {
  return validateHarnessObserverEvent(value);
}

export function isTabBadgeEvent(value: unknown): value is TabBadgeEvent {
  return isHarnessObserverEvent(value) && value.type === "harness/tab-badge";
}

export function isToolCallEvent(value: unknown): value is ToolCallEvent {
  return isHarnessObserverEvent(value) && value.type === "harness/tool-call";
}

export function isSessionHistoryEvent(value: unknown): value is SessionHistoryEvent {
  return isHarnessObserverEvent(value) && value.type === "harness/session-history";
}
