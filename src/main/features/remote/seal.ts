/**
 * Sealing what one device sends another (packages/remote-protocol's
 * ./sealed.ts): XChaCha20-Poly1305 with the room key, a fresh nonce, and
 * the frame's routing as associated data, so the relay can neither read a
 * message nor pass it off as another's.
 */
import {
  aadOf,
  type Delivered,
  type DeviceId,
  type Outgoing,
  type SealedMessage,
  SealedMessageSchema,
} from "../../../../packages/remote-protocol/src";
import { fromBase64Url, toBase64Url } from "./account-key";
import { sodium } from "./sodium";

/** The room key and the account key's version it comes from. */
export interface RoomKey {
  readonly kid: number;
  readonly key: Uint8Array;
}

export async function sealMessage(options: {
  room: RoomKey;
  from: DeviceId;
  to: string;
  seq: number;
  message: SealedMessage;
}): Promise<Outgoing> {
  const lib = await sodium();
  const { room, from, to, seq } = options;
  const nonce = lib.randombytes_buf(lib.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const box = lib.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(JSON.stringify(options.message)),
    aadOf({ from, to, seq, kid: room.kid }),
    null,
    nonce,
    room.key,
  );
  return { t: "send", to, seq, kid: room.kid, nonce: toBase64Url(nonce), box: toBase64Url(box) };
}

/**
 * Opens a delivered message: null when it does not open (sealed with
 * another key, or changed on the way) or is not a message of the protocol.
 */
export async function openMessage(room: RoomKey, frame: Delivered): Promise<SealedMessage | null> {
  if (frame.kid !== room.kid) return null;
  const lib = await sodium();
  try {
    const plain = lib.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(frame.box),
      aadOf(frame),
      fromBase64Url(frame.nonce),
      room.key,
    );
    const parsed = SealedMessageSchema.safeParse(JSON.parse(new TextDecoder().decode(plain)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
