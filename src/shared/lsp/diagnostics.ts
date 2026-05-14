import { z } from "zod";
import { LocationSchema, MarkupContentOrStringSchema, RangeSchema } from "./primitives";

export const DiagnosticTagSchema = z.union([z.literal(1), z.literal(2)]);
export type DiagnosticTag = z.infer<typeof DiagnosticTagSchema>;

export const DiagnosticSeveritySchema = z.number().int().min(1).max(4);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

export const CodeDescriptionSchema = z.object({
  href: z.string(),
});
export type CodeDescription = z.infer<typeof CodeDescriptionSchema>;

export const DiagnosticRelatedInformationSchema = z.object({
  location: LocationSchema,
  message: z.string(),
});
export type DiagnosticRelatedInformation = z.infer<typeof DiagnosticRelatedInformationSchema>;

export const DiagnosticSchema = z.object({
  range: RangeSchema,
  severity: DiagnosticSeveritySchema.optional(),
  code: z.union([z.number().int(), z.string()]).optional(),
  codeDescription: CodeDescriptionSchema.optional(),
  source: z.string().optional(),
  message: z.string(),
  tags: z.array(DiagnosticTagSchema).optional(),
  relatedInformation: z.array(DiagnosticRelatedInformationSchema).optional(),
  data: z.unknown().optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const HoverResultSchema = z.object({
  contents: MarkupContentOrStringSchema,
  range: RangeSchema.optional(),
});
export type HoverResult = z.infer<typeof HoverResultSchema>;

export const MessageType = {
  Error: 1,
  Warning: 2,
  Info: 3,
  Log: 4,
} as const;

export const MessageTypeSchema = z.union([
  z.literal(MessageType.Error),
  z.literal(MessageType.Warning),
  z.literal(MessageType.Info),
  z.literal(MessageType.Log),
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageActionItemSchema = z.object({ title: z.string() }).passthrough();
export type MessageActionItem = z.infer<typeof MessageActionItemSchema>;

export const ShowMessageParamsSchema = z
  .object({
    type: MessageTypeSchema,
    message: z.string(),
  })
  .passthrough();
export type ShowMessageParams = z.infer<typeof ShowMessageParamsSchema>;

export const ShowMessageRequestParamsSchema = ShowMessageParamsSchema.extend({
  actions: z.array(MessageActionItemSchema).optional(),
}).passthrough();
export type ShowMessageRequestParams = z.infer<typeof ShowMessageRequestParamsSchema>;

export const ProgressTokenSchema = z.union([z.string(), z.number()]);
export type ProgressToken = z.infer<typeof ProgressTokenSchema>;

export const WorkDoneProgressCreateParamsSchema = z
  .object({
    token: ProgressTokenSchema,
  })
  .passthrough();
export type WorkDoneProgressCreateParams = z.infer<typeof WorkDoneProgressCreateParamsSchema>;

export const WorkDoneProgressBeginSchema = z
  .object({
    kind: z.literal("begin"),
    title: z.string(),
    cancellable: z.boolean().optional(),
    message: z.string().optional(),
    percentage: z.number().min(0).max(100).optional(),
  })
  .passthrough();
export type WorkDoneProgressBegin = z.infer<typeof WorkDoneProgressBeginSchema>;

export const WorkDoneProgressReportSchema = z
  .object({
    kind: z.literal("report"),
    cancellable: z.boolean().optional(),
    message: z.string().optional(),
    percentage: z.number().min(0).max(100).optional(),
  })
  .passthrough();
export type WorkDoneProgressReport = z.infer<typeof WorkDoneProgressReportSchema>;

export const WorkDoneProgressEndSchema = z
  .object({
    kind: z.literal("end"),
    message: z.string().optional(),
  })
  .passthrough();
export type WorkDoneProgressEnd = z.infer<typeof WorkDoneProgressEndSchema>;

export const WorkDoneProgressValueSchema = z.union([
  WorkDoneProgressBeginSchema,
  WorkDoneProgressReportSchema,
  WorkDoneProgressEndSchema,
]);
export type WorkDoneProgressValue = z.infer<typeof WorkDoneProgressValueSchema>;

export const ProgressParamsSchema = z
  .object({
    token: ProgressTokenSchema,
    value: z.unknown(),
  })
  .passthrough();
export type ProgressParams = z.infer<typeof ProgressParamsSchema>;

export const LspServerEventMethodSchema = z.enum([
  "window/logMessage",
  "window/showMessage",
  "window/showMessageRequest",
  "window/workDoneProgress/create",
  "$/progress",
]);
export type LspServerEventMethod = z.infer<typeof LspServerEventMethodSchema>;

export const LspServerEventSchema = z.object({
  workspaceId: z.string(),
  languageId: z.string(),
  method: LspServerEventMethodSchema,
  params: z.unknown(),
});
export type LspServerEvent = z.infer<typeof LspServerEventSchema>;

export const LspBootstrapProgressPhaseSchema = z.enum([
  "checking",
  "skipped",
  "uploading",
  "verifying",
  "extracting",
  "linking",
  "pruning",
  "ready",
]);
export type LspBootstrapProgressPhase = z.infer<typeof LspBootstrapProgressPhaseSchema>;

export const LspBootstrapProgressEventSchema = z.object({
  workspaceId: z.string(),
  languageId: z.string(),
  name: z.string(),
  phase: LspBootstrapProgressPhaseSchema,
  bytesDone: z.number().int().nonnegative().optional(),
  bytesTotal: z.number().int().nonnegative().optional(),
});
export type LspBootstrapProgressEvent = z.infer<typeof LspBootstrapProgressEventSchema>;
