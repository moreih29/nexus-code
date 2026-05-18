/**
 * Shared type guard for narrowing unknown values to object records.
 */

/** Narrow unknown values to object records for safe property access. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
