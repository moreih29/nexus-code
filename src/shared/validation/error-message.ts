import { z } from "zod";

const ENUM_ERROR = "Expected an enum value";

export const validationErrorOptions: z.core.ParseContext<z.core.$ZodIssue> = {
  reportInput: true,
  error: (issue) =>
    issue.code === "invalid_value" && issue.values.length === 1 && issue.inst instanceof z.ZodEnum
      ? ENUM_ERROR
      : undefined,
};

/** Keep the serialized issue format used in IPC and JSON-RPC replies. */
export function validationErrorMessage(error: z.ZodError): string {
  return JSON.stringify(
    legacyIssues(error.issues, []),
    (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

function receivedType(input: unknown): string {
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  if (Number.isNaN(input)) return "nan";
  if (input instanceof Date) return "date";
  if (input instanceof Map) return "map";
  if (input instanceof Set) return "set";
  if (input instanceof Promise) return "promise";
  return typeof input;
}

function invalidType(expected: string, input: unknown, path: PropertyKey[]) {
  const received = receivedType(input);
  const message =
    received === "undefined" ? "Required" : `Expected ${expected}, received ${received}`;
  return { code: "invalid_type", expected, received, path, message };
}

function isContinuable(issue: z.core.$ZodIssue): boolean {
  switch (issue.code) {
    case "invalid_type":
      return issue.expected === "int";
    case "invalid_value":
      return (
        (issue.values.length > 1 || issue.message === ENUM_ERROR) && typeof issue.input === "string"
      );
    case "invalid_key":
      return issue.issues.every(isContinuable);
    case "too_small":
    case "too_big":
    case "invalid_format":
    case "not_multiple_of":
    case "unrecognized_keys":
    case "custom":
      return true;
    default:
      return false;
  }
}

function legacyIssues(issues: readonly z.core.$ZodIssue[], base: PropertyKey[]): object[] {
  // Zod 3 reported array length before element errors.
  const arrayBounds = new Map<string, z.core.$ZodIssue>();
  const invalidTypes = new Set<string>();
  for (const issue of issues) {
    const key = JSON.stringify(issue.path);
    if ((issue.code === "too_small" || issue.code === "too_big") && issue.origin === "array") {
      arrayBounds.set(key, issue);
    }
    if (issue.code === "invalid_type" && issue.expected !== "int") invalidTypes.add(key);
  }

  const formatted: object[] = [];
  for (const issue of issues) {
    if (
      (issue.code === "too_small" || issue.code === "too_big") &&
      invalidTypes.has(JSON.stringify(issue.path))
    ) {
      continue;
    }
    if (arrayBounds.size > 0) {
      for (let length = 0; length <= issue.path.length; length++) {
        const key = JSON.stringify(issue.path.slice(0, length));
        const bound = arrayBounds.get(key);
        if (!bound || bound === issue || invalidTypes.has(key)) continue;
        formatted.push(...legacyIssue(bound, base));
        arrayBounds.delete(key);
      }
    }
    if (issue.code === "too_small" || issue.code === "too_big") {
      if (issue.origin === "array" && !arrayBounds.delete(JSON.stringify(issue.path))) continue;
    }
    formatted.push(...legacyIssue(issue, base));
  }
  return formatted;
}

function legacyIssue(issue: z.core.$ZodIssue, base: PropertyKey[]): object[] {
  const { code, input } = issue;
  const path = [...base, ...issue.path];
  switch (code) {
    case "invalid_type":
      if (issue.expected === "int") {
        return [
          {
            code,
            expected: "integer",
            received: "float",
            message: "Expected integer, received float",
            path,
          },
        ];
      }
      return [invalidType(issue.expected === "record" ? "object" : issue.expected, input, path)];
    case "too_small":
    case "too_big":
      return [legacyBound(issue, path)];
    case "invalid_format": {
      const validation = issue.format === "guid" ? "uuid" : issue.format;
      const message = validation === "regex" ? "Invalid" : `Invalid ${validation}`;
      if (validation === "datetime") return [{ code: "invalid_string", validation, message, path }];
      return [{ validation, code: "invalid_string", message, path }];
    }
    case "invalid_value": {
      if (issue.values.length === 1 && issue.message !== ENUM_ERROR) {
        const expected = issue.values[0];
        return [
          {
            received: input,
            code: "invalid_literal",
            expected,
            path,
            message: `Invalid literal value, expected ${JSON.stringify(expected)}`,
          },
        ];
      }
      const options = issue.values;
      const expected = options.map((option) => `'${String(option)}'`).join(" | ");
      if (typeof input !== "string") {
        const { received, code, message } = invalidType(expected, input, path);
        return [{ expected, received, code, path, message }];
      }
      return [
        {
          received: input,
          code: "invalid_enum_value",
          options,
          path,
          message: `Invalid enum value. Expected ${expected}, received '${input}'`,
        },
      ];
    }
    case "invalid_union": {
      if ("options" in issue) {
        return [
          {
            code: "invalid_union_discriminator",
            options: issue.options,
            path,
            message: issue.message,
          },
        ];
      }
      const continuable = issue.errors.find((branch) => branch.every(isContinuable));
      if (continuable) return legacyIssues(continuable, path);
      const unionErrors = issue.errors.map((branch) => ({
        issues: legacyIssues(branch, path),
        name: "ZodError",
      }));
      return [{ code, unionErrors, path, message: "Invalid input" }];
    }
    case "invalid_key":
      return legacyIssues(issue.issues, path);
    case "unrecognized_keys":
      return [
        {
          code,
          keys: issue.keys,
          path,
          message: `Unrecognized key(s) in object: ${issue.keys.map((key) => `'${key}'`).join(", ")}`,
        },
      ];
    case "custom":
      return [{ code, message: issue.message, path }];
    default:
      return [{ code, path, message: issue.message }];
  }
}

function legacyBound(
  issue: z.core.$ZodIssueTooSmall | z.core.$ZodIssueTooBig,
  path: PropertyKey[],
) {
  const { code, origin: type, inclusive = true, exact = false } = issue;
  const small = code === "too_small";
  const limit = small ? issue.minimum : issue.maximum;
  const quantity = exact ? "exactly" : small ? "at least" : "at most";
  let message = issue.message;
  if (type === "string") message = `String must contain ${quantity} ${limit} character(s)`;
  if (type === "array") message = `Array must contain ${quantity} ${limit} element(s)`;
  if (type === "number") {
    const comparison = small ? "greater" : "less";
    const relation = exact
      ? "exactly equal to"
      : `${comparison} than${inclusive ? " or equal to" : ""}`;
    message = `Number must be ${relation} ${limit}`;
  }
  return {
    code,
    ...(small ? { minimum: limit } : { maximum: limit }),
    type,
    inclusive,
    exact,
    message,
    path,
  };
}
