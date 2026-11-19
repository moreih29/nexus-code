/**
 * How requests reach the NexusCode server: through a proxy when there is
 * one (workers.dev is slow or blocked on some networks), else straight.
 * The server stays the one signed in to; the proxy only carries requests
 * to it. When the proxy cannot be reached, requests go straight for
 * PROXY_DOWN_MS, then try it again.
 */

import { createLogger } from "../../../shared/log/main";

const log = createLogger("remote-route");

/** How long requests go straight to the server once the proxy could not be reached. */
export const PROXY_DOWN_MS = 5 * 60_000;

/** How often a socket that went straight looks whether it can go back through the proxy. */
export const RETURN_CHECK_MS = 60_000;

/** How long the proxy has to answer, asked whether a socket may go back through it. */
const RETURN_PROBE_TIMEOUT_MS = 5_000;

export class ServerRoute {
  private downUntil = 0;

  constructor(
    /** The server signed in to, and gone to straight. */
    readonly server: string,
    /** The proxy requests go through; none to go straight. */
    readonly proxy: string | null = null,
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
      log.warn("The proxy could not be reached, using the direct server route.");
    }
    this.downUntil = this.now() + PROXY_DOWN_MS;
    return true;
  }
}

/**
 * Checks whether a socket that went straight can return through the proxy.
 * The result belongs to the open socket and route that initiated the probe.
 */
export function returnToProxy(options: {
  route: ServerRoute;
  via: () => { readonly origin: string } | null;
  reconnect: () => void;
  fetch?: typeof fetch;
}): { check(): Promise<void>; stop(): void } {
  const { route } = options;
  const fetchFn = options.fetch ?? fetch;
  const lifetime = new AbortController();
  let asking = false;

  /** Probes the proxy while the current socket is open to the server directly. */
  async function check(): Promise<void> {
    const proxy = route.proxy;
    if (lifetime.signal.aborted || asking || proxy === null || route.base() !== proxy) return;
    const connection = options.via();
    if (
      connection === null ||
      sameHost(connection.origin, proxy) ||
      !sameHost(connection.origin, route.server)
    ) {
      return;
    }

    asking = true;
    let reachable: boolean;
    try {
      const res = await fetchFn(new URL("/info", proxy), {
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(RETURN_PROBE_TIMEOUT_MS)]),
      });
      reachable = res.ok;
    } catch {
      reachable = false;
    } finally {
      asking = false;
    }

    if (lifetime.signal.aborted || options.via() !== connection || route.base() !== proxy) return;
    if (reachable) options.reconnect();
    else route.unreachable(proxy);
  }

  const timer = setInterval(() => void check(), RETURN_CHECK_MS);
  timer.unref?.();
  return {
    check,
    stop() {
      clearInterval(timer);
      lifetime.abort();
    },
  };
}

/** Whether two addresses are of one host, a websocket's (wss:) and its https: alike. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}
