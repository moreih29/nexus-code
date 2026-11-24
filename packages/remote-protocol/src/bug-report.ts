import { z } from "zod";
import { IntegerSchema, NonnegativeIntegerSchema, PositiveIntegerSchema } from "./validation.js";

export const BUG_REPORT_VERSION = 1;

export const MIN_BUG_REPORT_DESCRIPTION = 10;
export const MAX_BUG_REPORT_DESCRIPTION = 3000;
export const MAX_BUG_REPORT_ERRORS = 20;
export const MAX_BUG_REPORT_ERROR_AGE = 30 * 24 * 60 * 60;
export const MAX_BUG_REPORT_CONTEXT_BYTES = 8 * 1024;
export const MAX_BUG_REPORT_BODY_BYTES = 24 * 1024;
export const MAX_BUG_REPORT_ERROR_MESSAGE = 300;
export const MAX_BUG_REPORT_ERROR_COUNT = 9999;

export const BUG_REPORT_TEXT_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern refuses control characters
  /^(?:[^\u0000-\u0008\u000B-\u001F\u007F-\u009F\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/;
export const BUG_REPORT_ERROR_MESSAGE_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern refuses control characters
  /^(?:[^\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$/;
export const BUG_REPORT_APP_VERSION_PATTERN = /^[0-9A-Za-z._+-]{1,32}$/;
export const BUG_REPORT_OS_VERSION_PATTERN = /^[0-9A-Za-z._+-]{1,64}$/;
export const BUG_REPORT_PACKAGE_PATTERN =
  /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[0-9A-Za-z.-]{1,20})?$/;
export const BUG_REPORT_MODEL_PATTERN = /^[A-Za-z0-9,._ -]{1,40}$/;
export const BUG_REPORT_ARCH_PATTERN = /^[a-z0-9_]{1,16}$/;
export const BUG_REPORT_ERROR_CODE_PATTERN = /^[a-z0-9_.:-]{1,40}$/;

export const BUG_REPORT_DEVICE_KINDS = ["phone", "tablet", "desktop"] as const;
export const BugReportDeviceKindSchema = z.enum(BUG_REPORT_DEVICE_KINDS);
export type BugReportDeviceKind = z.infer<typeof BugReportDeviceKindSchema>;

export const BUG_REPORT_ERROR_AREAS = [
  "api",
  "relay",
  "voice",
  "push",
  "rpc",
  "render",
  "app",
  "agent",
  "notes",
  "files",
  "git",
] as const;
export const BugReportErrorAreaSchema = z.enum(BUG_REPORT_ERROR_AREAS);
export type BugReportErrorArea = z.infer<typeof BugReportErrorAreaSchema>;

export const BugReportRecentErrorSchema = z.strictObject({
  ago: NonnegativeIntegerSchema.check(z.lte(MAX_BUG_REPORT_ERROR_AGE)),
  area: BugReportErrorAreaSchema,
  code: z.string().regex(BUG_REPORT_ERROR_CODE_PATTERN),
  status: IntegerSchema.check(z.gte(100), z.lte(599)).optional(),
  message: z
    .string()
    .min(1)
    .max(MAX_BUG_REPORT_ERROR_MESSAGE)
    .regex(BUG_REPORT_ERROR_MESSAGE_PATTERN)
    .optional(),
  count: IntegerSchema.check(z.gte(1), z.lte(MAX_BUG_REPORT_ERROR_COUNT)).optional(),
});
export type BugReportRecentError = z.infer<typeof BugReportRecentErrorSchema>;

export const BugReportContextSchema = z.strictObject({
  app: z.strictObject({
    version: z.string().regex(BUG_REPORT_APP_VERSION_PATTERN),
    build: z.string().regex(BUG_REPORT_APP_VERSION_PATTERN).optional(),
  }),
  os: z.strictObject({
    version: z.string().regex(BUG_REPORT_OS_VERSION_PATTERN),
  }),
  device: z.strictObject({
    kind: BugReportDeviceKindSchema,
    model: z.string().regex(BUG_REPORT_MODEL_PATTERN).optional(),
    arch: z.string().regex(BUG_REPORT_ARCH_PATTERN).optional(),
  }),
  protocol: z.strictObject({
    version: PositiveIntegerSchema.check(z.lte(1000)),
    package: z.string().regex(BUG_REPORT_PACKAGE_PATTERN),
  }),
  locale: z.enum(["ko", "en"]),
  errors: z.array(BugReportRecentErrorSchema).max(MAX_BUG_REPORT_ERRORS).optional(),
});
export type BugReportContext = z.infer<typeof BugReportContextSchema>;

export const BugReportSchema = z.strictObject({
  id: z.uuid(),
  description: z
    .string()
    .min(MIN_BUG_REPORT_DESCRIPTION)
    .max(MAX_BUG_REPORT_DESCRIPTION)
    .regex(BUG_REPORT_TEXT_PATTERN),
  contactOk: z.boolean(),
  context: BugReportContextSchema,
});
export type BugReport = z.infer<typeof BugReportSchema>;

const PATH_CHAR = String.raw`[^\s'"\`<>|]`;
const NAME_SPACE = String.raw`[^\S\r\n\u2028\u2029]+`;
const NAME_CHAR = String.raw`[^\s\\/'"\`<>|:;,=+*?\[\]]`;
const NAME_WORD = `${NAME_CHAR}+(?:'${NAME_CHAR}+)*`;
const FILE_EXTENSION = String.raw`\.(?=[0-9]{0,7}[A-Za-z])[A-Za-z0-9]{1,8}(?=[.)]*(?!${NAME_CHAR}))`;
const FILE_NAME_WORDS = String.raw`(?<![:;,=+*?\[\].)])(?:${NAME_SPACE}${NAME_WORD}(?<!\.)){0,3}${NAME_SPACE}(?:${NAME_CHAR}+')*${NAME_CHAR}+${FILE_EXTENSION}`;
const PATH_MORE = String.raw`(?:[ \t]+(?:${PATH_CHAR}+[ \t]+)?${PATH_CHAR}*[\\/]${PATH_CHAR}*)*(?:${FILE_NAME_WORDS})?`;
const PATH_BEFORE = String.raw`(^|[\s'"\`(\[{=,;<>|])`;

const HOME_NAME = String.raw`${NAME_WORD}(?:${NAME_SPACE}(?![A-Za-z]:[\\/]|[A-Za-z][A-Za-z0-9+.-]*:\/\/)${NAME_WORD})*`;
const HOME_TAIL = String.raw`(?:[\\/]{1,2}${PATH_CHAR}*${PATH_MORE})?`;
const WINDOWS_HOME_PATH = new RegExp(
  String.raw`(^|[^A-Za-z0-9_])(?:\\{2}\?\\|\\{4}\?\\{2})?[A-Za-z]:(?:\\{1,2}|/)users(?:\\{1,2}|/)${HOME_NAME}${HOME_TAIL}`,
  "gi",
);
const POSIX_HOME_PATH = new RegExp(`${PATH_BEFORE}/(?:Users|home)/${HOME_NAME}${HOME_TAIL}`, "g");

const FILE_URL = /\bfile:\/*[^\s'"`<>|]*/gi;
const URL_PARTS =
  /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#'"`<>@]*@)?([^\s?#'"`<>]*)(?:[?#][^\s'"`<>]*)?/gi;
const QUOTED_PATH = /(['"`])(?:~[\w.-]*|\.{1,2}|[A-Za-z]:)?[\\/][^'"`\r\n]*\1/g;
const DRIVE_PATH = new RegExp(
  String.raw`(^|[^A-Za-z0-9_])[A-Za-z]:(?:\\{1,2}|/)${PATH_CHAR}*${PATH_MORE}`,
  "g",
);
const UNC_PATH = new RegExp(
  String.raw`(^|[^A-Za-z0-9_:\\/])\\{2,4}[^\s\\/'"\`<>|]+\\{1,2}${PATH_CHAR}*${PATH_MORE}`,
  "g",
);
const ROOT_PATH = new RegExp(
  String.raw`${PATH_BEFORE}(?:/${PATH_CHAR}+/|(?:~[\w.-]*|\.{1,2})[\\/]${PATH_CHAR})${PATH_CHAR}*${PATH_MORE}`,
  "g",
);
const SYSCALL_PATH =
  /(\b(?:open|stat|lstat|fstat|scandir|opendir|readdir|mkdir|mkdtemp|rmdir|rm|unlink|rename|copyfile|cp|access|chmod|chown|readlink|realpath|symlink|link|utime|watch|spawn|uv_cwd)|->) '[^'\r\n]*'/g;
const EMAIL = /(^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const AUTH_SCHEME = /\b(bearer|basic)(\s+)([A-Za-z0-9._~+/-]+=*)/gi;
const AUTH_HEADER =
  /\b(authorization|proxy-authorization|x-account-auth|cookie|set-cookie|x-api-key|api-key)(["']?[ \t]*[:=][ \t]*)("[^"]*"|'[^']*'|[^\s,;…]+)/gi;
const SECRET_FIELD =
  /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|apikey|signature|ticket|credential)s?)(["']?[ \t]*[:=][ \t]*)("[^"]*"|'[^']*'|[^\s&,;'"…]+)/gi;
const KEY_PREFIXES =
  /\b(?:(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,})/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const LONG_HEX = /\b(?:0x)?[0-9a-fA-F]{32,}\b/g;
const LONG_BASE64 = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
const IPV6 = /(^|[^\w:.])((?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4})(?![\w:.])/g;

const PATH = "<path>";
const SECRET = "<secret>";

function pathOf(all: string, before: string): string {
  const body = all.slice(before.length);
  const opens = body.split("(").length;
  const closes = body.split(")").length;
  return body.endsWith(")") && closes > opens ? `${before}${PATH})` : `${before}${PATH}`;
}

function isCredential(scheme: string, value: string): boolean {
  if (/[0-9]/.test(value)) return true;
  if (scheme.toLowerCase() === "bearer") return value.length >= 16;
  return value.length >= 8 && (/=$/.test(value) || /[A-Z]/.test(value.slice(1)));
}

function looksLikeKey(text: string): boolean {
  return /[0-9]/.test(text) && /[A-Z]/.test(text) && /[a-z]/.test(text);
}

function isAddress6(text: string): boolean {
  if (text === "::1" || text === "::") return false;
  const groups = text.split(":").filter((group) => group !== "").length;
  const colons = text.split(":").length - 1;
  return (text.includes("::") && groups >= 2) || colons >= 5;
}

const MAX_REDACT_PASSES = 8;
const MAX_REDACTED_INPUT = 8192;
const CUT_LOOKBACK = 64;
const CUT_STEP = 16;
const MESSAGE_CHAR = new RegExp(BUG_REPORT_ERROR_MESSAGE_PATTERN.source.replace(")+$", ")$"));

function redactOnce(text: string): string {
  return text
    .replace(PRIVATE_KEY, SECRET)
    .replace(FILE_URL, PATH)
    .replace(URL_PARTS, "$1$2")
    .replace(QUOTED_PATH, `$1${PATH}$1`)
    .replace(WINDOWS_HOME_PATH, pathOf)
    .replace(POSIX_HOME_PATH, pathOf)
    .replace(UNC_PATH, pathOf)
    .replace(DRIVE_PATH, pathOf)
    .replace(ROOT_PATH, pathOf)
    .replace(SYSCALL_PATH, `$1 '${PATH}'`)
    .replace(EMAIL, "$1<email>")
    .replace(AUTH_SCHEME, (all, scheme: string, space: string, value: string) =>
      isCredential(scheme, value) ? `${scheme}${space}${SECRET}` : all,
    )
    .replace(AUTH_HEADER, `$1$2${SECRET}`)
    .replace(SECRET_FIELD, (all, key: string, between: string, value: string) =>
      /^\d+$/.test(value) ? all : `${key}${between}${SECRET}`,
    )
    .replace(KEY_PREFIXES, SECRET)
    .replace(JWT, SECRET)
    .replace(LONG_HEX, SECRET)
    .replace(LONG_BASE64, (all) => (looksLikeKey(all) ? SECRET : all))
    .replace(IPV4, (all) => (all.startsWith("127.") || all === "0.0.0.0" ? all : "<ip>"))
    .replace(IPV6, (all, before: string, address: string) =>
      isAddress6(address) ? `${before}<ip>` : all,
    );
}

function untilStable(text: string, step: (text: string) => string): string {
  let current = text;
  for (let pass = 0; pass < MAX_REDACT_PASSES; pass++) {
    const next = step(current);
    if (next === current) return current;
    current = next;
  }
  return SECRET;
}

export function redactBugReportText(text: string): string {
  return untilStable(text, redactOnce);
}

function oneLine(text: string): string {
  return Array.from(text, (char) => (/\s/.test(char) || !MESSAGE_CHAR.test(char) ? " " : char))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
}

function settle(text: string): string {
  return untilStable(oneLine(text), (current) => oneLine(redactBugReportText(current)));
}

function cutTo(text: string, max: number): string {
  const chars = Array.from(text);
  let end = max - 2;
  for (let index = end; index > 0 && index >= max - 2 - CUT_LOOKBACK; index--) {
    if (chars[index] === " ") {
      end = index;
      break;
    }
  }
  return `${chars.slice(0, end).join("").trimEnd()} …`;
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

export function cleanBugReportErrorMessage(text: string): string | undefined {
  let line = settle(text.slice(0, MAX_REDACTED_INPUT));
  for (
    let limit = MAX_BUG_REPORT_ERROR_MESSAGE;
    codePoints(line) > MAX_BUG_REPORT_ERROR_MESSAGE && limit > CUT_STEP;
    limit -= CUT_STEP
  ) {
    line = settle(cutTo(line, limit));
  }
  if (line === "") return undefined;
  return codePoints(line) > MAX_BUG_REPORT_ERROR_MESSAGE ? SECRET : line;
}

export function bugReportBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function fitBugReportContext(
  context: BugReportContext,
  maxBytes: number = MAX_BUG_REPORT_CONTEXT_BYTES,
): BugReportContext {
  if (bugReportBytes(context) <= maxBytes || !context.errors) return context;
  const errors = context.errors.map((error) => ({ ...error }));
  const fitted = { ...context, errors };
  for (let i = errors.length - 1; i >= 0; i--) {
    if (errors[i].message === undefined) continue;
    delete errors[i].message;
    if (bugReportBytes(fitted) <= maxBytes) return fitted;
  }
  while (errors.length > 0 && bugReportBytes(fitted) > maxBytes) errors.pop();
  return fitted;
}

export const BUG_REPORT_STATUSES = ["open", "reviewing", "closed"] as const;
export const BugReportStatusSchema = z.enum(BUG_REPORT_STATUSES);
export type BugReportStatus = z.infer<typeof BugReportStatusSchema>;

export const BugReportCreatedSchema = z.object({
  id: z.string().min(1).max(64),
  status: BugReportStatusSchema,
});
export type BugReportCreated = z.infer<typeof BugReportCreatedSchema>;

export const BUG_REPORT_ERRORS = [
  "bad_request",
  "unsupported_version",
  "unauthorized",
  "not_invited",
  "too_big",
  "rate_limited",
  "server_error",
] as const;
export const BugReportErrorSchema = z.enum(BUG_REPORT_ERRORS);
export type BugReportError = z.infer<typeof BugReportErrorSchema>;
