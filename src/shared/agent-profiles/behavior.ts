import { z } from "zod";
import { NumberSchema } from "../../../packages/remote-protocol/src/validation";
import type { ChatAgent } from "../sessions/task-agent";

export type BehaviorValue = string | number | boolean;

export interface BehaviorField {
  readonly id: string;
  readonly agent: ChatAgent;
  readonly path: readonly string[];
  readonly kind: "bool" | "choice" | "text" | "int";
  readonly fallback?: BehaviorValue;
  readonly options?: readonly string[];
}

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

export const BEHAVIOR_FILE: Record<ChatAgent, string> = {
  claude: "settings.json",
  codex: "config.toml",
};

export const BehaviorValueSchema = z.union([z.string().max(4096), NumberSchema, z.boolean()]);

export const BehaviorFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  exists: z.boolean(),
  shared: z.boolean(),
  broken: z.string().nullable(),
  version: z.string(),
  values: z.record(z.string(), BehaviorValueSchema),
  unsupported: z.array(z.string()),
  outputStyles: z.array(z.string()),
});
export type BehaviorFile = z.infer<typeof BehaviorFileSchema>;

export const BehaviorChangesSchema = z.record(z.string(), BehaviorValueSchema.nullable());
export type BehaviorChanges = z.infer<typeof BehaviorChangesSchema>;

export const BehaviorWriteResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), version: z.string() }),
  z.object({ status: z.literal("conflict") }),
  z.object({ status: z.literal("broken"), message: z.string() }),
  z.object({ status: z.literal("unsupported"), fields: z.array(z.string()) }),
]);
export type BehaviorWriteResult = z.infer<typeof BehaviorWriteResultSchema>;
