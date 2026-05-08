import { z } from "zod";
import { DocumentUriSchema, TextEditSchema } from "./primitives";
import { VersionedTextDocumentIdentifierSchema } from "./text-document";
import { DiagnosticSchema } from "./diagnostics";

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
