/**
 * How nexus settings set reads a value as typed for a setting of each type:
 * the renderer, which owns the settings, parses it with this before it
 * changes one.
 */
import type { CliSettingType, CliSettingValue } from "./ui";

/** What a setting takes. */
export interface CliSettingShape {
  readonly type: CliSettingType;
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  /** The longest "text" it takes. */
  readonly maxLength?: number;
  /** What a "text" must match, and what is said when it does not. */
  readonly pattern?: { readonly test: RegExp; readonly says: string };
}

const TRUE_WORDS = ["on", "true", "yes", "1"];
const FALSE_WORDS = ["off", "false", "no", "0"];

/** What a setting takes, as nexus settings list shows it. */
export function describeShape(shape: CliSettingShape): string {
  switch (shape.type) {
    case "boolean":
      return "on|off";
    case "choice":
      return (shape.choices ?? []).join("|");
    case "integer":
    case "number":
      return `${shape.min ?? ""}..${shape.max ?? ""}`;
    case "text":
      return "text";
  }
}

/** A value as nexus prints it: a boolean as on or off. */
export function formatSettingValue(value: CliSettingValue): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

/** `input` read as a value of `shape`, or why it is not one. */
export function parseSettingValue(
  shape: CliSettingShape,
  input: string,
): { value: CliSettingValue } | { error: string } {
  const text = input.trim();
  switch (shape.type) {
    case "boolean": {
      const word = text.toLowerCase();
      if (TRUE_WORDS.includes(word)) return { value: true };
      if (FALSE_WORDS.includes(word)) return { value: false };
      return { error: `"${input}" is not on or off` };
    }
    case "choice": {
      const choices = shape.choices ?? [];
      const found =
        choices.find((choice) => choice === text) ??
        choices.find((choice) => choice.toLowerCase() === text.toLowerCase());
      if (found !== undefined) return { value: found };
      return { error: `"${input}" is not one of ${choices.join(", ")}` };
    }
    case "integer":
    case "number": {
      const value = text === "" ? Number.NaN : Number(text);
      if (!Number.isFinite(value)) return { error: `"${input}" is not a number` };
      if (shape.type === "integer" && !Number.isInteger(value)) {
        return { error: `"${input}" is not a whole number` };
      }
      if (
        (shape.min !== undefined && value < shape.min) ||
        (shape.max !== undefined && value > shape.max)
      ) {
        return { error: `${value} is not within ${describeShape(shape)}` };
      }
      return { value };
    }
    case "text": {
      if (shape.maxLength !== undefined && input.length > shape.maxLength) {
        return { error: `it is longer than ${shape.maxLength} characters` };
      }
      if (shape.pattern && !shape.pattern.test.test(input)) return { error: shape.pattern.says };
      return { value: input };
    }
  }
}
