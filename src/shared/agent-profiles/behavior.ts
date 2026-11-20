/**
 * The behavior settings of a profile that Settings edits in the agent's own
 * config file: settings.json for Claude, config.toml for Codex. Each field
 * is a key of that file; a value equal to the key's fallback is not written
 * (the key goes), so the file never holds a default.
 */

import { z } from "zod";
import type { ChatAgent } from "../sessions/task-agent";

export type BehaviorValue = string | number | boolean;

export interface BehaviorField {
  /** The field's id, also its name under profiles.behavior.fields. */
  readonly id: string;
  readonly agent: ChatAgent;
  /** The key in the file; a table's keys come before it. */
  readonly path: readonly string[];
  readonly kind: "bool" | "choice" | "text" | "int";
  /** What the program does with the key unset: writing it deletes the key. */
  readonly fallback?: BehaviorValue;
  /** The values a "choice" takes, for the version of the program checked. */
  readonly options?: readonly string[];
}

/** The model aliases Claude Code takes (claude 2.1.x); a full model id is kept as it is. */
export const CLAUDE_MODEL_ALIASES = [
  "sonnet",
  "opus",
  "haiku",
  "fable",
  "opusplan",
  "sonnet[1m]",
  "opus[1m]",
  "fable[1m]",
  "best",
] as const;

/** The output styles Claude Code comes with; a profile's own are in its output-styles folder. */
export const CLAUDE_OUTPUT_STYLES = [
  "default",
  "Proactive",
  "Concise",
  "Explanatory",
  "Learning",
] as const;

export const CLAUDE_PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
] as const;

// biome-ignore format: a table, one field to a line
export const BEHAVIOR_FIELDS: readonly BehaviorField[] = [
  { id: "model", agent: "claude", path: ["model"], kind: "choice", options: CLAUDE_MODEL_ALIASES },
  { id: "thinking", agent: "claude", path: ["alwaysThinkingEnabled"], kind: "bool", fallback: true },
  { id: "permissionMode", agent: "claude", path: ["permissions", "defaultMode"], kind: "choice", options: CLAUDE_PERMISSION_MODES, fallback: "default" },
  { id: "language", agent: "claude", path: ["language"], kind: "text" },
  { id: "outputStyle", agent: "claude", path: ["outputStyle"], kind: "choice", options: CLAUDE_OUTPUT_STYLES, fallback: "default" },
  { id: "autoCompact", agent: "claude", path: ["autoCompactEnabled"], kind: "bool", fallback: true },
  { id: "autoMemory", agent: "claude", path: ["autoMemoryEnabled"], kind: "bool", fallback: true },
  // Hidden by an empty commit and pr text under `attribution` (see behavior.ts in main).
  { id: "attribution", agent: "claude", path: ["attribution"], kind: "bool", fallback: true },
  { id: "sandbox", agent: "claude", path: ["sandbox", "enabled"], kind: "bool", fallback: false },

  { id: "approvalPolicy", agent: "codex", path: ["approval_policy"], kind: "choice", options: ["untrusted", "on-request", "never"] },
  { id: "sandboxMode", agent: "codex", path: ["sandbox_mode"], kind: "choice", options: ["read-only", "workspace-write", "danger-full-access"] },
  { id: "sandboxNetwork", agent: "codex", path: ["sandbox_workspace_write", "network_access"], kind: "bool", fallback: false },
  { id: "webSearch", agent: "codex", path: ["web_search"], kind: "choice", options: ["disabled", "cached", "indexed", "live"] },
  { id: "reasoningSummary", agent: "codex", path: ["model_reasoning_summary"], kind: "choice", options: ["auto", "concise", "detailed", "none"] },
  { id: "autoCompactLimit", agent: "codex", path: ["model_auto_compact_token_limit"], kind: "int" },
  { id: "verbosity", agent: "codex", path: ["model_verbosity"], kind: "choice", options: ["low", "medium", "high"] },
  { id: "codexModel", agent: "codex", path: ["model"], kind: "text" },
];

export function behaviorField(agent: ChatAgent, id: string): BehaviorField | undefined {
  return BEHAVIOR_FIELDS.find((f) => f.agent === agent && f.id === id);
}

/** The file each agent's behavior is in, in the profile's folder. */
export const BEHAVIOR_FILE: Record<ChatAgent, string> = {
  claude: "settings.json",
  codex: "config.toml",
};

export const BehaviorValueSchema = z.union([z.string().max(4096), z.number(), z.boolean()]);

/** What a profile's file holds now. */
export const BehaviorFileSchema = z.object({
  /** The file's absolute path on this machine. */
  path: z.string(),
  name: z.string(),
  exists: z.boolean(),
  /** The file is the default folder's own (a link to it): writing it changes the default profile too. */
  shared: z.boolean(),
  /** Why the file cannot be read (not valid JSON or TOML); null when it can. */
  broken: z.string().nullable(),
  /** A fingerprint of its content, to tell an outside change; "missing" with no file. */
  version: z.string(),
  /** Each field's value in the file; a field not in it is absent. */
  values: z.record(z.string(), BehaviorValueSchema),
  /** The fields whose key has a shape this editor cannot change (a table, an array). */
  unsupported: z.array(z.string()),
});
export type BehaviorFile = z.infer<typeof BehaviorFileSchema>;

/** A change per field; null puts the field back to its default (the key goes). */
export const BehaviorChangesSchema = z.record(z.string(), BehaviorValueSchema.nullable());
export type BehaviorChanges = z.infer<typeof BehaviorChangesSchema>;

export const BehaviorWriteResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), version: z.string() }),
  /** The file changed since it was read: nothing is written. */
  z.object({ status: z.literal("conflict") }),
  z.object({ status: z.literal("broken"), message: z.string() }),
  /** A key of the file has a shape this editor cannot change: edit the file. */
  z.object({ status: z.literal("unsupported"), fields: z.array(z.string()) }),
]);
export type BehaviorWriteResult = z.infer<typeof BehaviorWriteResultSchema>;
