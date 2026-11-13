# The account key (draft, v1)

A user's devices seal what they send each other with a key only those devices hold. The relay passes the sealed messages on but cannot open them. A new device gets the key when the user signs in with Google and types the **account password**. The server keeps the key locked with that password and never sees the password or the key.

The design is open on purpose: its safety rests on the keys, not on the code being hidden.

## Keys

| Key | What it is | Where it lives |
|---|---|---|
| **Account key (AK)** | 32 random bytes, made by the first device. `kid` is its version, from 1. | Each signed-in device, in Electron `safeStorage`. Never on the server unlocked. |
| **Room key** | `HKDF-SHA256(ikm = AK, salt = empty, info = "nexus-remote/room-key/v1", 32 bytes)` | Made on each device from AK. Seals every frame's content. |
| **Password key (KEK)** | `Argon2id(password, salt, ops, mem) → 32 bytes`. libsodium's `crypto_pwhash`, `ALG_ARGON2ID13`. New bundles use ops 3 and 64 MiB. The password is NFKC-normalized first. | Made only while unlocking, then dropped. |

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

- Content: `XChaCha20-Poly1305(room key, json, nonce = 24 random bytes, aad = aadOf({from, to, seq, kid}))`.
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
4. Nothing is lost: the server keeps no history, only the sealed bundle.

**Removing a device**
- `DELETE /devices/:id` ends its sign-in and closes its socket. AK stays the same.
- For a lost or stolen device, the user should also reset, so the device's copy of AK opens nothing new.

## What the server needs to provide

- `GET /account/key-bundle` → `200 { bundle, version }` or `404`.
- `PUT /account/key-bundle` with body `{ bundle, expected }` → `200 { version }`, or `409` when `expected` is not the current version (`null` when one exists already).
- Check the bundle against `KeyBundleSchema` and cap its size (it is well under 1 KB). Store it opaque. Return it only to a signed-in device of the same user.
- Rate-limit the GET per user. Anyone who gets the bundle can guess passwords offline, so keep it only for the account's own devices.

## On the device

- AK and the session token go in Electron `safeStorage`.
- On Linux without a keyring, `safeStorage` falls back to plain text (`basic_text`). There, AK is not written to disk; the password is asked at each start.
- Crypto: `libsodium-wrappers-sumo` (wasm: `crypto_pwhash`, XChaCha20-Poly1305) and Node's `crypto.hkdfSync`. No native modules, so the three OSes and the Store build stay simple.

## Later (not v1)

- Per-device X25519 keys, signed with AK. These allow approving a new device from the phone or a QR code, and removing a device without a reset.
- Forward secrecy for sealed frames (pairwise ephemeral keys).
