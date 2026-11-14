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
  /**
   * For a command from Git Bash, the Windows path of its "/"; empty when its
   * launcher could not tell. Git Bash leaves its paths as it spells them.
   */
  msysRoot: z.string().optional(),
});
export type CliInvocation = z.infer<typeof CliInvocationSchema>;

/** The "cli.request" event. Matches CLIEventPayload in internal/hookserver. */
export const CliRequestSchema = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1),
  tabId: z.string().min(1),
  request: CliInvocationSchema,
  /**
   * Whether it came with its tab's own token, so it is that tab's (true),
   * or with the server's, which processes of tabs an older app started
   * hold, so whose it is cannot be told (false). An agent older than tab
   * tokens leaves it out.
   */
  verified: z.boolean().optional(),
});
export type CliRequest = z.infer<typeof CliRequestSchema>;

/**
 * The "cli.cancel" event: the request's client went before the answer, as
 * one stopped with Ctrl-C. Matches CLICancelPayload in internal/hookserver.
 */
export const CliCancelSchema = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1),
});

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
