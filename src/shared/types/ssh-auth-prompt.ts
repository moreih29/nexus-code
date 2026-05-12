import { z } from "zod";

export const SshAuthPromptIdSchema = z.string().min(1);

const SshAuthPromptBaseSchema = z.object({
  promptId: SshAuthPromptIdSchema,
  workspaceId: z.string().uuid().optional(),
  host: z.string().min(1),
  port: z.number().int().positive().max(65_535).optional(),
  username: z.string().min(1).optional(),
});

/**
 * Main-to-renderer SSH authentication prompt payload. `promptId` is the
 * domain correlation key for renderer responses, independent from IPC
 * request/stream ids because the authentication flow is initiated by SSH.
 */
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

/** Renderer-to-main response for an active SSH authentication prompt. */
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
