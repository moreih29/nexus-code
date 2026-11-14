/**
 * libsodium (WebAssembly), loaded once: Argon2id and XChaCha20-Poly1305,
 * which Electron's Node (built on BoringSSL) does not have.
 */
import { createRequire } from "node:module";

export type Sodium = typeof import("libsodium-wrappers-sumo");

let loading: Promise<Sodium> | null = null;

export function sodium(): Promise<Sodium> {
  loading ??= (async () => {
    // Its CommonJS build: the ES module build imports a file the package does not ship.
    const lib = createRequire(import.meta.url)("libsodium-wrappers-sumo") as Sodium;
    await lib.ready;
    return lib;
  })();
  return loading;
}
