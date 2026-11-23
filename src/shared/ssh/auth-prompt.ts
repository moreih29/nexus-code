import { z } from "zod";
import { PositiveIntegerSchema } from "../../../packages/remote-protocol/src/validation";
import { WorkspaceIdSchema } from "../types/workspace-id";

export const SshAuthPromptIdSchema = z.string().min(1);

const SshAuthPromptBaseSchema = z.object({
  promptId: SshAuthPromptIdSchema,
  workspaceId: WorkspaceIdSchema.optional(),
  host: z.string().min(1),
  port: PositiveIntegerSchema.check(z.lte(65_535)).optional(),
  username: z.string().min(1).optional(),
  retry: z.boolean().optional(),
});

export const SshAuthPromptSchema = z.discriminatedUnion("kind", [
  SshAuthPromptBaseSchema.extend({
    kind: z.literal("password"),
    prompt: z.string().min(1),
    field: z.enum(["password", "passphrase"]),
  }),
  SshAuthPromptBaseSchema.extend({
    kind: z.literal("host-key"),
    keyType: z.string().min(1).optional(),
    fingerprint: z.string().min(1),
    message: z.string().min(1).optional(),
  }),
]);
export type SshAuthPrompt = z.infer<typeof SshAuthPromptSchema>;

export const SshAuthRespondArgsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("password"),
    promptId: SshAuthPromptIdSchema,
    value: z.string(),
  }),
  z.object({
    kind: z.literal("host-key"),
    promptId: SshAuthPromptIdSchema,
    trust: z.literal("yes"),
  }),
]);
export type SshAuthResponse = z.infer<typeof SshAuthRespondArgsSchema>;

export const SshAuthCancelArgsSchema = z.object({
  promptId: SshAuthPromptIdSchema,
});
export type SshAuthCancelArgs = z.infer<typeof SshAuthCancelArgsSchema>;
