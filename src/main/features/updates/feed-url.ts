/**
 * The generic feed NEXUS_UPDATE_FEED_URL names, for trying an update without
 * publishing a release: taken only over https, or over http from this
 * machine (a feed served while testing). Another, as an environment a
 * process of the user's could set would give, is not taken, so that the
 * updater does not fetch a release from anywhere it is pointed at; the
 * release's own feed is used instead.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The feed's URL when it may be taken; null for none, or one that may not. */
export function updateFeedUrl(
  value: string | undefined,
  warn: (message: string) => void = () => {},
): string | null {
  if (value === undefined || value.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    warn(`NEXUS_UPDATE_FEED_URL is not a URL; updating from the releases`);
    return null;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    return url.href;
  }
  warn(`NEXUS_UPDATE_FEED_URL must be https, or http on this machine; updating from the releases`);
  return null;
}
