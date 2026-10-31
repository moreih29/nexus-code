/**
 * The nexus CLI's wire format. `agent cli <args>` (internal/cliclient) sends
 * an invocation through the agent's hook socket; the agent hands it to main
 * as a "cli.request" event; main answers with "cli.respond".
 */
import { z } from "zod";

/** What one run of the nexus command asks. Matches `request` in internal/cliclient. */
export const CliInvocationSchema = z.object({
  argv: z.array(z.string()),
  /** The command's working directory, on the host its terminal runs on. */
  cwd: z.string(),
  /** That host's temp directory, where made files go by default. */
  tempDir: z.string(),
  /** Standard input, read when an argument is "-". */
  stdin: z.string().optional(),
});
export type CliInvocation = z.infer<typeof CliInvocationSchema>;

/** The "cli.request" event. Matches CLIEventPayload in internal/hookserver. */
export const CliRequestSchema = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1),
  tabId: z.string().min(1),
  request: CliInvocationSchema,
});
export type CliRequest = z.infer<typeof CliRequestSchema>;

/** A file the command writes on its own host, such as a screenshot. */
export interface CliFile {
  readonly path: string;
  readonly base64: string;
}

/** The answer. Matches `result` in internal/cliclient. */
export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly files?: readonly CliFile[];
}
