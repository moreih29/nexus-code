import { homedir } from "node:os";
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

const PATH = "<path>";
const MAX_HOME_INPUT = 16 * 1024;
const WINDOWS_SEPARATOR = String.raw`(?:\\{1,2}|/)`;
const LONG_PREFIX = String.raw`(?:\\{2}[?.]\\|\\{4}[?.]\\{2})?`;
const NAME_GOES_ON = String.raw`(?![\p{L}\p{M}\p{N}_~$#%&-]|\.[\p{L}\p{M}\p{N}_])`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function homePattern(home: string): RegExp | undefined {
  if (/^[\\/]{2}/.test(home)) return undefined;
  const parts = home.split(/[\\/]+/);
  while (parts.length > 1 && parts.at(-1) === "") parts.pop();
  const [root, ...names] = parts;
  if (names.length === 0 || names.includes("")) return undefined;
  if (root === "") {
    return new RegExp(`(/)${names.map(escapeRegExp).join("/")}${NAME_GOES_ON}`, "giu");
  }
  if (!/^[A-Za-z]:$/.test(root)) return undefined;
  return new RegExp(
    `${LONG_PREFIX}(${escapeRegExp(root)}${WINDOWS_SEPARATOR})${names.map(escapeRegExp).join(WINDOWS_SEPARATOR)}${NAME_GOES_ON}`,
    "giu",
  );
}

export function homeRedactor(home: string): (text: string) => string {
  const pattern = homePattern(home);
  if (!pattern) return (text) => text;
  return (text) =>
    text
      .slice(0, MAX_HOME_INPUT)
      .replace(pattern, (found: string, root: string, offset: number, all: string) => {
        const next = all[offset + found.length];
        return next === "\\" || next === "/" ? `${root}~` : PATH;
      });
}

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
    private readonly forgetHome: (text: string) => string = homeRedactor(homedir()),
  ) {}

  readonly record: RecordError = (area, code, status, message) => {
    if (!BUG_REPORT_ERROR_CODE_PATTERN.test(code)) return;
    const shownStatus = httpStatus(status);
    const shownMessage =
      message === undefined ? undefined : cleanBugReportErrorMessage(this.forgetHome(message));
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
