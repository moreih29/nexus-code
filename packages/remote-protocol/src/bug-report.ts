import { z } from "zod";
import { IntegerSchema, NonnegativeIntegerSchema, PositiveIntegerSchema } from "./validation.js";

export const BUG_REPORT_VERSION = 1;

export const MIN_BUG_REPORT_DESCRIPTION = 10;
export const MAX_BUG_REPORT_DESCRIPTION = 3000;
export const MAX_BUG_REPORT_ERRORS = 20;
export const MAX_BUG_REPORT_ERROR_AGE = 30 * 24 * 60 * 60;
export const MAX_BUG_REPORT_CONTEXT_BYTES = 4 * 1024;

export const BUG_REPORT_TEXT_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern refuses control characters
  /^(?:[^\u0000-\u0008\u000B-\u001F\u007F-\u009F\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/;
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

export const BUG_REPORT_ERROR_AREAS = ["api", "relay", "voice", "push", "rpc", "render"] as const;
export const BugReportErrorAreaSchema = z.enum(BUG_REPORT_ERROR_AREAS);
export type BugReportErrorArea = z.infer<typeof BugReportErrorAreaSchema>;

export const BugReportRecentErrorSchema = z.strictObject({
  ago: NonnegativeIntegerSchema.check(z.lte(MAX_BUG_REPORT_ERROR_AGE)),
  area: BugReportErrorAreaSchema,
  code: z.string().regex(BUG_REPORT_ERROR_CODE_PATTERN),
  status: IntegerSchema.check(z.gte(100), z.lte(599)).optional(),
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
