/**
 * A pairing through a QR code, as the settings show it (main's
 * remote/pairing.ts):
 * - idle: no code shown;
 * - showing: the code (`qr`, an image's data URL, of `uri`) until
 *   `expiresAt`; `giving` when this device holds the account key and hands
 *   it to the device that scans it, else it takes the key from one;
 * - asked: a device that scanned the code asks for the key: the user allows
 *   it or not, until `expiresAt`;
 * - done: the key went to `deviceName` (giving), or came here;
 * - failed: the code ran out, the user or the other device turned it down,
 *   this device is not in the room, or the server could not be asked.
 */
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
