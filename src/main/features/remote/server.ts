/** Which NexusCode server the app signs in to, and the addresses it reaches it at. */

import { SERVER } from "../../../shared/remote/server";

export { SERVER };

/** The server in development (wrangler dev). */
export const DEV_SERVER = "http://localhost:8787";

/**
 * The proxy the released app's requests to SERVER go through first: the
 * server's own addresses are slow or blocked on some networks. It carries
 * them to SERVER, which stays the server signed in to.
 */
export const PROXY = "https://api.nexuscode.gradiendo.com";

/**
 * SERVER's own address: where its requests go when the proxy cannot be
 * reached, and where its sign-in opens in the browser.
 */
export const DIRECT = "https://cloud.nexuscode.gradiendo.com";

/**
 * The name SERVER had before it had its own domain, which answers still:
 * where its requests go when neither address above can be reached, as both
 * are of one domain.
 */
export const FALLBACK = "https://nexus-cloud.moreih29.workers.dev";

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

/** The addresses requests to a server go to, in the order they are tried. */
export interface RemoteWays {
  /** Where requests go first; none to go to `direct` first. */
  readonly proxy: string | null;
  /** The server's own address, where its sign-in opens in the browser too. */
  readonly direct: string;
  /** Where requests go when neither above can be reached; none to stop at `direct`. */
  readonly fallback: string | null;
}

/**
 * Where requests to `server` go. SERVER is the name the app signs in to and
 * keeps, not an address: its requests go through PROXY in the released app,
 * then to DIRECT, then to FALLBACK, and its sign-in opens at DIRECT. A
 * server NEXUS_REMOTE_SERVER names is reached at its own address alone.
 * Development goes through NEXUS_REMOTE_PROXY first when set, to try one;
 * the released app does not take it, as it does not take any server for the
 * sign-in.
 */
export function remoteWays(env: NodeJS.ProcessEnv, packaged: boolean, server: string): RemoteWays {
  const own = server === SERVER;
  const proxy = packaged ? (own ? PROXY : null) : env.NEXUS_REMOTE_PROXY?.trim() || null;
  return own
    ? { proxy, direct: DIRECT, fallback: FALLBACK }
    : { proxy, direct: server, fallback: null };
}
