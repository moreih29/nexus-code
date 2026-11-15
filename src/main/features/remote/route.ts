/**
 * How requests reach the NexusCode server: through a proxy when there is
 * one (workers.dev is slow or blocked on some networks), else straight.
 * The server stays the one signed in to; the proxy only carries requests
 * to it. When the proxy cannot be reached, requests go straight for
 * PROXY_DOWN_MS, then try it again.
 */

/** How long requests go straight to the server once the proxy could not be reached. */
export const PROXY_DOWN_MS = 5 * 60_000;

export class ServerRoute {
  private downUntil = 0;

  constructor(
    /** The server signed in to, and gone to straight. */
    readonly server: string,
    private readonly proxy: string | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Where requests go now: the proxy, unless there is none or it failed lately. */
  base(): string {
    return this.proxy !== null && this.now() >= this.downUntil ? this.proxy : this.server;
  }

  /** `path` at `base` (where requests go now by default), as a websocket's address when `socket`. */
  url(path: string, options: { socket?: boolean; base?: string } = {}): URL {
    const url = new URL(path, options.base ?? this.base());
    if (options.socket) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  }

  /**
   * A request to `address` did not reach it. When that was the proxy's,
   * requests go straight for a while; true then, so the caller may try
   * again straight.
   */
  unreachable(address: string): boolean {
    if (this.proxy === null || !sameHost(address, this.proxy)) return false;
    if (this.now() >= this.downUntil) {
      console.warn("[remote] the proxy could not be reached; going to the server straight");
    }
    this.downUntil = this.now() + PROXY_DOWN_MS;
    return true;
  }
}

/** Whether two addresses are of one host, a websocket's (wss:) and its https: alike. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}
