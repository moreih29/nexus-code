/** Which NexusCode server the app signs in to. */

/** The NexusCode server the released app signs in to. */
export const SERVER = "https://nexus-cloud.moreih29.workers.dev";

/** The server in development (wrangler dev). */
export const DEV_SERVER = "http://localhost:8787";

/** NEXUS_REMOTE_SERVER when set; else the released app's server, or the local one in development. */
export function remoteServer(env: NodeJS.ProcessEnv, packaged: boolean): string {
  return env.NEXUS_REMOTE_SERVER?.trim() || (packaged ? SERVER : DEV_SERVER);
}
