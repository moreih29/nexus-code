/**
 * What a sealed message carries, which only the account's devices can open.
 *
 * Sealing (v1): XChaCha20-Poly1305 with the room key, a fresh random 24-byte
 * nonce per message, and the frame's routing as associated data (aadOf), so
 * the relay can neither read a message nor pass it off as another's. The
 * room key comes from the account key (see the account key design); every
 * device of the account holds it. The bytes sealed are the message's JSON
 * in UTF-8.
 */
import { z } from "zod";
import { type DeviceId, DeviceIdSchema } from "./relay.js";
import { RpcMessageSchema } from "./rpc.js";

/** The version of what is sealed; a device tells it in its hello. */
export const PROTOCOL_VERSION = 1;

/**
 * This package's version, which a device tells in its hello (`schema`):
 * the methods a device serves are those of its version, so another can
 * leave out what an older one does not have. Kept equal to package.json's.
 */
export const SCHEMA_VERSION = "0.6.0";

/** The HKDF info that makes the room key from the account key. */
export const ROOM_KEY_INFO = "nexus-remote/room-key/v1";

/**
 * The associated data a message is sealed with: its routing, as the relay
 * delivers it. A message the relay sends on to another device, or with
 * another seq, does not open.
 */
export function aadOf(frame: { from: DeviceId; to: string; seq: number; kid: number }): string {
  return `nexus-remote/v${PROTOCOL_VERSION}|${frame.from}|${frame.to}|${frame.seq}|${frame.kid}`;
}

/**
 * What a device can do for another, as it says in its hello. The other
 * side asks only for what is listed; a newer device lists more.
 */
export const CAPABILITIES = [
  /** sessions.list and sessions.watch, profiles.list. */
  "sessions",
  /** Reading a chat: chat.read and chat.watch, its settings, commands, panel, images, tool calls; history.list. */
  "chat.read",
  /**
   * Acting in a chat: sending, answering, stopping, settings, commands, opening, resuming,
   * renaming, closing; and answering the consent prompts waiting on the user.
   */
  "chat.control",
  /** terminal.read and terminal.watch: a terminal's screen, as text. */
  "terminal.read",
  /** Typing into a terminal, opening, renaming and closing one. */
  "terminal.control",
  /** files.list, files.read, files.find and files.search, in a workspace's folders. */
  "files",
  /** git.status, git.diff, git.log and git.show of a workspace. */
  "git",
  /** notes.list and notes.attach: a workspace's notes, and photos put into one. */
  "notes",
  /**
   * Takes agents' requests (`from`: nexus on another device) to act in its
   * chats and terminals, as the user set it (Settings › Remote: ask or
   * allow). Without it, a request with `from` is refused, whatever
   * chat.control and terminal.control say: those are for people.
   */
  "agents",
] as const;
export const CapabilitySchema = z.string();
export type Capability = (typeof CAPABILITIES)[number];

/**
 * A device introduces itself: to all the room as it joins, and to one that
 * just joined. What it serves of its own sessions is `serves`; a device
 * that only watches others (a phone) serves nothing.
 */
export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number().int().positive(),
  device: z.object({
    id: DeviceIdSchema,
    name: z.string(),
    platform: z.string(),
  }),
  app: z.object({
    name: z.string(),
    version: z.string(),
    /** The app's color theme now, by its id ("github-dark"): a phone may follow it. */
    theme: z.string().optional(),
  }),
  serves: z.array(CapabilitySchema),
  /**
   * The protocol package's version it speaks (SCHEMA_VERSION, "0.6.0");
   * absent before 0.2.0. A method it does not have is answered MethodNotFound.
   */
  schema: z.string().max(40).optional(),
  /** Whether it wants the hello of devices already there: true as it joins. */
  reply: z.boolean(),
});
export type Hello = z.infer<typeof HelloSchema>;

/** A sealed message's content. */
export const SealedMessageSchema = z.union([HelloSchema, RpcMessageSchema]);
export type SealedMessage = z.infer<typeof SealedMessageSchema>;
