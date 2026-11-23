import {
  aadOf,
  type Delivered,
  type DeviceId,
  type Outgoing,
  type SealedEnvelope,
  SealedEnvelopeSchema,
} from "../../../../packages/remote-protocol/src";
import { fromBase64Url, toBase64Url } from "./account-key";
import { sodium } from "./sodium";

export interface RoomKey {
  readonly kid: number;
  readonly key: Uint8Array;
}

export async function sealMessage(options: {
  room: RoomKey;
  from: DeviceId;
  to: string;
  seq: number;
  envelope: SealedEnvelope;
}): Promise<Outgoing> {
  const lib = await sodium();
  const { room, from, to, seq } = options;
  const nonce = lib.randombytes_buf(lib.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const box = lib.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(JSON.stringify(options.envelope)),
    aadOf({ from, to, seq, kid: room.kid }),
    null,
    nonce,
    room.key,
  );
  return { t: "send", to, seq, kid: room.kid, nonce: toBase64Url(nonce), box: toBase64Url(box) };
}

export async function openMessage(room: RoomKey, frame: Delivered): Promise<SealedEnvelope | null> {
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
    const parsed = SealedEnvelopeSchema.safeParse(JSON.parse(new TextDecoder().decode(plain)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
