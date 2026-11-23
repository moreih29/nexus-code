const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
