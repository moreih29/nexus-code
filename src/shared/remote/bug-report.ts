import { z } from "zod";
import {
  BUG_REPORT_APP_VERSION_PATTERN,
  BUG_REPORT_ARCH_PATTERN,
  BUG_REPORT_ERROR_CODE_PATTERN,
  BUG_REPORT_OS_VERSION_PATTERN,
  BUG_REPORT_TEXT_PATTERN,
  type BugReport,
  type BugReportContext,
  BugReportErrorAreaSchema,
  type BugReportRecentError,
  BugReportSchema,
  cleanBugReportErrorMessage,
  fitBugReportContext,
  MAX_BUG_REPORT_DESCRIPTION,
  MIN_BUG_REPORT_DESCRIPTION,
} from "../../../packages/remote-protocol/src/bug-report";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../../packages/remote-protocol/src/sealed";

export const BugReportLocaleSchema = z.enum(["ko", "en"]);
export type BugReportLocale = z.infer<typeof BugReportLocaleSchema>;

export const BugReportDraftSchema = z.object({
  description: z.string().max(MAX_BUG_REPORT_DESCRIPTION * 8),
  contactOk: z.boolean(),
  includeErrors: z.boolean(),
  locale: BugReportLocaleSchema,
});
export type BugReportDraft = z.infer<typeof BugReportDraftSchema>;

export const MAX_REPORTED_ERROR_MESSAGE = 2000;

export const ReportedErrorSchema = z.object({
  area: BugReportErrorAreaSchema,
  code: z.string().regex(BUG_REPORT_ERROR_CODE_PATTERN),
  status: z.number().int().min(100).max(599).optional(),
  message: z.string().max(MAX_REPORTED_ERROR_MESSAGE).optional(),
});
export type ReportedError = z.infer<typeof ReportedErrorSchema>;

export const BUG_REPORT_FAILURES = [
  "rate-limited",
  "signed-out",
  "not-allowed",
  "too-big",
  "unsupported",
  "offline",
  "failed",
] as const;
export type BugReportFailure = (typeof BUG_REPORT_FAILURES)[number];

export const BugReportOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("sent"), id: z.string() }),
  z.object({
    status: z.literal("failed"),
    failure: z.enum(BUG_REPORT_FAILURES),
    retryAfter: z.number().nonnegative().optional(),
  }),
]);
export type BugReportOutcome = z.infer<typeof BugReportOutcomeSchema>;

export interface BugReportFacts {
  readonly appVersion: string;
  readonly osVersion: string;
  readonly arch: string;
}

const OS_NAMES: Readonly<Record<string, string>> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

export function bugReportOsVersion(platform: string, version: string): string {
  const name = Object.hasOwn(OS_NAMES, platform) ? OS_NAMES[platform] : platform;
  return `${name}-${version}`.replace(/\s+/g, "-");
}

const MAX_CODE = 40;

function codePart(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "");
}

export function bugReportErrorCode(...parts: readonly string[]): string | undefined {
  const code = parts
    .map(codePart)
    .filter((part) => part !== "")
    .join(":")
    .slice(0, MAX_CODE)
    .replace(/[:_.-]+$/, "");
  return BUG_REPORT_ERROR_CODE_PATTERN.test(code) ? code : undefined;
}

export function errorNameOf(error: unknown): string {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return typeof name === "string" && name !== "" ? name : "error";
}

export function errorMessageOf(error: unknown): string | undefined {
  if (errorNameOf(error) === "SyntaxError") return undefined;
  const message = error instanceof Error ? error.message : undefined;
  return message ? cleanBugReportErrorMessage(message) : undefined;
}

function cleanError(error: BugReportRecentError): BugReportRecentError {
  const { message, ...rest } = error;
  const cleaned = message === undefined ? undefined : cleanBugReportErrorMessage(message);
  return cleaned === undefined ? rest : { ...rest, message: cleaned };
}

export function bugReportLocale(language: string): BugReportLocale {
  return language === "ko" || language.startsWith("ko-") ? "ko" : "en";
}

export function cleanBugReportDescription(text: string): string {
  return Array.from(text.replace(/\r\n/g, "\n"))
    .filter((char) => BUG_REPORT_TEXT_PATTERN.test(char))
    .join("")
    .trim();
}

export function bugReportLength(text: string): number {
  return Array.from(cleanBugReportDescription(text)).length;
}

export function bugReportFits(text: string): boolean {
  const length = bugReportLength(text);
  return length >= MIN_BUG_REPORT_DESCRIPTION && length <= MAX_BUG_REPORT_DESCRIPTION;
}

function fitVersion(value: string, pattern: RegExp, max: number): string {
  if (pattern.test(value)) return value;
  const fitted = value.replace(/[^0-9A-Za-z._+-]/g, "-").slice(0, max);
  return pattern.test(fitted) ? fitted : "unknown";
}

export function bugReportContext(
  facts: BugReportFacts,
  locale: BugReportLocale,
  errors: readonly BugReportRecentError[] | null,
): BugReportContext {
  return fitBugReportContext({
    app: { version: fitVersion(facts.appVersion, BUG_REPORT_APP_VERSION_PATTERN, 32) },
    os: { version: fitVersion(facts.osVersion, BUG_REPORT_OS_VERSION_PATTERN, 64) },
    device: {
      kind: "desktop",
      ...(BUG_REPORT_ARCH_PATTERN.test(facts.arch) ? { arch: facts.arch } : {}),
    },
    protocol: { version: PROTOCOL_VERSION, package: SCHEMA_VERSION },
    locale,
    ...(errors ? { errors: errors.map(cleanError) } : {}),
  });
}

export function buildBugReport(
  id: string,
  draft: Pick<BugReportDraft, "description" | "contactOk">,
  context: BugReportContext,
): BugReport {
  return BugReportSchema.parse({
    id,
    description: cleanBugReportDescription(draft.description),
    contactOk: draft.contactOk,
    context,
  });
}
