/**
 * What a sealed message carries, which only the account's devices can open.
 *
 * Sealing (v2): XChaCha20-Poly1305 with the room key, a fresh random 24-byte
 * nonce per message, and the frame's routing as associated data (aadOf), so
 * the relay can neither read a message nor pass it off as another's. The
 * room key comes from the account key (see the account key design); every
 * device of the account holds it. The bytes sealed are an envelope's JSON
 * in UTF-8 (SealedEnvelopeSchema): the message, and the epochs below.
 *
 * The relay may keep a frame and send it again, then or days later, or to
 * another device of the account. So a device takes a message only when it
 * was sealed for it, now, and only once:
 *
 * - Each connection to the relay has an epoch, random, made as it opens.
 *   An envelope names the sender's epoch (`epoch`) and the epoch of the
 *   device it goes to (`peer`), as that device told it.
 * - A device takes a message only when `peer` is its own epoch now (one
 *   sealed before this connection opened names another), and `to` is itself.
 * - It takes a sender's messages only in the order of their seq, each once:
 *   a seq no higher than the last it took of that sender's epoch is not
 *   taken; once it took one of a sender's newer epoch, it takes none of an
 *   older one.
 *
 * A device learns another's epoch from a hello sent to it, in three steps:
 * 1. As it joins, A sends ALL_DEVICES its hello with `peer: null`. No one
 *    can tell it is not an old one sent again, so it only asks for theirs.
 * 2. B answers A alone with its hello: `peer` A's epoch, `reply: true`.
 *    A takes it, and so knows B's epoch.
 * 3. A answers B with its hello: `peer` B's epoch, `reply: false`. B takes
 *    it, and so knows A's.
 * Any hello whose `peer` is not the receiver's epoch now is answered as in
 * step 2, and is not otherwise taken. Requests, answers and notifications go
 * to one device, with its epoch; none goes to a device whose epoch is not
 * known yet. An answer goes in the epoch its request came in.
 */
import { z } from "zod";
import { Base64UrlSchema, type DeviceId, DeviceIdSchema } from "./relay.js";
import { RpcMessageSchema } from "./rpc.js";

/**
 * The version of what is sealed; a device tells it in its hello, and it is
 * in the associated data, so a device of another version opens nothing.
 */
export const PROTOCOL_VERSION = 2;

/**
 * This package's version, which a device tells in its hello (`schema`):
 * the methods a device serves are those of its version, so another can
 * leave out what an older one does not have. Kept equal to package.json's.
 */
export const SCHEMA_VERSION = "0.7.1";

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
   * allow). A request with `from` needs it and the method's own capability
   * (chat.control, terminal.control) both: an agent may do no more than
   * people may from other devices. One with `from` from a phone (ios,
   * android, web) is refused: no agent runs there.
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
   * The protocol package's version it speaks (SCHEMA_VERSION, "0.7.1");
   * absent before 0.2.0. A method it does not have is answered MethodNotFound.
   */
  schema: z.string().max(40).optional(),
  /**
   * Whether it wants the other's hello back: true as it joins (to all), and
   * as it answers a hello it could not take (see the top of this file).
   */
  reply: z.boolean(),
});
export type Hello = z.infer<typeof HelloSchema>;

/** A sealed message's content. */
export const SealedMessageSchema = z.union([HelloSchema, RpcMessageSchema]);
export type SealedMessage = z.infer<typeof SealedMessageSchema>;

/** The random bytes of a connection's epoch, which goes as unpadded base64url. */
export const EPOCH_BYTES = 16;

/** A connection's epoch (see the top of this file). */
export const EpochSchema = Base64UrlSchema.min(22).max(64);

/** What is sealed: a message, with the epochs that tell it fresh (see the top of this file). */
export const SealedEnvelopeSchema = z.object({
  /** The sender's epoch now. */
  epoch: EpochSchema,
  /** The receiver's epoch, as it told it; null only in a hello to ALL_DEVICES. */
  peer: EpochSchema.nullable(),
  message: SealedMessageSchema,
});
export type SealedEnvelope = z.infer<typeof SealedEnvelopeSchema>;
