import {
  BUG_REPORT_ERROR_CODE_PATTERN,
  type BugReportErrorArea,
  type BugReportRecentError,
  cleanBugReportErrorMessage,
  MAX_BUG_REPORT_ERROR_AGE,
  MAX_BUG_REPORT_ERROR_COUNT,
  MAX_BUG_REPORT_ERRORS,
} from "../../../packages/remote-protocol/src";

export interface RecentError {
  readonly at: number;
  readonly area: BugReportErrorArea;
  readonly code: string;
  readonly status?: number;
  readonly message?: string;
  readonly count: number;
}

export type RecordError = (
  area: BugReportErrorArea,
  code: string,
  status?: number,
  message?: string,
) => void;

function httpStatus(status: number | undefined): number | undefined {
  return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

export class RecentErrors {
  private entries: RecentError[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly cap: number = MAX_BUG_REPORT_ERRORS,
  ) {}

  readonly record: RecordError = (area, code, status, message) => {
    if (!BUG_REPORT_ERROR_CODE_PATTERN.test(code)) return;
    const shownStatus = httpStatus(status);
    const shownMessage = message === undefined ? undefined : cleanBugReportErrorMessage(message);
    const same = this.entries.find(
      (entry) =>
        entry.area === area &&
        entry.code === code &&
        entry.status === shownStatus &&
        entry.message === shownMessage,
    );
    const entry: RecentError = {
      at: this.now(),
      area,
      code,
      ...(shownStatus !== undefined ? { status: shownStatus } : {}),
      ...(shownMessage !== undefined ? { message: shownMessage } : {}),
      count: Math.min((same?.count ?? 0) + 1, MAX_BUG_REPORT_ERROR_COUNT),
    };
    this.entries = [...this.entries.filter((e) => e !== same), entry].slice(-this.cap);
  };

  list(): BugReportRecentError[] {
    const now = this.now();
    return this.entries
      .map(({ at, area, code, status, message, count }) => ({
        ago: Math.max(0, Math.floor((now - at) / 1000)),
        area,
        code,
        ...(status !== undefined ? { status } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(count > 1 ? { count } : {}),
      }))
      .filter(({ ago }) => ago <= MAX_BUG_REPORT_ERROR_AGE)
      .reverse();
  }
}

export const appErrors = new RecentErrors();
