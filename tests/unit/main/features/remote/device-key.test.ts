import { describe, expect, test } from "bun:test";
import {
  KeyEnvelopeSchema,
  PAIR_KID,
  PairCodeSchema,
  pairUriOf,
  parsePairUri,
} from "../../../../../packages/remote-protocol/src";
import { passwordProofOf, toBase64Url } from "../../../../../src/main/features/remote/account-key";
import {
  certChecks,
  certOf,
  newDeviceKeyPair,
  newPairSecret,
  openEnvelope,
  openPair,
  pairKeyOf,
  sealEnvelope,
  sealPair,
} from "../../../../../src/main/features/remote/device-key";

const fill = (byte: number, length = 32) => new Uint8Array(length).fill(byte);
const counting = (from: number) => Uint8Array.from({ length: 32 }, (_, i) => from + i);

const userId = "u-test";
const ak1 = counting(1);
const ak2 = counting(33);
const V = {
  rPublic: "e06Qm75__kTEZaIgA31gjuNYl9Me-XLwf3SJLLD3PxM",
  dPublic: "D6poTtKIZ7l_Smot7l34zpdOdrcBjj8iocTPJnhXDyA",
  rCert1: "qmxegIswL1TgiZUR2YgGqdqZ8Nkqc8kKELgJvryL_ek",
  dCert1: "-HgUIp9pdMhySKA2Kf1O34whREP8ZWTDWqIsIvOcgf8",
  envelopeBox: "cXri2q_ASnh6Dx_0BwQlLdHplhLVYCAyUBOL2bgjfKxAM21gEgBh1oUzsirOn59k",
  authKey: "jJTpQk2bT0n4gIGDN1syBxyPQGKWWcXMICbGG-vMiY8",
  verifier: "7t6_BWeqf8hbHMaKHS9t6LXYHGTVIR4zzAGxU8-Yt9Q",
  pairKey: "hRhozLvHdlIJpmMklAUvZZqGFPeCjcmos3qFrRM8XCU",
  pairBox:
    "_lLu0rzSSPV5fae1azJ40q5GXrJ9yIQRHD1-jBSAeXAgesX0Ox7io0rWyvPjhq1f1ulm9ALdzHLncPCjL2vG4yc6OwTCRSF1TCu-Irlgy0RyAgjyX7Vsi6z9_L5NhYKtMbE",
};

async function devices() {
  const r = await newDeviceKeyPair(fill(0x11));
  const d = await newDeviceKeyPair(fill(0x22));
  const rKey = { publicKey: r.publicKey, kid: 1, cert: V.rCert1 };
  return { r, d, rKey };
}

describe("the test vectors", () => {
  test("key pairs, certificates, an envelope, the password's proof and a pairing frame", async () => {
    const { r, d, rKey } = await devices();
    expect(r.publicKey).toBe(V.rPublic);
    expect(d.publicKey).toBe(V.dPublic);
    expect(certOf(ak1, { userId, deviceId: "dev-r", publicKey: r.publicKey, kid: 1 })).toBe(
      V.rCert1,
    );
    expect(certOf(ak1, { userId, deviceId: "dev-d", publicKey: d.publicKey, kid: 1 })).toBe(
      V.dCert1,
    );
    const envelope = await sealEnvelope({
      userId,
      key: ak2,
      kid: 2,
      from: { id: "dev-r", secretKey: r.secretKey, key: rKey },
      to: { id: "dev-d", publicKey: d.publicKey },
      nonce: fill(0x33, 24),
    });
    expect(envelope).toEqual({
      v: 1,
      kid: 2,
      from: "dev-r",
      fromKey: rKey,
      nonce: toBase64Url(fill(0x33, 24)),
      box: V.envelopeBox,
    });
    expect(KeyEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(passwordProofOf(fill(0x55))).toEqual({ authKey: V.authKey, verifier: V.verifier });
    const pairKey = pairKeyOf(toBase64Url(fill(0x66)), userId, "dev-n");
    expect(toBase64Url(pairKey)).toBe(V.pairKey);
    const sealed = await sealPair(
      pairKey,
      { from: "dev-r", to: "dev-n", seq: 1 },
      { t: "pair-key", v: 1, kid: 2, key: toBase64Url(ak2) },
      fill(0x44, 24),
    );
    expect(sealed).toEqual({ nonce: toBase64Url(fill(0x44, 24)), box: V.pairBox });
  });
});

describe("certificates", () => {
  test("check only under the account key of their version, for their device and key", async () => {
    const { d } = await devices();
    const key = { publicKey: d.publicKey, kid: 1, cert: V.dCert1 };
    expect(certChecks(ak1, userId, "dev-d", key)).toBe(true);
    expect(certChecks(ak2, userId, "dev-d", key)).toBe(false);
    expect(certChecks(ak1, userId, "dev-r", key)).toBe(false);
    expect(certChecks(ak1, "u-other", "dev-d", key)).toBe(false);
    expect(certChecks(ak1, userId, "dev-d", { ...key, kid: 2 })).toBe(false);
    expect(certChecks(ak1, userId, "dev-d", { ...key, publicKey: V.rPublic })).toBe(false);
  });
});

describe("envelopes", () => {
  async function sealed() {
    const { r, d, rKey } = await devices();
    const envelope = await sealEnvelope({
      userId,
      key: ak2,
      kid: 2,
      from: { id: "dev-r", secretKey: r.secretKey, key: rKey },
      to: { id: "dev-d", publicKey: d.publicKey },
    });
    return { r, d, envelope };
  }

  test("open for the device they are sealed for, which holds the version before", async () => {
    const { d, envelope } = await sealed();
    const opened = await openEnvelope({
      userId,
      envelope,
      self: { id: "dev-d", secretKey: d.secretKey },
      held: { kid: 1, key: ak1 },
    });
    expect(opened).toEqual(ak2);
  });

  test("do not open for another device, another version held, or a sender the key does not vouch for", async () => {
    const { r, d, envelope } = await sealed();
    const self = { id: "dev-d", secretKey: d.secretKey };
    const held = { kid: 1, key: ak1 };
    expect(
      await openEnvelope({ userId, envelope, self: { id: "dev-r", secretKey: r.secretKey }, held }),
    ).toBeNull();
    expect(
      await openEnvelope({ userId, envelope, self: { id: "dev-x", secretKey: d.secretKey }, held }),
    ).toBeNull();
    expect(await openEnvelope({ userId, envelope, self, held: { kid: 2, key: ak2 } })).toBeNull();
    expect(await openEnvelope({ userId, envelope, self, held: { kid: 1, key: ak2 } })).toBeNull();
    const forged = await newDeviceKeyPair();
    const swapped = await sealEnvelope({
      userId,
      key: fill(0x77),
      kid: 2,
      from: {
        id: "dev-r",
        secretKey: forged.secretKey,
        key: { publicKey: forged.publicKey, kid: 1, cert: V.rCert1 },
      },
      to: { id: "dev-d", publicKey: d.publicKey },
    });
    expect(await openEnvelope({ userId, envelope: swapped, self, held })).toBeNull();
    const box = `${envelope.box.slice(0, -2)}${envelope.box.endsWith("A") ? "B" : "A"}A`;
    expect(await openEnvelope({ userId, envelope: { ...envelope, box }, self, held })).toBeNull();
  });
});

describe("pairing", () => {
  test("a code goes through its URI and back", () => {
    const code = { v: 1 as const, userId: "u 1&2", deviceId: "dev-n", secret: newPairSecret() };
    expect(PairCodeSchema.parse(code)).toEqual(code);
    expect(parsePairUri(pairUriOf(code))).toEqual(code);
    expect(parsePairUri("https://example.com/?v=1")).toBeNull();
    expect(parsePairUri(pairUriOf(code).replace("v=1", "v=2"))).toBeNull();
  });

  test("a frame opens only with its code's key and routing", async () => {
    const secret = newPairSecret();
    const key = pairKeyOf(secret, userId, "dev-n");
    const routing = { from: "dev-r", to: "dev-n", seq: 3 };
    const sealed = await sealPair(key, routing, { t: "pair-request", v: 1 });
    const frame = { ...routing, kid: PAIR_KID, ...sealed };
    expect(await openPair(key, frame)).toEqual({ t: "pair-request", v: 1 });
    expect(await openPair(pairKeyOf(newPairSecret(), userId, "dev-n"), frame)).toBeNull();
    expect(await openPair(pairKeyOf(secret, userId, "dev-m"), frame)).toBeNull();
    expect(await openPair(key, { ...frame, seq: 4 })).toBeNull();
    expect(await openPair(key, { ...frame, from: "dev-x" })).toBeNull();
    expect(await openPair(key, { ...frame, kid: 1 })).toBeNull();
  });
});
