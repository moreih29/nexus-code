import { z } from "zod";

// Keep the numeric domain of the 0.19.0 wire schemas. Zod 4's built-in
// number and integer schemas reject infinities and unsafe integers.
export const NumberSchema = z.custom<number>().check(({ value, issues }) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    issues.push({ code: "invalid_type", expected: "number", input: value });
  }
});

export const IntegerSchema = NumberSchema.check(({ value, issues }) => {
  if (!Number.isInteger(value)) {
    issues.push({ code: "invalid_type", expected: "int", input: value, continue: true });
  }
});

export const PositiveIntegerSchema = IntegerSchema.check(z.gt(0));
export const NonnegativeIntegerSchema = IntegerSchema.check(z.gte(0));
export const NonnegativeNumberSchema = NumberSchema.check(z.gte(0));

/** Zod 3 validated an own __proto__ entry before dropping it from a record. */
export function wireRecord<Key extends z.ZodType<string>, Value extends z.ZodType>(
  key: Key,
  value: Value,
) {
  const record = z.record(key, value);
  return z
    .custom<z.input<typeof record>>()
    .check(({ value: input, issues }) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return;
      const entry = Object.getOwnPropertyDescriptor(input, "__proto__");
      if (!entry) return;
      const result = value.safeParse(entry.value, { reportInput: true });
      if (result.success) return;
      for (const issue of result.error.issues) {
        issues.push({
          ...issue,
          input: issue.input,
          path: ["__proto__", ...issue.path],
        } as z.core.$ZodRawIssue);
      }
    })
    .pipe(record);
}
