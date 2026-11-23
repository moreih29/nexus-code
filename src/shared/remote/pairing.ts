import { z } from "zod";
import { NumberSchema } from "../../../packages/remote-protocol/src/validation";

export const PairingStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }),
  z.object({
    status: z.literal("showing"),
    uri: z.string(),
    qr: z.string(),
    expiresAt: NumberSchema,
    giving: z.boolean(),
  }),
  z.object({
    status: z.literal("asked"),
    deviceId: z.string(),
    deviceName: z.string().optional(),
    expiresAt: NumberSchema,
  }),
  z.object({ status: z.literal("done"), deviceName: z.string().optional() }),
  z.object({
    status: z.literal("failed"),
    reason: z.enum(["expired", "refused", "offline", "unavailable"]),
  }),
]);
export type PairingState = z.infer<typeof PairingStateSchema>;
