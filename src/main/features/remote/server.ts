/** Which NexusCode server the app signs in to. */

/** The NexusCode server the released app signs in to. */
export const SERVER = "https://nexus-cloud.moreih29.workers.dev";

/** The server in development (wrangler dev). */
export const DEV_SERVER = "http://localhost:8787";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * NEXUS_REMOTE_SERVER when set; else the released app's server, or the
 * local one in development. A packaged app takes the variable only over
 * https, or over http on this machine (a server run while testing): the
 * server signs the user in and hands out their key's bundle, so an
 * environment a process of the user's could set does not send the sign-in
 * to anywhere it names. Another is told to `warn` and left for SERVER.
 */
export function remoteServer(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
  warn: (message: string) => void = () => {},
): string {
  const given = env.NEXUS_REMOTE_SERVER?.trim();
  if (!given) return packaged ? SERVER : DEV_SERVER;
  if (!packaged || takenWhenPackaged(given)) return given;
  warn("NEXUS_REMOTE_SERVER must be https, or http on this machine; signing in to NexusCode's own");
  return SERVER;
}

function takenWhenPackaged(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  } catch {
    return false;
  }
}
