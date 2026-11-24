import { z } from "zod";
import {
  BUG_REPORT_APP_VERSION_PATTERN,
  BUG_REPORT_ARCH_PATTERN,
  BUG_REPORT_OS_VERSION_PATTERN,
  BUG_REPORT_TEXT_PATTERN,
  type BugReport,
  type BugReportContext,
  type BugReportRecentError,
  BugReportSchema,
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
  return {
    app: { version: fitVersion(facts.appVersion, BUG_REPORT_APP_VERSION_PATTERN, 32) },
    os: { version: fitVersion(facts.osVersion, BUG_REPORT_OS_VERSION_PATTERN, 64) },
    device: {
      kind: "desktop",
      ...(BUG_REPORT_ARCH_PATTERN.test(facts.arch) ? { arch: facts.arch } : {}),
    },
    protocol: { version: PROTOCOL_VERSION, package: SCHEMA_VERSION },
    locale,
    ...(errors ? { errors: [...errors] } : {}),
  };
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
