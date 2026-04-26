import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv/dist/types";
import addFormats from "ajv-formats";
import harnessObserverSchema from "../../../../schema/harness-observer.schema.json" with { type: "json" };

export type { HarnessObserverEvent, TabBadgeEvent, TabBadgeState } from "./generated/harness-observer";
import type { HarnessObserverEvent, TabBadgeEvent } from "./generated/harness-observer";

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
