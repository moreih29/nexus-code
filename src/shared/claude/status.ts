import { z } from "zod";
import {
  IntegerSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";

export const ClaudeStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "needsInput",
  "permissionPending",
  "error",
]);

export type ClaudeStatus = z.infer<typeof ClaudeStatusSchema>;

export const StatusEntrySchema = z.object({
  workspaceId: z.string().min(1),
  tabId: z.string().min(1),
  status: ClaudeStatusSchema,
  message: z.string().optional(),
  since: PositiveIntegerSchema,
  prompt: z.string().optional(),
});

export type StatusEntry = z.infer<typeof StatusEntrySchema>;

export const PROMPT_MAX_CHARS = 100_000;

export const HookRequestSchema = z.object({
  hookId: z.string().min(1),
  workspaceId: z.string().min(1),
  tabId: z.string().min(1),
  subcommand: z.string().min(1),
  payload: z.unknown().optional(),
  assistantText: z.string().optional(),
  agentMessages: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  print: z.boolean().optional(),
});

export type HookRequest = z.infer<typeof HookRequestSchema>;

export const HookGoneSchema = z.object({
  hookId: z.string().min(1),
  workspaceId: z.string().min(1),
  tabId: z.string().min(1),
  subcommand: z.string().optional(),
  payload: z.unknown().optional(),
});

export const HookResponseSchema = z.object({
  stdout: z.string().optional(),
  exitCode: IntegerSchema.optional(),
});

export type HookResponse = z.infer<typeof HookResponseSchema>;
