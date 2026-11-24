import { z } from "zod";
import { Base64UrlSchema, type DeviceId, DeviceIdSchema } from "./relay.js";
import { RpcMessageSchema } from "./rpc.js";
import { PositiveIntegerSchema } from "./validation.js";

export const PROTOCOL_VERSION = 2;

export const SCHEMA_VERSION = "0.36.2";

export const ROOM_KEY_INFO = "nexus-remote/room-key/v1";

export function aadOf(frame: { from: DeviceId; to: string; seq: number; kid: number }): string {
  return `nexus-remote/v${PROTOCOL_VERSION}|${frame.from}|${frame.to}|${frame.seq}|${frame.kid}`;
}

export const CAPABILITIES = [
  "sessions",
  "sessions.reorder",
  "sessions.markSeen",
  "chat.read",
  "chat.control",
  "terminal.read",
  "terminal.control",
  "files",
  "files.write",
  "git",
  "notes",
  "workspace.create",
  "agents",
  "agents.cli",
  "settings.instructions",
  "profiles.usage",
  "push",
  "system.stats",
  "chat.peek",
  "profiles.usage.people",
] as const;
export const CapabilitySchema = z.string();
export type Capability = (typeof CAPABILITIES)[number];

export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol: PositiveIntegerSchema,
  device: z.object({
    id: DeviceIdSchema,
    name: z.string(),
    platform: z.string(),
  }),
  app: z.object({
    name: z.string(),
    version: z.string(),
    theme: z.string().optional(),
  }),
  serves: z.array(CapabilitySchema),
  schema: z.string().max(40).optional(),
  reply: z.boolean(),
});
export type Hello = z.infer<typeof HelloSchema>;

export const SealedMessageSchema = z.union([HelloSchema, RpcMessageSchema]);
export type SealedMessage = z.infer<typeof SealedMessageSchema>;

export const EPOCH_BYTES = 16;

export const EpochSchema = Base64UrlSchema.min(22).max(64);

export const SenderConnectionSchema = z.object({
  boot: EpochSchema,
  n: PositiveIntegerSchema.check(z.lte(Number.MAX_SAFE_INTEGER)),
});
export type SenderConnection = z.infer<typeof SenderConnectionSchema>;

export function olderConnection(
  conn: SenderConnection | undefined,
  heard: SenderConnection | undefined,
): boolean {
  return conn !== undefined && heard !== undefined && conn.boot === heard.boot && conn.n <= heard.n;
}

export const SealedEnvelopeSchema = z.object({
  epoch: EpochSchema,
  conn: SenderConnectionSchema.optional(),
  peer: EpochSchema.nullable(),
  message: SealedMessageSchema,
});
export type SealedEnvelope = z.infer<typeof SealedEnvelopeSchema>;
