import {
  BUG_REPORT_ERROR_CODE_PATTERN,
  type BugReportErrorArea,
  type BugReportRecentError,
  MAX_BUG_REPORT_ERROR_AGE,
  MAX_BUG_REPORT_ERRORS,
} from "../../../../packages/remote-protocol/src";

export interface RecentError {
  readonly at: number;
  readonly area: BugReportErrorArea;
  readonly code: string;
  readonly status?: number;
}

export type RecordError = (area: BugReportErrorArea, code: string, status?: number) => void;

export class RecentErrors {
  private entries: RecentError[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly cap: number = MAX_BUG_REPORT_ERRORS,
  ) {}

  readonly record: RecordError = (area, code, status) => {
    if (!BUG_REPORT_ERROR_CODE_PATTERN.test(code)) return;
    const entry: RecentError =
      status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
        ? { at: this.now(), area, code, status }
        : { at: this.now(), area, code };
    this.entries = [...this.entries, entry].slice(-this.cap);
  };

  list(): BugReportRecentError[] {
    const now = this.now();
    return this.entries
      .map(({ at, area, code, status }) => ({
        ago: Math.max(0, Math.floor((now - at) / 1000)),
        area,
        code,
        ...(status !== undefined ? { status } : {}),
      }))
      .filter(({ ago }) => ago <= MAX_BUG_REPORT_ERROR_AGE)
      .reverse();
  }
}
