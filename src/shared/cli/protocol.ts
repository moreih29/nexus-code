import { z } from "zod";

export const CLI_CALLER_ID_MAX = 64;

export const CliInvocationSchema = z.object({
  argv: z.array(z.string()),
  cwd: z.string(),
  tempDir: z.string(),
  stdin: z.string().optional(),
  msysRoot: z.string().optional(),
});
export type CliInvocation = z.infer<typeof CliInvocationSchema>;

export const CliRequestRefSchema = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1).max(CLI_CALLER_ID_MAX),
});

export const CliRequestSchema = CliRequestRefSchema.extend({
  tabId: z.string().min(1).max(CLI_CALLER_ID_MAX),
  request: CliInvocationSchema,
  verified: z.boolean().optional(),
});
export type CliRequest = z.infer<typeof CliRequestSchema>;

export const CliCancelSchema = CliRequestRefSchema;

export interface CliFile {
  readonly path: string;
  readonly base64: string;
}

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly files?: readonly CliFile[];
}
