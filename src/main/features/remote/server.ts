import { SERVER } from "../../../shared/remote/server";

export { SERVER };

export const DEV_SERVER = "http://localhost:8787";

export const PROXY = "https://api.nexuscode.gradiendo.com";

export const DIRECT = "https://cloud.nexuscode.gradiendo.com";

export const FALLBACK = "https://nexus-cloud.moreih29.workers.dev";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

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

export interface RemoteWays {
  readonly proxy: string | null;
  readonly direct: string;
  readonly fallback: string | null;
}

export function remoteWays(env: NodeJS.ProcessEnv, packaged: boolean, server: string): RemoteWays {
  const own = server === SERVER;
  const proxy = packaged ? (own ? PROXY : null) : env.NEXUS_REMOTE_PROXY?.trim() || null;
  return own
    ? { proxy, direct: DIRECT, fallback: FALLBACK }
    : { proxy, direct: server, fallback: null };
}
