import { z } from "zod";

export const DocumentUriSchema = z.string();
export type DocumentUri = z.infer<typeof DocumentUriSchema>;

export const PositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
export type Position = z.infer<typeof PositionSchema>;

export const RangeSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
});
export type Range = z.infer<typeof RangeSchema>;

export const LocationSchema = z.object({
  uri: DocumentUriSchema,
  range: RangeSchema,
});
export type Location = z.infer<typeof LocationSchema>;

export const LocationLinkSchema = z.object({
  originSelectionRange: RangeSchema.optional(),
  targetUri: DocumentUriSchema,
  targetRange: RangeSchema,
  targetSelectionRange: RangeSchema,
});
export type LocationLink = z.infer<typeof LocationLinkSchema>;

export const TextDocumentIdentifierSchema = z.object({
  uri: DocumentUriSchema,
});
export type TextDocumentIdentifier = z.infer<typeof TextDocumentIdentifierSchema>;

export const VersionedTextDocumentIdentifierSchema = TextDocumentIdentifierSchema.extend({
  version: z.number().int().nullable(),
});
export type VersionedTextDocumentIdentifier = z.infer<typeof VersionedTextDocumentIdentifierSchema>;

export const TextDocumentItemSchema = z.object({
  uri: DocumentUriSchema,
  languageId: z.string(),
  version: z.number().int(),
  text: z.string(),
});
export type TextDocumentItem = z.infer<typeof TextDocumentItemSchema>;

export const TextDocumentSyncKind = {
  None: 0,
  Full: 1,
  Incremental: 2,
} as const;

export const TextDocumentSyncKindSchema = z.union([
  z.literal(TextDocumentSyncKind.None),
  z.literal(TextDocumentSyncKind.Full),
  z.literal(TextDocumentSyncKind.Incremental),
]);
export type TextDocumentSyncKind = z.infer<typeof TextDocumentSyncKindSchema>;

export const FullTextDocumentContentChangeEventSchema = z
  .object({
    text: z.string(),
  })
  .strict();
export type FullTextDocumentContentChangeEvent = z.infer<
  typeof FullTextDocumentContentChangeEventSchema
>;

export const IncrementalTextDocumentContentChangeEventSchema = z
  .object({
    range: RangeSchema,
    rangeLength: z.number().int().nonnegative().optional(),
    text: z.string(),
  })
  .strict();
export type IncrementalTextDocumentContentChangeEvent = z.infer<
  typeof IncrementalTextDocumentContentChangeEventSchema
>;

export const TextDocumentContentChangeEventSchema = z.union([
  IncrementalTextDocumentContentChangeEventSchema,
  FullTextDocumentContentChangeEventSchema,
]);
export type TextDocumentContentChangeEvent = z.infer<typeof TextDocumentContentChangeEventSchema>;

export const TextEditSchema = z.object({
  range: RangeSchema,
  newText: z.string(),
});
export type TextEdit = z.infer<typeof TextEditSchema>;

export const MarkupContentSchema = z.object({
  kind: z.enum(["plaintext", "markdown"]),
  value: z.string(),
});
export type MarkupContent = z.infer<typeof MarkupContentSchema>;

export const MarkupContentOrStringSchema = z.union([MarkupContentSchema, z.string()]);
export type MarkupContentOrString = z.infer<typeof MarkupContentOrStringSchema>;

export const HoverResultSchema = z.object({
  contents: MarkupContentOrStringSchema,
  range: RangeSchema.optional(),
});
export type HoverResult = z.infer<typeof HoverResultSchema>;

export const SymbolKindSchema = z.number().int().min(1).max(26);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

export const SymbolTagSchema = z.literal(1);
export type SymbolTag = z.infer<typeof SymbolTagSchema>;

export const SymbolInformationSchema = z.object({
  name: z.string(),
  kind: SymbolKindSchema,
  tags: z.array(SymbolTagSchema).optional(),
  deprecated: z.boolean().optional(),
  location: LocationSchema,
  containerName: z.string().optional(),
});
export type SymbolInformation = z.infer<typeof SymbolInformationSchema>;

export interface DocumentSymbol {
  name: string;
  detail?: string | undefined;
  kind: SymbolKind;
  tags?: SymbolTag[] | undefined;
  deprecated?: boolean | undefined;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[] | undefined;
}

export const DocumentSymbolSchema: z.ZodType<DocumentSymbol> = z.lazy(() =>
  z.object({
    name: z.string(),
    detail: z.string().optional(),
    kind: SymbolKindSchema,
    tags: z.array(SymbolTagSchema).optional(),
    deprecated: z.boolean().optional(),
    range: RangeSchema,
    selectionRange: RangeSchema,
    children: z.array(DocumentSymbolSchema).optional(),
  }),
);

export const DiagnosticTagSchema = z.union([z.literal(1), z.literal(2)]);
export type DiagnosticTag = z.infer<typeof DiagnosticTagSchema>;

export const DiagnosticSeveritySchema = z.number().int().min(1).max(4);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

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
export type WorkDoneProgressCreateParams = z.infer<
  typeof WorkDoneProgressCreateParamsSchema
>;

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

export const ChangeAnnotationIdentifierSchema = z.string();
export type ChangeAnnotationIdentifier = z.infer<typeof ChangeAnnotationIdentifierSchema>;

export const ChangeAnnotationSchema = z.object({
  label: z.string(),
  needsConfirmation: z.boolean().optional(),
  description: z.string().optional(),
});
export type ChangeAnnotation = z.infer<typeof ChangeAnnotationSchema>;

export const AnnotatedTextEditSchema = TextEditSchema.extend({
  annotationId: ChangeAnnotationIdentifierSchema,
});
export type AnnotatedTextEdit = z.infer<typeof AnnotatedTextEditSchema>;

export const TextDocumentEditSchema = z.object({
  textDocument: VersionedTextDocumentIdentifierSchema,
  edits: z.array(z.union([AnnotatedTextEditSchema, TextEditSchema])),
});
export type TextDocumentEdit = z.infer<typeof TextDocumentEditSchema>;

export const CreateFileOptionsSchema = z.object({
  overwrite: z.boolean().optional(),
  ignoreIfExists: z.boolean().optional(),
});
export type CreateFileOptions = z.infer<typeof CreateFileOptionsSchema>;

export const RenameFileOptionsSchema = z.object({
  overwrite: z.boolean().optional(),
  ignoreIfExists: z.boolean().optional(),
});
export type RenameFileOptions = z.infer<typeof RenameFileOptionsSchema>;

export const DeleteFileOptionsSchema = z.object({
  recursive: z.boolean().optional(),
  ignoreIfNotExists: z.boolean().optional(),
});
export type DeleteFileOptions = z.infer<typeof DeleteFileOptionsSchema>;

export const CreateFileSchema = z.object({
  kind: z.literal("create"),
  uri: DocumentUriSchema,
  options: CreateFileOptionsSchema.optional(),
  annotationId: ChangeAnnotationIdentifierSchema.optional(),
});
export type CreateFile = z.infer<typeof CreateFileSchema>;

export const RenameFileSchema = z.object({
  kind: z.literal("rename"),
  oldUri: DocumentUriSchema,
  newUri: DocumentUriSchema,
  options: RenameFileOptionsSchema.optional(),
  annotationId: ChangeAnnotationIdentifierSchema.optional(),
});
export type RenameFile = z.infer<typeof RenameFileSchema>;

export const DeleteFileSchema = z.object({
  kind: z.literal("delete"),
  uri: DocumentUriSchema,
  options: DeleteFileOptionsSchema.optional(),
  annotationId: ChangeAnnotationIdentifierSchema.optional(),
});
export type DeleteFile = z.infer<typeof DeleteFileSchema>;

export const WorkspaceDocumentChangeSchema = z.union([
  TextDocumentEditSchema,
  CreateFileSchema,
  RenameFileSchema,
  DeleteFileSchema,
]);
export type WorkspaceDocumentChange = z.infer<typeof WorkspaceDocumentChangeSchema>;

export const WorkspaceEditSchema = z.object({
  changes: z.record(DocumentUriSchema, z.array(TextEditSchema)).optional(),
  documentChanges: z.array(WorkspaceDocumentChangeSchema).optional(),
  changeAnnotations: z.record(ChangeAnnotationIdentifierSchema, ChangeAnnotationSchema).optional(),
});
export type WorkspaceEdit = z.infer<typeof WorkspaceEditSchema>;

export const ConfigurationItemSchema = z.object({
  scopeUri: DocumentUriSchema.optional(),
  section: z.string().optional(),
});
export type ConfigurationItem = z.infer<typeof ConfigurationItemSchema>;

export const ConfigurationParamsSchema = z.object({
  items: z.array(ConfigurationItemSchema),
});
export type ConfigurationParams = z.infer<typeof ConfigurationParamsSchema>;

export const ApplyWorkspaceEditParamsSchema = z.object({
  label: z.string().optional(),
  edit: WorkspaceEditSchema,
});
export type ApplyWorkspaceEditParams = z.infer<typeof ApplyWorkspaceEditParamsSchema>;

export const ApplyWorkspaceEditResultSchema = z.object({
  applied: z.boolean(),
  failureReason: z.string().optional(),
  failedChange: z.number().int().nonnegative().optional(),
});
export type ApplyWorkspaceEditResult = z.infer<typeof ApplyWorkspaceEditResultSchema>;

export const RegistrationSchema = z.object({
  id: z.string(),
  method: z.string(),
  registerOptions: z.unknown().optional(),
});
export type Registration = z.infer<typeof RegistrationSchema>;

export const RegistrationParamsSchema = z.object({
  registrations: z.array(RegistrationSchema),
});
export type RegistrationParams = z.infer<typeof RegistrationParamsSchema>;

export const FileChangeType = {
  Created: 1,
  Changed: 2,
  Deleted: 3,
} as const;

export const FileChangeTypeSchema = z.union([
  z.literal(FileChangeType.Created),
  z.literal(FileChangeType.Changed),
  z.literal(FileChangeType.Deleted),
]);
export type FileChangeType = z.infer<typeof FileChangeTypeSchema>;

export const FileEventSchema = z.object({
  uri: DocumentUriSchema,
  type: FileChangeTypeSchema,
});
export type FileEvent = z.infer<typeof FileEventSchema>;

export const DidChangeWatchedFilesParamsSchema = z.object({
  changes: z.array(FileEventSchema),
});
export type DidChangeWatchedFilesParams = z.infer<typeof DidChangeWatchedFilesParamsSchema>;

export const CommandSchema = z.object({
  title: z.string(),
  command: z.string(),
  arguments: z.array(z.unknown()).optional(),
});
export type Command = z.infer<typeof CommandSchema>;

export const CodeActionDisabledSchema = z.object({
  reason: z.string(),
});
export type CodeActionDisabled = z.infer<typeof CodeActionDisabledSchema>;

export const CodeActionSchema = z.object({
  title: z.string(),
  kind: z.string().optional(),
  diagnostics: z.array(DiagnosticSchema).optional(),
  isPreferred: z.boolean().optional(),
  disabled: CodeActionDisabledSchema.optional(),
  edit: WorkspaceEditSchema.optional(),
  command: CommandSchema.optional(),
  data: z.unknown().optional(),
});
export type CodeAction = z.infer<typeof CodeActionSchema>;

export const CompletionItemSchema = z.object({
  label: z.string(),
  kind: z.number().int().optional(),
});
export type CompletionItem = z.infer<typeof CompletionItemSchema>;

export const ServerCapabilitiesSchema = z.record(z.unknown());
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;

export const TextDocumentPositionArgsSchema = z.object({
  uri: DocumentUriSchema,
  line: PositionSchema.shape.line,
  character: PositionSchema.shape.character,
});
export type TextDocumentPositionArgs = z.infer<typeof TextDocumentPositionArgsSchema>;
