import { createRequire } from "node:module";

export type Sodium = typeof import("libsodium-wrappers-sumo");

let loading: Promise<Sodium> | null = null;

export function sodium(): Promise<Sodium> {
  loading ??= (async () => {
    const lib = createRequire(import.meta.url)("libsodium-wrappers-sumo") as Sodium;
    await lib.ready;
    return lib;
  })();
  return loading;
}
