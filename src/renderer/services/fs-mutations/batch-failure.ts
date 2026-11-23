import i18next from "i18next";
import { fsErrorReason } from "@/utils/file-error";
import { basename } from "@/utils/path";

export interface BatchFailure {
  name: string;
  reason: string | null;
}

export function reportedFailure(absPath: string): BatchFailure {
  return { name: basename(absPath), reason: null };
}

export function thrownFailure(absPath: string, error: unknown): BatchFailure {
  return { name: basename(absPath), reason: fsErrorReason(error) };
}

export function partialFailureMessage(
  key: string,
  success: number,
  total: number,
  failure: BatchFailure,
): string {
  return failure.reason === null
    ? i18next.t(key, { success, total, name: failure.name })
    : i18next.t(`${key}Reason`, { success, total, name: failure.name, reason: failure.reason });
}
