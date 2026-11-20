import { z } from "zod";
import type { ChatAgent } from "../sessions/task-agent";

export const INSTRUCTION_LIMIT = 5000;
export const InstructionTextSchema = z
  .string()
  .max(INSTRUCTION_LIMIT)
  .refine((text) => !text.includes("\0"));

export const AgentInstructionsSchema = z.object({
  all: InstructionTextSchema.optional(),
  claude: InstructionTextSchema.optional(),
  codex: InstructionTextSchema.optional(),
  profiles: z.record(InstructionTextSchema).optional(),
  workspaces: z.record(InstructionTextSchema).optional(),
});

export type AgentInstructions = z.infer<typeof AgentInstructionsSchema>;
export const EMPTY_INSTRUCTIONS: AgentInstructions = {};

export const InstructionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("agent"), agent: z.enum(["claude", "codex"]) }),
  z.object({ kind: z.literal("profile"), id: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("workspace"), id: z.string().min(1).max(128) }),
]);
export type InstructionScope = z.infer<typeof InstructionScopeSchema>;
export const InstructionEditSchema = z.object({
  scope: InstructionScopeSchema,
  text: InstructionTextSchema,
});
export type InstructionEdit = z.infer<typeof InstructionEditSchema>;

export const ChatInstructionHistorySchema = z.record(z.record(InstructionTextSchema));
export const ClaudeInstructionDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const ClaudeInstructionDigestsSchema = z.record(
  z.string().uuid(),
  z.record(z.string().uuid(), ClaudeInstructionDigestSchema),
);
export function chatInstructionHistoryKey(agent: ChatAgent, conversationId: string): string {
  return `${agent}:${conversationId}`;
}

export interface InstructionTarget {
  agent: ChatAgent;
  profile?: { id: string; name: string };
  workspace?: { id: string; name: string };
  session?: string;
}

export function instructionText(config: AgentInstructions, scope: InstructionScope): string {
  switch (scope.kind) {
    case "all":
      return config.all ?? "";
    case "agent":
      return config[scope.agent] ?? "";
    case "profile":
      return Object.hasOwn(config.profiles ?? {}, scope.id)
        ? (config.profiles?.[scope.id] ?? "")
        : "";
    case "workspace":
      return Object.hasOwn(config.workspaces ?? {}, scope.id)
        ? (config.workspaces?.[scope.id] ?? "")
        : "";
  }
}

export function withInstruction(
  config: AgentInstructions,
  { scope, text }: InstructionEdit,
): AgentInstructions {
  switch (scope.kind) {
    case "all":
      return { ...config, all: text.trim() ? text : undefined };
    case "agent":
      return { ...config, [scope.agent]: text.trim() ? text : undefined };
    case "profile":
    case "workspace": {
      const key = scope.kind === "profile" ? "profiles" : "workspaces";
      if (text.trim()) return { ...config, [key]: { ...config[key], [scope.id]: text } };
      const { [scope.id]: _removed, ...entries } = config[key] ?? {};
      return { ...config, [key]: entries };
    }
  }
}

export function instructionLayers(config: AgentInstructions, target: InstructionTarget) {
  const { agent, profile, workspace, session } = target;
  const scopes: { scope: InstructionScope; title: string }[] = [
    { scope: { kind: "all" }, title: "All agents" },
    { scope: { kind: "agent", agent }, title: agent === "claude" ? "Claude" : "Codex" },
  ];
  if (profile)
    scopes.push({
      scope: { kind: "profile", id: profile.id },
      title: `Profile: ${profile.name.trim() || "Default"}`,
    });
  if (workspace)
    scopes.push({
      scope: { kind: "workspace", id: workspace.id },
      title: `Workspace: ${workspace.name}`,
    });
  return [
    ...scopes.map(({ scope, title }) => ({
      scope,
      title,
      text: instructionText(config, scope).trim(),
    })),
    { scope: null, title: "This session", text: session?.trim() ?? "" },
  ];
}

export function mergeAgentInstructions(
  config: AgentInstructions,
  target: InstructionTarget,
): string {
  const sections = instructionLayers(config, target)
    .filter(({ text }) => text !== "")
    .map(({ title, text }) => `## ${title}\n${text}`);
  if (sections.length === 0) return "";
  return [
    "# Instructions set in NexusCode\nFrom general to specific. If two conflict, follow the later one.",
    ...sections,
  ].join("\n\n");
}
