# The account key

A user's devices seal what they send each other with a key only those devices hold. The relay passes the sealed messages on but cannot open them. A new device gets the key when the user signs in with Google and types the **account password**. The server keeps the key locked with that password and never sees the password or the key.

The design is open on purpose: its safety rests on the keys, not on the code being hidden.

## Keys

| Key | What it is | Where it lives |
|---|---|---|
| **Account key (AK)** | 32 random bytes, made by the first device. `kid` is its version, from 1. | Each signed-in device, in Electron `safeStorage`. Never on the server unlocked. |
| **Room key** | `HKDF-SHA256(ikm = AK, salt = empty, info = "nexus-remote/room-key/v1", 32 bytes)` | Made on each device from AK. Seals every frame's content. |
| **Password key (KEK)** | `Argon2id(password, salt, ops, mem) → 32 bytes`. libsodium's `crypto_pwhash`, `ALG_ARGON2ID13`. New bundles use ops 3 and 64 MiB. A device does not open a bundle above ops 4 or 256 MiB (`MAX_OPEN_KDF`), so a server cannot make unlocking stall it. The password is NFKC-normalized first. | Made only while unlocking, then dropped. |

## The locked bundle (on the server)

`KeyBundleSchema` in `src/account.ts`:

```json
{
  "v": 1,
  "kid": 1,
  "kdf": { "alg": "argon2id13", "ops": 3, "mem": 67108864, "salt": "<16 bytes>" },
  "nonce": "<24 bytes>",
  "box": "<XChaCha20-Poly1305(KEK, AK, aad = bundleAadOf(userId, kid))>"
}
```

- The associated data, `nexus-remote/account-key/v1|<userId>|<kid>`, ties the bundle to its user and key version. The server cannot pass one user's bundle off as another's, or an old key as the current one.
- A wrong password fails to open the box, because the AEAD check fails. No separate verifier is stored.
- The bundle keeps its own KDF settings, so new bundles can raise the cost without breaking old ones.

## Sealed frames

- Content: `XChaCha20-Poly1305(room key, json, nonce = 24 random bytes, aad = aadOf({from, to, seq, kid}))`. The JSON is an envelope `{epoch, peer, message}`: the sender's connection epoch, the receiver's, and the message. A device takes only frames addressed to it whose `peer` is its epoch now, each seq once and in order (see `sealed.ts`).
- `kid` in each frame names the AK version it was sealed with.
- A device that gets a frame with a `kid` it does not hold fetches the bundle again and asks for the password (see "Reset").

## Flows

**First device** (`GET /account/key-bundle` → 404)
1. The user sets the account password (typed twice) after signing in.
2. The device makes AK (`kid` 1) and a salt, then derives KEK and seals AK.
3. It sends `PUT /account/key-bundle` with `{ bundle, expected: null }`. A 409 means another device made one first: fetch it and unlock it instead.
4. It keeps AK in `safeStorage`.

**Another device** (`GET` → 200)
1. The user types the account password.
2. The device derives KEK with the bundle's `kdf` and opens the box.
3. It keeps AK in `safeStorage`. A wrong password says so and asks again. Argon2id's cost is what slows guessing.

**Changing the password** (a device holding AK, after the user types the current password again)
- Seal the same AK, same `kid`, under a new salt and the new password.
- `PUT` with `expected = <version>`.
- Other devices keep working; they hold AK already.

**Forgotten password: reset**
1. The device makes a new AK (`kid + 1`) and seals it with a new password.
2. `PUT` with `expected = <version>`.
3. Other devices find frames with the new `kid`, fetch the bundle, and ask for the new password.
4. A key is only ever replaced by a newer one. A device that holds a key does not take a bundle of an older `kid`: it keeps its key, and does not ask for a password to open the older bundle.
4. Nothing is lost: the server keeps no history, only the sealed bundle.

**Removing a device** rotates AK (see "Rotation" below). The devices that stay take the new AK without the password; the removed one does not get it.

## What the server needs to provide

- `GET /account/key-bundle` → `200 { bundle, version }` or `404`.
- `PUT /account/key-bundle` with body `{ bundle, expected, verifier }` → `200 { version }`, or `409` when `expected` is not the current version (`null` when one exists already).
- Check the bundle against `KeyBundleSchema` and cap its size (it is well under 1 KB). Store it opaque. Return it only to a signed-in device of the same user.
- Rate-limit the GET per user. Anyone who gets the bundle can guess passwords offline, so keep it only for the account's own devices.

## On the device

- AK and the session token go in Electron `safeStorage`.
- On Linux without a keyring, `safeStorage` falls back to plain text (`basic_text`). There, AK is not written to disk; the password is asked at each start.
- Crypto: `libsodium-wrappers-sumo` (wasm: `crypto_pwhash`, XChaCha20-Poly1305) and Node's `crypto.hkdfSync`. No native modules, so the three OSes and the Store build stay simple.

# Version 2: device keys, pairing, rotation, the password's proof

Schemas and strings: `src/device-keys.ts`, with `VerifierSchema`, `PendingResetSchema` and the new fields in `src/account.ts`, `AccountEventSchema` in `src/relay.ts`, and `accountKeys` in `src/info.ts`. Since protocol 0.12.0 every server and device has v2: a device no longer speaks to a server without it, and the v1-only requests (`PUT /account/key-verifier`, a bundle written without a verifier) are gone. Pairing needs nothing new of the server.

## Primitives

Every device must make the same bytes; `Test vectors` below checks it.

- Binary values travel as unpadded base64url. Strings (infos, inputs, associated data) are UTF-8.
- **X25519** (RFC 7748). Secret key: 32 random bytes. Public key: `crypto_scalarmult_base` (libsodium), `x25519.getPublicKey` (noble). Shared secret: `crypto_scalarmult` / `x25519.getSharedSecret`. An all-zero shared secret is refused.
- **HKDF-SHA256**, always with an empty salt and 32 bytes out: `HKDF(ikm, info)` below.
- **HMAC-SHA256**, compared in constant time.
- **XChaCha20-Poly1305** (IETF), a fresh random 24-byte nonce each time. The box is the ciphertext followed by the 16-byte tag (libsodium `crypto_aead_xchacha20poly1305_ietf_encrypt`, noble `xchacha20poly1305(key, nonce, aad).encrypt`).
- **SHA-256**.

## The password's proof

The server never learns the password, but it can tell whether a request comes from someone who knows it.

- `KEK` is the key the password makes with the bundle's `kdf`, as above.
- `authKey = HKDF(KEK, "nexus-remote/account-auth/v1")` (`ACCOUNT_AUTH_INFO`).
- `verifier = base64url(SHA-256(authKey))`.
- A request that needs the password carries `X-Account-Auth: base64url(authKey)` (`ACCOUNT_AUTH_HEADER`), the proof for the bundle on the server now. The server compares `SHA-256(header)` with the verifier it keeps, in constant time.
- Missing or wrong: `403 { "error": "account-auth" }` (`ACCOUNT_AUTH_ERROR`). Failures are counted per account (10 in 10 minutes); past that, the server answers `429` with `Retry-After` before it checks the proof, a right one too.
- Offline guessing gets nothing new: the verifier, like the bundle, costs one Argon2id per guess. If the server or a request is read, authKey lets one act as the owner toward the server, but it does not open the bundle (HKDF is one-way).

**Needs the proof**:
- `PUT /account/key-bundle` (a new password, or a reset when the password is known);
- `POST /account/key-rotation`;
- `DELETE /devices/:id` for another device;
- `DELETE /account`;
- `DELETE /account/key-reset` (calling off a reset that waits).

**Never needs it**: signing this device out, renaming a device, `PUT /devices/current/key`, `GET /devices/current/key-envelopes`, pairing.

**Writing the verifier**
- Each bundle a device writes, the first one too, carries the verifier of the password it is locked with (`verifier` in the body). The server keeps it with the bundle, in the same statement, and refuses a write without one.

## A forgotten password: a reset that waits

Without the password, no request can carry the proof. A stolen device does not know the password either, so a reset without it waits, and the devices that know the password can call it off.

- `POST /account/key-reset { bundle, verifier }`, without the header: a new AK (`kid + 1`) locked with a new password. The server keeps it aside and answers `202 { appliesAt, deviceId }` (`PendingResetSchema`). `409` while another waits.
- Its `bundle.kid` must be the bundle's `kid` now + 1, else `400`.
- It is put in place after `RESET_DELAY_MS` (72 hours): by the hourly job, or sooner by `GET /account/key-bundle` or a request that needs the proof once the time has come. Bundle and verifier replaced, version + 1, envelopes dropped. The room is told `{ t: "account", event: "key-reset", kid }`. Devices then find frames or a bundle of a newer `kid` and ask for the new password, as in v1.
- While it waits, `GET /account/key-bundle` says `pendingReset: { appliesAt, deviceId }`, and the room is told `{ t: "account", event: "reset-pending", appliesAt }` at once. A device shows it, with the device that asked, and a way to call it off.
- `DELETE /account/key-reset` with the proof calls it off (`{ t: "account", event: "reset-cancelled" }`). Any bundle write that goes through calls it off too (a new password, a rotation).
- The device that asked for it may be removed by any other device of the account without the proof, which calls the reset off. So an owner who forgot the password can still stop a stolen device's reset; a thief can only do the same to the owner's, which holds them up but takes nothing.
- Removed so, a device that holds AK keeps it. Before such a removal the desktop looks at the device's key: when it is of the bundle's `kid` and its certificate checks under AK, which only a device that held AK can make, it asks for the password and rotates AK instead, and removes it without only when the user chooses to keep the key. A device can put any key of its own (a device set up again keeps its id), so it can hide that it holds AK, but cannot seem to hold it when it does not.
- Removing the device that asked, in any way, calls it off.
- With the password known, a reset is a `PUT` with the proof, at once, as in v1.

## Device keys

- Each v2 device that holds AK makes one X25519 key pair and keeps the secret key beside AK (desktop: `safeStorage`; phone: Keychain, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`). It keeps the pair across rotations, and makes a new one only when it signs in anew.
- **Certificate** of a device's public key under the AK of version `kid`:
  - `certKey = HKDF(AK, "nexus-remote/device-cert-key/v1")` (`DEVICE_CERT_KEY_INFO`);
  - `cert = base64url(HMAC-SHA256(certKey, "nexus-remote/device-cert/v1|<userId>|<deviceId>|<publicKey>|<kid>"))` (`deviceCertInputOf`; `publicKey` as base64url).
  - Only a device holding that AK can make or check one; any of them may.
- `PUT /devices/current/key { publicKey, kid, cert }` (`DeviceKeySchema`) registers this device's key: when it gets AK (first device, the password, pairing, an envelope), and when it holds a newer AK whose certificate no rotation made for it. The server keeps one key a device (`device_keys`), and drops that device's envelopes of `kid` or older. A `kid` above the bundle's is `400`. A new public key replaces the old one: a device that lost its stored secret makes a new pair under the same device id.
- `GET /devices` gives each device that has one its `key: { publicKey, kid, cert }`.
- A device trusts another's public key only after it checked the certificate with the AK of that `kid`.

## Pairing

A device without AK gets it from one that holds it through a QR code, without the password. Desktops have no camera as a rule, so both ways are needed: a phone scans a new desktop's code, and a new phone scans a desktop's.

**The code** (`PairCodeSchema`, `pairUriOf`, `parsePairUri`)
- `nexuscode://pair?v=1&u=<userId>&d=<deviceId>&s=<secret>`: the account, the device showing it, and 32 random bytes.
- It holds for `PAIR_TTL_MS` (2 minutes) and is taken once. The device showing it makes a new one each time, and forgets it when it is taken or runs out.
- The secret goes from screen to camera, never through the server. So the server cannot make or open a pairing frame, and no code to compare (SAS) is needed. A photo of the code is of use only to someone signed in to the same account within those 2 minutes.

**The frames**
- `pairKey = HKDF(secret, "nexus-remote/pair-key/v1|<userId>|<deviceId of the device showing the code>")` (`pairKeyInfoOf`).
- A relay `send` frame with `kid: 0` (`PAIR_KID`), to one device (the relay refuses `kid: 0` to `ALL_DEVICES`), with the connection's next `seq` as any frame. `box` is XChaCha20-Poly1305 of a `PairMessage`'s JSON under `pairKey`, with `aadOf({ from, to, seq, kid: 0 })` (`sealed.ts`) as the associated data. A device signed in but without AK may join the room to send and take these.
- A device takes a `kid: 0` frame only while it shows a code or waits on one it scanned; the scanning one only from the device the code names. It drops a frame that does not open, without an answer. The device showing the code takes the first frame that opens and then forgets the secret.

**The messages** (`PairMessageSchema`)
- `{ t: "pair-request", v: 1 }`: the scanning device, without AK, asks the showing one for it.
- `{ t: "pair-key", v: 1, kid, key }`: AK (32 bytes) and its version.
- `{ t: "pair-done", v: 1 }`: the device took the key.
- `{ t: "pair-refused", v: 1 }`: the user turned it down, or the code ran out; or the device showing the code cannot pair with the one that scanned it, as both hold the account key or neither does (it answers a `pair-key` while holding the key, or a `pair-request` without it, and keeps showing the code).

**Shown by the device without AK** (a phone scans a new desktop's code)
1. The new device shows the code.
2. The phone scans it and checks that `userId` is its own. The user allows it (Face ID).
3. The phone sends `pair-key` to the code's device.
4. The new device opens it, keeps AK, registers its device key, and answers `pair-done`.

**Shown by a device holding AK** (a new phone scans a desktop's code)
1. The desktop shows the code.
2. The new phone scans it and sends `pair-request` to the code's device.
3. The desktop asks its user: "<device name> asks for the account key", the name as the room tells it.
4. Allowed, the desktop sends `pair-key` to the device that asked; turned down or run out, `pair-refused`.
5. The phone keeps AK, registers its device key, and answers `pair-done`.

## Rotation

Removing a device puts a new AK in place, which the devices that stay get sealed for each of them. The removed device's AK opens nothing that comes after.

**The rotating device R**, which holds AK of version `k`, its device key, and the user's password typed now:
1. Fetches the bundle and opens it with the password: the password is right, and R has the proof for the bundle now.
2. Makes AK′ (`k + 1`), and locks it with the same password, a new salt, as a new bundle with its verifier.
3. Lists the devices (`GET /devices`). For each device D that stays (not removed, not R) whose key is of version `k`, R checks its certificate with AK, then makes D an envelope and D's certificate under AK′. A device whose key is older, or that has none, gets nothing; it asks for the password, as in v1. A certificate of version `k` that does not check stops the rotation: the server, or someone, changed the key.
4. Makes its own certificate under AK′.
5. Sends `POST /account/key-rotation` with the proof:
   ```json
   {
     "bundle": "<the new bundle, kid k + 1>",
     "expected": "<the bundle's version now>",
     "verifier": "<the new password key's verifier>",
     "removeDeviceIds": ["<device id>"],
     "envelopes": [{ "deviceId": "<D>", "envelope": "<KeyEnvelope>" }],
     "certs": [{ "deviceId": "<D or R>", "publicKey": "...", "kid": "k + 1", "cert": "..." }]
   }
   ```
6. Keeps AK′ and goes on with it.

`removeDeviceIds` may be empty: a rotation alone, as after a doubt.

**The envelope** (`KeyEnvelopeSchema`) for D, made by R:
- `info = "nexus-remote/key-envelope/v1|<userId>|<R's id>|<D's id>|<k + 1>"` (`envelopeInfoOf`);
- `envKey = HKDF(X25519(R's secret key, D's public key), info)`;
- `box = XChaCha20-Poly1305(envKey, AK′'s 32 bytes, nonce, aad = info)`;
- `{ v: 1, kid: k + 1, from: R's id, fromKey: R's key under version k ({ publicKey, kid: k, cert }), nonce, box }`.

**The server**, in one D1 batch, all or nothing:
- the proof checks, else `403`; `expected` is the version now, else `409`;
- `bundle.kid` is `k + 1`, else `400`;
- R (the device of the session asking) has a key of version `k` registered, and is not in `removeDeviceIds`, else `400`; each id in `removeDeviceIds` is a device of the account, else `400`;
- each envelope has `kid` `k + 1`, `from` R, and `fromKey.publicKey` the key it keeps for R, else `400`;
- each device that stays with a key of version `k` but R has an envelope, else `400`;
- certificates are only of devices that stay and of R, each of `kid` `k + 1` and with the `publicKey` it keeps for that device, else `400`;
- removes the devices (their sign-ins, keys and envelopes with them);
- puts the bundle and the verifier, version + 1;
- keeps the envelopes, and the certificates with their new `kid`;
- calls off a reset that waits.

Then it closes the removed devices' sockets and tells the room `{ t: "account", event: "key-rotated", kid: k + 1 }`.

The server cannot open an envelope, so these checks only keep out mistakes and a device that is not R; what D checks (below) is what holds against a server.

**A device D that stays**
- On `key-rotated`, or when it finds a newer `kid` (a frame, the bundle), it fetches `GET /devices/current/key-envelopes`: its envelopes, oldest version first.
- For each whose `kid` is above its own, in order, it:
  1. checks that `fromKey.kid` is its own `kid`;
  2. checks `fromKey.cert` with its AK;
  3. opens the box with `X25519(its secret key, fromKey.publicKey)`;
  4. takes AK′.
  So a device that missed two rotations takes both, one after the other.
- When none fits, it asks for the password, as in v1.
- The server keeps a device's envelopes until the device registers a key of that version or newer, or is removed.

**What stays open**: the removed device together with the server could make a certificate under the old AK and slip an envelope of their own to a device that stays. That is still far less than v1, where the removed device alone opened everything. Per-device sessions (below) would close it.

## Who may remove a device

Removing another device, and rotating, needs the password: R types it, and the server checks the proof. A stolen device that does not know the password cannot push out the others. A device signs itself out without it.

## Test vectors

Every implementation checks these (desktop: `tests/unit/main/features/remote/device-keys.test.ts`).

Inputs (bytes in hex unless said):

- `userId` = `u-test`; device ids `dev-r` (R), `dev-d` (D), `dev-n` (a device showing a pairing code).
- AK of version 1 = `01 02 … 20` (the bytes 1 to 32); AK of version 2 = `21 22 … 40` (33 to 64).
- R's secret key = 32 × `11`; D's secret key = 32 × `22`.
- The envelope's nonce = 24 × `33`; the pairing frame's nonce = 24 × `44`.
- A KEK = 32 × `55`; a pairing code's secret = 32 × `66`.

Outputs (base64url):

| What | Value |
|---|---|
| R's public key | `e06Qm75__kTEZaIgA31gjuNYl9Me-XLwf3SJLLD3PxM` |
| D's public key | `D6poTtKIZ7l_Smot7l34zpdOdrcBjj8iocTPJnhXDyA` |
| X25519(R's secret, D's public) | `ngBAmO_AkdTsJmO06fXP1NcGRXFpC0vql6sUarnzUFY` |
| certKey of AK 1 | `OZRgyTIPftaTo2Er28SQNTQUqkqQbftbRO3m9Is9mJs` |
| R's certificate, kid 1 | `qmxegIswL1TgiZUR2YgGqdqZ8Nkqc8kKELgJvryL_ek` |
| D's certificate, kid 1 | `-HgUIp9pdMhySKA2Kf1O34whREP8ZWTDWqIsIvOcgf8` |
| envKey, R to D, kid 2 | `YIasQKVyjSgXD4qzss5GxNxRijXZ10oFR5Wckz4eRLo` |
| The envelope's box (AK 2, R to D) | `cXri2q_ASnh6Dx_0BwQlLdHplhLVYCAyUBOL2bgjfKxAM21gEgBh1oUzsirOn59k` |
| authKey of the KEK | `jJTpQk2bT0n4gIGDN1syBxyPQGKWWcXMICbGG-vMiY8` |
| verifier | `7t6_BWeqf8hbHMaKHS9t6LXYHGTVIR4zzAGxU8-Yt9Q` |
| pairKey (code shown by `dev-n`) | `hRhozLvHdlIJpmMklAUvZZqGFPeCjcmos3qFrRM8XCU` |

The pairing frame: from `dev-r` to `dev-n`, `seq` 1, `kid` 0, carrying `{"t":"pair-key","v":1,"kid":2,"key":"<AK 2, base64url>"}` (that JSON exactly, keys in that order, no spaces). Its box:

```
_lLu0rzSSPV5fae1azJ40q5GXrJ9yIQRHD1-jBSAeXAgesX0Ox7io0rWyvPjhq1f1ulm9ALdzHLncPCjL2vG4yc6OwTCRSF1TCu-Irlgy0RyAgjyX7Vsi6z9_L5NhYKtMbE
```

AK 2 as base64url is `ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A`.

## Later

- Per-device sessions: pairwise keys between devices' static keys, vouched for with AK (a Noise pattern). These give forward secrecy for sealed frames, and stop a removed device and the server together.
- Approving a new sign-in on the phone, with a push notification (needs the Apple Developer Program).
- Passkeys for signing in, and their PRF to open the bundle.
