import { z } from "zod";

// ---------------------------------------------------------------------------
// Claude session status enum
// ---------------------------------------------------------------------------

/**
 * The 6 execution states of a Claude Code session.
 *
 * - idle            : session not started, or after the user acknowledged completed — the quiet default.
 * - running         : SessionStart / UserPromptSubmit / PreToolUse in progress.
 * - completed       : right after the Stop hook — the response ended and the user should check it. The next
 *                     SessionStart/UserPromptSubmit/PreToolUse moves it to running automatically, or
 *                     the user activating that tab (markSeen IPC) moves it to idle.
 * - needsInput      : Notification hook received — waiting for ordinary user input (60s idle etc.).
 * - permissionPending: PermissionRequest hook in progress — waiting for a user decision (sync).
 * - error           : Claude Code exited abnormally or hook handling failed.
 */
export const ClaudeStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "needsInput",
  "permissionPending",
  "error",
]);

export type ClaudeStatus = z.infer<typeof ClaudeStatusSchema>;

// ---------------------------------------------------------------------------
// StatusEntry — status payload per workspace and tab
// ---------------------------------------------------------------------------

/**
 * Payload for the current Claude session status of a specific (workspaceId, tabId) pair.
 *
 * since records when the status last changed, in Date.now() ms.
 * Shared by the main → renderer broadcast and the snapshot response.
 */
export const StatusEntrySchema = z.object({
  workspaceId: z.string().min(1),
  tabId: z.string().min(1),
  status: ClaudeStatusSchema,
  /**
   * While the session waits on the user, what it asks (a question, a
   * permission); otherwise Claude's answer to the last prompt, kept once the
   * turn is seen, until the user's next prompt.
   */
  message: z.string().optional(),
  since: z.number().int().positive(),
  /** The last prompt the user submitted in this session (cut to PROMPT_MAX_CHARS). */
  prompt: z.string().optional(),
});

export type StatusEntry = z.infer<typeof StatusEntrySchema>;

/**
 * How much of a prompt a StatusEntry keeps: whatever the user wrote, which
 * the agent view shows whole once opened, but not a whole pasted file.
 */
export const PROMPT_MAX_CHARS = 100_000;

// ---------------------------------------------------------------------------
// HookRequest — agent→main NDJSON hook request (not registered in the IPC contract)
// ---------------------------------------------------------------------------

/**
 * The hook request frame the Go agent's hookserver forwards to main.
 *
 * hookId is a UUID issued by the agent; it acts as the correlationId that identifies
 * which in-flight connection to answer when main replies through respondHook.
 *
 * payload carries, as is, the raw JSON Claude Code wrote to the hook process's stdin.
 * The payload shape differs per subcommand, so it is accepted as z.unknown() and narrowed in each handler.
 *
 * assistantText is an optional field filled only for the Stop hook subcommand. It is the payload's
 * last_assistant_message or, on Claude Code versions without it, the text of the last assistant
 * message that hookclient read directly from transcript_path, normalized to a single line
 * and truncated. undefined when there is no transcript or parsing fails.
 * The hook execution host (local or SSH remote) and transcript_path are on the same fs, so main does not need to
 * know the per-host fs routing.
 */
export const HookRequestSchema = z.object({
  hookId: z.string().min(1),
  workspaceId: z.string().min(1),
  tabId: z.string().min(1),
  subcommand: z.string().min(1),
  payload: z.unknown(),
  assistantText: z.string().optional(),
  /**
   * What the subagent of a hook's call (its agent_id) wrote so far, the
   * latest of it: hookclient reads it from the subagent's transcript, as the
   * hook tells no text.
   */
  agentMessages: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  /**
   * A hook of a `claude -p` run, which shows no permission dialog: its
   * PermissionRequest is answered at once rather than held for the user.
   */
  print: z.boolean().optional(),
});

export type HookRequest = z.infer<typeof HookRequestSchema>;

/**
 * A hook whose client went away before main answered it: Claude Code ends a
 * PermissionRequest hook as the user interrupts at its dialog, and a
 * `claude -p` run's watch ("print-watch") closes as the run ends.
 */
export const HookGoneSchema = z.object({
  hookId: z.string().min(1),
  workspaceId: z.string().min(1),
  tabId: z.string().min(1),
  subcommand: z.string().optional(),
  /** A print watch's payload, which names its run. */
  payload: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// HookResponse — main→agent response (written to the hook process's stdout)
// ---------------------------------------------------------------------------

/**
 * The hook response main returns to the agent.
 *
 * If stdout is present, the hook process writes that content to stdout and then exits.
 * If exitCode is not specified, the agent treats it as 0.
 */
export const HookResponseSchema = z.object({
  stdout: z.string().optional(),
  exitCode: z.number().int().optional(),
});

export type HookResponse = z.infer<typeof HookResponseSchema>;
