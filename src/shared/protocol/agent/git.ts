import { z } from "zod";
import { GitIgnoreAppendResultSchema, GitOperationStateSchema } from "../../types/git";
import { FileReadResultSchema } from "../../types/fs";

export const GIT_RUN_METHOD = "git.run";
export const GIT_STREAM_METHOD = "git.stream";
export const GIT_CANCEL_METHOD = "git.cancel";
export const GIT_STREAM_CHUNK_EVENT = "git.streamChunk";
export const GIT_METADATA_METHOD = "git.metadata";
export const GIT_WATCH_METHOD = "git.watch";
export const GIT_UNWATCH_METHOD = "git.unwatch";
export const GIT_CHANGED_EVENT = "git.changed";
export const GIT_ADD_TO_GITIGNORE_METHOD = "git.addToGitignore";
export const GIT_GET_FILE_CONTENT_METHOD = "git.getFileContent";

const GitEnvSchema = z.record(z.string(), z.string());

export const AgentGitRunParamsSchema = z.object({
  args: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: GitEnvSchema.optional(),
  interactive: z.boolean().optional(),
  stdoutCapBytes: z.number().int().positive().optional(),
});
export type AgentGitRunParams = z.infer<typeof AgentGitRunParamsSchema>;

export const AgentGitRunResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  code: z.number().int(),
});
export type AgentGitRunResult = z.infer<typeof AgentGitRunResultSchema>;

export const AgentGitStreamParamsSchema = AgentGitRunParamsSchema.omit({
  stdoutCapBytes: true,
}).extend({
  streamId: z.string().min(1),
});
export type AgentGitStreamParams = z.infer<typeof AgentGitStreamParamsSchema>;

export const AgentGitStreamChunkPayloadSchema = z.object({
  streamId: z.string().min(1),
  chunk: z.string(),
});
export type AgentGitStreamChunkPayload = z.infer<typeof AgentGitStreamChunkPayloadSchema>;

export const AgentGitCancelParamsSchema = z.object({
  streamId: z.string().min(1),
});
export type AgentGitCancelParams = z.infer<typeof AgentGitCancelParamsSchema>;

export const AgentGitMetadataParamsSchema = z.object({
  gitDir: z.string().min(1),
  conflictCount: z.number().int().nonnegative().optional(),
});
export type AgentGitMetadataParams = z.infer<typeof AgentGitMetadataParamsSchema>;

export const AgentGitMetadataResultSchema = z.object({
  operationState: GitOperationStateSchema,
  lastFetchedAt: z.number().int().nonnegative().nullable(),
});
export type AgentGitMetadataResult = z.infer<typeof AgentGitMetadataResultSchema>;

export const AgentGitWatchParamsSchema = z.object({
  gitDir: z.string().min(1),
});
export type AgentGitWatchParams = z.infer<typeof AgentGitWatchParamsSchema>;

export const AgentGitChangedPayloadSchema = z.object({
  gitDir: z.string().min(1),
});
export type AgentGitChangedPayload = z.infer<typeof AgentGitChangedPayloadSchema>;

export const AgentGitAddToGitignoreParamsSchema = z.object({
  repoRoot: z.string().min(1),
  relPath: z.string().min(1),
});
export type AgentGitAddToGitignoreParams = z.infer<
  typeof AgentGitAddToGitignoreParamsSchema
>;

export const AgentGitAddToGitignoreResultSchema = GitIgnoreAppendResultSchema;

export const AgentGitGetFileContentParamsSchema = z.object({
  ref: z.string().min(1),
  relPath: z.string().min(1),
});
export type AgentGitGetFileContentParams = z.infer<typeof AgentGitGetFileContentParamsSchema>;

export const AgentGitGetFileContentResultSchema = FileReadResultSchema;
